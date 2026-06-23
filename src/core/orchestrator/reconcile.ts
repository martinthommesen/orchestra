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
  return actions;
};
