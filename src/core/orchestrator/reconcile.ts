import { type IssueStateRef, normalizeState } from "../domain/issue";

/**
 * Reconciliation decision logic (SPEC §8.5), as a pure function over a snapshot so it
 * is fully unit-testable. Each tick the loop builds the inputs (running workers' last
 * event times + a refreshed tracker view) and applies the returned actions (interrupt
 * fibers, clean workspaces, schedule retries). Two independent concerns:
 *
 *   - **(A) Stall detection** — a worker that has emitted no event for longer than
 *     `stall_timeout_ms` is killed and retried. Disabled when `stall_timeout_ms <= 0`.
 *     Independent of the tracker, so it runs even if the tracker refresh failed.
 *   - **(B) Tracker state refresh** — terminal → kill + clean workspace; active →
 *     update snapshot; neither (other state or no longer returned) → kill, no cleanup.
 *     A refresh *failure* (input `refreshed === null`) keeps all workers untouched.
 */

/** A running worker as reconciliation sees it. */
export interface RunningView {
  readonly issueId: string;
  /** Monotonic-clock ms of the last agent event (or dispatch time if none yet). */
  readonly lastEventAt: number;
}

/** A retrying/continuing issue as reconciliation sees it (no worker, no stall clock). */
export interface RetryingView {
  readonly issueId: string;
}

/** A claimed issue parked after exhausting failure retries. */
export interface AbandonedView {
  readonly issueId: string;
}

export type ReconcileAction =
  /** Stall: kill the worker and schedule a failure-backoff retry (SPEC §8.5 A). */
  | { readonly _tag: "StallKill"; readonly issueId: string }
  /** Issue reached a terminal tracker state: kill, clean workspace, mark completed. */
  | { readonly _tag: "TerminalKill"; readonly issueId: string }
  /** Issue still active: refresh the in-memory snapshot, keep the worker running. */
  | { readonly _tag: "UpdateActive"; readonly issueId: string; readonly ref: IssueStateRef }
  /** Issue neither terminal nor active (or vanished): kill without cleaning workspace. */
  | { readonly _tag: "NeitherKill"; readonly issueId: string };

export interface ReconcileInput {
  readonly running: ReadonlyArray<RunningView>;
  /**
   * Issues currently in a retry/continuation backoff window (claimed, not running). They
   * occupy a slot but have no worker and no stall clock — so they are reconciled by
   * tracker state only: terminal → kill + clean, neither/vanished → release, active →
   * leave the pending retry alone. Without this, a `retry_attempts` issue that goes
   * terminal mid-backoff would still fire one more (wasted) dispatch (bug #17).
   */
  readonly retrying?: ReadonlyArray<RetryingView>;
  /**
   * Issues parked after exhausting failure retries. They remain claimed while active so the
   * dispatcher cannot pick them again every poll, but they must still reconcile terminal or
   * vanished tracker state.
   */
  readonly abandoned?: ReadonlyArray<AbandonedView>;
  /** Refreshed tracker states keyed by issue id; `null` means the refresh failed. */
  readonly refreshed: ReadonlyMap<string, IssueStateRef> | null;
  /** Current monotonic-clock ms. */
  readonly now: number;
  readonly stallTimeoutMs: number;
  readonly activeStates: ReadonlySet<string>;
  readonly terminalStates: ReadonlySet<string>;
}

/** Decide the reconciliation actions for one tick (SPEC §8.5). */
export const planReconciliation = (input: ReconcileInput): ReadonlyArray<ReconcileAction> => {
  const actions: ReconcileAction[] = [];
  for (const worker of input.running) {
    // (A) Stall detection takes precedence and is tracker-independent.
    if (input.stallTimeoutMs > 0 && input.now - worker.lastEventAt > input.stallTimeoutMs) {
      actions.push({ _tag: "StallKill", issueId: worker.issueId });
      continue;
    }
    // (B) Tracker refresh failed → keep this worker untouched.
    if (input.refreshed === null) {
      continue;
    }
    const ref = input.refreshed.get(worker.issueId);
    if (ref === undefined) {
      actions.push({ _tag: "NeitherKill", issueId: worker.issueId });
      continue;
    }
    const state = normalizeState(ref.state);
    if (input.terminalStates.has(state)) {
      actions.push({ _tag: "TerminalKill", issueId: worker.issueId });
    } else if (input.activeStates.has(state)) {
      actions.push({ _tag: "UpdateActive", issueId: worker.issueId, ref });
    } else {
      actions.push({ _tag: "NeitherKill", issueId: worker.issueId });
    }
  }
  // (C) Retrying issues: tracker-state only (no stall, no UpdateActive — the pending
  // retry is left untouched while the issue stays active). A refresh failure leaves them
  // alone so the backoff can still fire.
  if (input.refreshed !== null) {
    for (const retrying of input.retrying ?? []) {
      const ref = input.refreshed.get(retrying.issueId);
      if (ref === undefined) {
        actions.push({ _tag: "NeitherKill", issueId: retrying.issueId });
        continue;
      }
      const state = normalizeState(ref.state);
      if (input.terminalStates.has(state)) {
        actions.push({ _tag: "TerminalKill", issueId: retrying.issueId });
      } else if (!input.activeStates.has(state)) {
        actions.push({ _tag: "NeitherKill", issueId: retrying.issueId });
      }
      // active → no action: let the scheduled retry/continuation fire as planned.
    }
    for (const abandoned of input.abandoned ?? []) {
      const ref = input.refreshed.get(abandoned.issueId);
      if (ref === undefined) {
        actions.push({ _tag: "NeitherKill", issueId: abandoned.issueId });
        continue;
      }
      const state = normalizeState(ref.state);
      if (input.terminalStates.has(state)) {
        actions.push({ _tag: "TerminalKill", issueId: abandoned.issueId });
      } else if (!input.activeStates.has(state)) {
        actions.push({ _tag: "NeitherKill", issueId: abandoned.issueId });
      }
      // active → no action: keep the exhausted issue parked/claimed.
    }
  }
  return actions;
};
