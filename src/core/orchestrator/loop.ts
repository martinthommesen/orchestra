import { Cause, Duration, Effect, Either, Fiber, Queue, type Scope, Stream } from "effect";
import type { AgentEvent, Usage } from "../domain/agent-event";
import { type Issue, type IssueStateRef, normalizeState } from "../domain/issue";
import { RunAttempt } from "../domain/run-attempt";
import type { WorkflowDefinition } from "../domain/workflow";
import type { Workspace } from "../domain/workspace";
import type { AgentRunParams } from "../ports/agent-runner";
import { AgentRunner } from "../ports/agent-runner";
import { Clock } from "../ports/clock";
import { IssueTracker } from "../ports/issue-tracker";
import { WorkspaceManager } from "../ports/workspace-manager";
import { renderPrompt } from "../workflow/render";
import { computeWorkspacePath } from "../workspace/safety";
import { CONTINUATION_DELAY_MS, failureBackoffMs } from "./backoff";
import { concurrencyContext, planDispatch } from "./concurrency";
import type { Msg, WorkerOutcome } from "./messages";
import { Observer, type RetryKind } from "./observer";
import { preflight } from "./preflight";
import {
  planReconciliation,
  type ReconcileAction,
  type RetryingView,
  type RunningView,
} from "./reconcile";
import { selectCandidates, selectionContext } from "./selection";
import {
  addUsage,
  clearRetry,
  clearRunning,
  markCompleted,
  OrchestratorStore,
  release,
  setRetry,
  setRunning,
} from "./state";

/**
 * Task 6 — the poll-loop assembly. This is the **single state-owning fiber**: a mailbox
 * (`Queue<Msg>`) is drained by exactly one fiber that applies every mutation serially.
 * Worker fibers and retry timers never touch state — they only post messages. This is
 * what makes the whole loop deterministic under `TestClock`.
 *
 * Per tick (SPEC §8.1): reconcile (stall + tracker refresh) → preflight validate →
 * fetch candidates → sort (§8.2) → dispatch within concurrency slots (§8.3) → notify
 * observers. A per-tick validation/fetch failure skips dispatch but still reconciles.
 *
 * Runtime-only worker bookkeeping (fibers, live-session id, turn/attempt counters,
 * last-event time for stall detection) lives in `registry` — a plain `Map` touched
 * ONLY by the owner fiber, so it needs no synchronization.
 */

/** Continuation-turn guidance prompt (turns >1). Full template prompt is turn 1 only. */
export const continuationGuidance = (issue: Issue, turn: number): string =>
  `Continue working on issue ${issue.identifier} (turn ${turn}). ` +
  "Review what you have already done in this workspace and proceed with the next " +
  "concrete step toward the workflow's handoff state. If the work is complete, " +
  "finalize it and hand off.";

type LoopFiber = Fiber.RuntimeFiber<void, never>;

interface IssueRuntime {
  issue: Issue;
  workspace: Workspace | null;
  workerFiber: LoopFiber | null;
  timerFiber: LoopFiber | null;
  sessionId: string | null;
  /** Clean turns completed so far (gates continuation against `max_turns`). */
  turnCount: number;
  /** Failure retries so far (drives exponential backoff). */
  failureAttempts: number;
  /** Monotonic ms of the last agent event (or dispatch time) — stall detection. */
  lastEventAt: number;
  pendingKind: RetryKind | null;
  pendingAttempt: number;
}

/** How a dispatch should run: a fresh full-prompt session, or a resumed continuation. */
type DispatchMode =
  | { readonly kind: "fresh"; readonly attempt: number | null }
  | { readonly kind: "continuation"; readonly turn: number };

/** Best-effort label for an unknown error/tagged-error (never includes secrets). */
const errLabel = (e: unknown): string => {
  if (typeof e === "object" && e !== null) {
    const tag = (e as { _tag?: unknown })._tag;
    const msg = (e as { message?: unknown }).message;
    if (typeof tag === "string" && typeof msg === "string") {
      return `${tag}: ${msg}`;
    }
    if (typeof tag === "string") {
      return tag;
    }
    if (typeof msg === "string") {
      return msg;
    }
  }
  return String(e);
};

const causeToMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.failureOption(cause);
  return failure._tag === "Some" ? errLabel(failure.value) : Cause.pretty(cause);
};

export type OrchestratorDeps =
  | OrchestratorStore
  | IssueTracker
  | AgentRunner
  | WorkspaceManager
  | Clock
  | Observer;

/**
 * Build and run the orchestrator loop for a loaded workflow. The returned effect never
 * completes normally (it owns the poll loop); interrupting its fiber tears down the
 * internal scope and with it the scheduler, every worker, and every retry timer.
 */
export const runOrchestrator = (
  def: WorkflowDefinition,
): Effect.Effect<void, never, OrchestratorDeps> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* OrchestratorStore;
      const tracker = yield* IssueTracker;
      const runner = yield* AgentRunner;
      const wsm = yield* WorkspaceManager;
      const clock = yield* Clock;
      const observer = yield* Observer;

      const config = def.config;
      const template = def.prompt_template;
      const activeStates = new Set(config.tracker.active_states.map(normalizeState));
      const terminalStates = new Set(config.tracker.terminal_states.map(normalizeState));

      const mailbox = yield* Queue.unbounded<Msg>();
      const registry = new Map<string, IssueRuntime>();

      const freshRuntime = (issue: Issue): IssueRuntime => ({
        issue,
        workspace: null,
        workerFiber: null,
        timerFiber: null,
        sessionId: null,
        turnCount: 0,
        failureAttempts: 0,
        lastEventAt: 0,
        pendingKind: null,
        pendingAttempt: 0,
      });

      // ───────────────────────────── Worker fiber ─────────────────────────────

      const workerEffect = (
        issue: Issue,
        opts: {
          readonly turn: number;
          readonly attempt: number | null;
          readonly resume: { readonly sessionId: string } | null;
        },
      ): Effect.Effect<void, never> => {
        const body = Effect.gen(function* () {
          const ws = yield* wsm.ensureWorkspace(issue);
          yield* wsm.runHook("before_run", ws);
          const prompt =
            opts.turn === 1
              ? yield* renderPrompt(template, { issue, attempt: opts.attempt })
              : continuationGuidance(issue, opts.turn);
          const params: AgentRunParams = {
            issue,
            workspacePath: ws.path,
            prompt,
            attempt: opts.attempt,
            ...(opts.resume ? { resume: opts.resume } : {}),
          };
          yield* Stream.runForEach(runner.run(params), (event) =>
            Queue.offer(mailbox, { _tag: "AgentEvent", issueId: issue.id, event }),
          );
          yield* wsm.runHook("after_run", ws);
        });
        return body.pipe(
          Effect.matchCauseEffect({
            onSuccess: () =>
              Queue.offer(mailbox, {
                _tag: "WorkerDone",
                issueId: issue.id,
                outcome: { _tag: "Completed" },
              }).pipe(Effect.asVoid),
            onFailure: (cause: Cause.Cause<unknown>) =>
              // Interrupted = killed by the owner; the owner already updated state and
              // dropped the registry entry, so do not post a spurious WorkerDone.
              Cause.isInterrupted(cause)
                ? Effect.void
                : Queue.offer(mailbox, {
                    _tag: "WorkerDone",
                    issueId: issue.id,
                    outcome: { _tag: "Failed", message: causeToMessage(cause) },
                  }).pipe(Effect.asVoid),
          }),
        );
      };

      // ───────────────────────────── Dispatch ─────────────────────────────

      const dispatch = (
        issue: Issue,
        mode: DispatchMode,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const root = config.workspace.root;
          if (root === undefined) {
            yield* observer.emit({ _tag: "PreflightFailed", reason: "workspace.root unresolved" });
            yield* store.update((s) => release(s, issue.id));
            registry.delete(issue.id);
            return;
          }
          const wsResult = yield* Effect.either(computeWorkspacePath(root, issue.identifier));
          if (Either.isLeft(wsResult)) {
            yield* observer.emit({
              _tag: "WorkerFailed",
              issueId: issue.id,
              identifier: issue.identifier,
              message: errLabel(wsResult.left),
            });
            yield* store.update((s) => release(s, issue.id));
            registry.delete(issue.id);
            return;
          }
          const ws = wsResult.right;

          const isCont = mode.kind === "continuation";
          const turn = isCont ? mode.turn : 1;
          const attemptNum: number | null = isCont ? mode.turn : mode.attempt;

          const rec = registry.get(issue.id) ?? freshRuntime(issue);
          rec.issue = issue;
          rec.workspace = ws;
          if (!isCont) {
            rec.sessionId = null;
            rec.turnCount = 0;
          }
          const mono = yield* clock.monotonicMillis;
          rec.lastEventAt = mono;
          registry.set(issue.id, rec);

          const wall = yield* clock.currentTimeMillis;
          yield* store.update((s) =>
            clearRetry(
              setRunning(
                s,
                RunAttempt.make({
                  issue_id: issue.id,
                  issue_identifier: issue.identifier,
                  attempt: attemptNum,
                  workspace_path: ws.path,
                  started_at: new Date(wall),
                  status: "PreparingWorkspace",
                }),
              ),
              issue.id,
            ),
          );

          const resume = isCont && rec.sessionId !== null ? { sessionId: rec.sessionId } : null;
          const fiber = yield* Effect.forkScoped(
            workerEffect(issue, { turn, attempt: attemptNum, resume }),
          );
          rec.workerFiber = fiber;

          yield* observer.emit({
            _tag: "Dispatched",
            issueId: issue.id,
            identifier: issue.identifier,
            attempt: attemptNum,
            turn,
            resumed: resume !== null,
          });
        });

      // ───────────────────────────── Retry scheduling ─────────────────────────────

      const scheduleRetry = (
        rec: IssueRuntime,
        kind: RetryKind,
        attempt: number,
        error: string | null,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          if (rec.timerFiber !== null) {
            yield* Fiber.interrupt(rec.timerFiber);
            rec.timerFiber = null;
          }
          const delay =
            kind === "continuation"
              ? CONTINUATION_DELAY_MS
              : failureBackoffMs(attempt, config.agent.max_retry_backoff_ms);
          const mono = yield* clock.monotonicMillis;
          rec.pendingKind = kind;
          rec.pendingAttempt = attempt;

          yield* store.update((s) =>
            setRetry(clearRunning(s, rec.issue.id), {
              issue_id: rec.issue.id,
              identifier: rec.issue.identifier,
              attempt,
              due_at_ms: mono + delay,
              error,
            }),
          );

          const issueId = rec.issue.id;
          const timer = yield* Effect.forkScoped(
            Effect.sleep(Duration.millis(delay)).pipe(
              Effect.zipRight(Queue.offer(mailbox, { _tag: "RetryDue", issueId })),
              Effect.asVoid,
            ),
          );
          rec.timerFiber = timer;

          yield* observer.emit({
            _tag: "RetryScheduled",
            issueId,
            identifier: rec.issue.identifier,
            kind,
            attempt,
            delayMs: delay,
          });
        });

      // ───────────────────────────── Reconciliation ─────────────────────────────

      /**
       * An issue occupies a concurrency slot while it is either running (has a worker
       * fiber) OR waiting out a retry/continuation backoff (has a pending timer fiber).
       * Counting the retry/continuation window is what keeps the cap honest across the
       * re-dispatch: a tick must not fill the slot a backing-off issue will reclaim,
       * otherwise the timer's re-dispatch over-admits past the cap (bug #17).
       */
      const occupiesSlot = (rec: IssueRuntime): boolean =>
        rec.workerFiber !== null || rec.timerFiber !== null;

      const runningByState = (): ReadonlyMap<string, number> => {
        const byState = new Map<string, number>();
        for (const rec of registry.values()) {
          if (!occupiesSlot(rec)) {
            continue;
          }
          const st = normalizeState(rec.issue.state);
          byState.set(st, (byState.get(st) ?? 0) + 1);
        }
        return byState;
      };
      const runningTotal = (): number => {
        let n = 0;
        for (const rec of registry.values()) {
          if (occupiesSlot(rec)) {
            n += 1;
          }
        }
        return n;
      };

      const cleanupWorkspace = (issueId: string, identifier: string, ws: Workspace) =>
        Effect.forkScoped(
          wsm.removeWorkspace(ws).pipe(
            Effect.matchCauseEffect({
              onSuccess: () => observer.emit({ _tag: "WorkspaceCleaned", issueId, identifier }),
              onFailure: (cause) =>
                Effect.logWarning(`workspace cleanup failed: ${causeToMessage(cause)}`).pipe(
                  Effect.annotateLogs({ issue_id: issueId, issue_identifier: identifier }),
                ),
            }),
          ),
        );

      const applyReconcileAction = (
        action: ReconcileAction,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const rec = registry.get(action.issueId);
          if (rec === undefined) {
            return;
          }
          switch (action._tag) {
            case "StallKill": {
              const fiber = rec.workerFiber;
              rec.workerFiber = null;
              if (fiber !== null) {
                yield* Fiber.interrupt(fiber);
              }
              yield* observer.emit({
                _tag: "WorkerKilled",
                issueId: action.issueId,
                reason: "stall",
              });
              rec.failureAttempts += 1;
              yield* scheduleRetry(rec, "failure", rec.failureAttempts, "stalled");
              break;
            }
            case "TerminalKill": {
              const fiber = rec.workerFiber;
              const timer = rec.timerFiber;
              const ws = rec.workspace;
              registry.delete(action.issueId);
              if (fiber !== null) {
                yield* Fiber.interrupt(fiber);
              }
              if (timer !== null) {
                yield* Fiber.interrupt(timer);
              }
              yield* store.update((s) => markCompleted(s, action.issueId));
              yield* observer.emit({
                _tag: "WorkerKilled",
                issueId: action.issueId,
                reason: "terminal",
              });
              if (ws !== null) {
                yield* cleanupWorkspace(action.issueId, rec.issue.identifier, ws);
              }
              break;
            }
            case "NeitherKill": {
              const fiber = rec.workerFiber;
              const timer = rec.timerFiber;
              registry.delete(action.issueId);
              if (fiber !== null) {
                yield* Fiber.interrupt(fiber);
              }
              if (timer !== null) {
                yield* Fiber.interrupt(timer);
              }
              yield* store.update((s) => release(s, action.issueId));
              yield* observer.emit({
                _tag: "WorkerKilled",
                issueId: action.issueId,
                reason: "neither",
              });
              break;
            }
            case "UpdateActive": {
              // Issue still active — keep the worker; snapshot refresh is a no-op in v1
              // beyond what AgentEvent bookkeeping already records.
              break;
            }
          }
        });

      const reconcile: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
        const state = yield* store.get;
        const runningIds = Object.keys(state.running);
        // Retrying/continuing issues hold a slot but have no worker; reconcile must still
        // see them so an issue that goes terminal mid-backoff is cleaned up instead of
        // firing one more wasted dispatch (bug #17).
        const retryingIds = Object.keys(state.retry_attempts).filter(
          (id) => state.running[id] === undefined,
        );
        const refreshIds = Array.from(new Set([...runningIds, ...retryingIds]));
        if (refreshIds.length === 0) {
          yield* observer.emit({ _tag: "Reconciled", actions: [] });
          return;
        }
        const refreshedResult = yield* Effect.either(tracker.fetchIssueStatesByIds(refreshIds));
        let refreshed: ReadonlyMap<string, IssueStateRef> | null;
        if (Either.isLeft(refreshedResult)) {
          refreshed = null;
          yield* observer.emit({
            _tag: "TrackerError",
            op: "fetchIssueStatesByIds",
            message: errLabel(refreshedResult.left),
          });
        } else {
          refreshed = new Map(refreshedResult.right.map((r) => [r.id, r] as const));
        }
        const now = yield* clock.monotonicMillis;
        const running: ReadonlyArray<RunningView> = runningIds.map((id) => ({
          issueId: id,
          lastEventAt: registry.get(id)?.lastEventAt ?? now,
        }));
        const retrying: ReadonlyArray<RetryingView> = retryingIds.map((id) => ({ issueId: id }));
        const actions = planReconciliation({
          running,
          retrying,
          refreshed,
          now,
          stallTimeoutMs: config.copilot.stall_timeout_ms,
          activeStates,
          terminalStates,
        });
        for (const action of actions) {
          yield* applyReconcileAction(action);
        }
        yield* observer.emit({ _tag: "Reconciled", actions });
      });

      // ───────────────────────────── Tick ─────────────────────────────

      const handleTick: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
        yield* observer.emit({ _tag: "TickStart" });
        yield* reconcile;

        const preflightResult = yield* Effect.either(preflight(config));
        if (Either.isLeft(preflightResult)) {
          yield* observer.emit({ _tag: "PreflightFailed", reason: errLabel(preflightResult.left) });
          yield* observer.emit({ _tag: "TickEnd", dispatched: [], dispatchSkipped: true });
          return;
        }

        const candidatesResult = yield* Effect.either(tracker.fetchCandidateIssues());
        if (Either.isLeft(candidatesResult)) {
          yield* observer.emit({
            _tag: "TrackerError",
            op: "fetchCandidateIssues",
            message: errLabel(candidatesResult.left),
          });
          yield* observer.emit({ _tag: "TickEnd", dispatched: [], dispatchSkipped: true });
          return;
        }

        const state = yield* store.get;
        const selCtx = selectionContext({
          activeStates: config.tracker.active_states,
          terminalStates: config.tracker.terminal_states,
          requiredLabels: config.tracker.required_labels,
          claimed: state.claimed,
        });
        const sorted = selectCandidates(candidatesResult.right, selCtx);
        const conCtx = concurrencyContext({
          globalLimit: state.max_concurrent_agents,
          perStateLimits: config.agent.max_concurrent_agents_by_state,
          runningTotal: runningTotal(),
          runningByState: runningByState(),
        });
        const toDispatch = planDispatch(sorted, conCtx);
        for (const issue of toDispatch) {
          yield* dispatch(issue, { kind: "fresh", attempt: null });
        }
        yield* observer.emit({
          _tag: "TickEnd",
          dispatched: toDispatch.map((i) => i.id),
          dispatchSkipped: false,
        });
      });

      // ───────────────────────────── Message handlers ─────────────────────────────

      const handleAgentEvent = (issueId: string, event: AgentEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const rec = registry.get(issueId);
          if (rec === undefined) {
            return;
          }
          rec.lastEventAt = yield* clock.monotonicMillis;
          if (event._tag === "SessionStarted") {
            rec.sessionId = event.session_id;
          }
          const usage: Usage | undefined = event.usage;
          if (usage !== undefined) {
            yield* store.update((s) => addUsage(s, usage));
          }
          yield* store.update((s) => {
            const ra = s.running[issueId];
            return ra === undefined ? s : setRunning(s, { ...ra, status: "StreamingTurn" });
          });
          yield* observer.emit({
            _tag: "AgentEvent",
            issueId,
            identifier: rec.issue.identifier,
            sessionId: rec.sessionId,
            eventTag: event._tag,
          });
        });

      const handleWorkerDone = (
        issueId: string,
        outcome: WorkerOutcome,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const rec = registry.get(issueId);
          if (rec === undefined) {
            return;
          }
          rec.workerFiber = null;
          if (outcome._tag === "Completed") {
            rec.turnCount += 1;
            if (rec.turnCount < config.agent.max_turns) {
              yield* scheduleRetry(rec, "continuation", rec.turnCount + 1, null);
            } else {
              yield* store.update((s) => markCompleted(s, issueId));
              registry.delete(issueId);
              yield* observer.emit({
                _tag: "WorkerCompleted",
                issueId,
                identifier: rec.issue.identifier,
              });
            }
          } else {
            rec.failureAttempts += 1;
            yield* observer.emit({
              _tag: "WorkerFailed",
              issueId,
              identifier: rec.issue.identifier,
              message: outcome.message,
            });
            yield* scheduleRetry(rec, "failure", rec.failureAttempts, outcome.message);
          }
        });

      const handleRetryDue = (issueId: string): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const rec = registry.get(issueId);
          if (rec === undefined) {
            return;
          }
          rec.timerFiber = null;
          yield* store.update((s) => clearRetry(s, issueId));
          yield* observer.emit({ _tag: "RetryFired", issueId, identifier: rec.issue.identifier });
          if (rec.pendingKind === "continuation") {
            yield* dispatch(rec.issue, { kind: "continuation", turn: rec.pendingAttempt });
          } else {
            yield* dispatch(rec.issue, { kind: "fresh", attempt: rec.failureAttempts });
          }
        });

      const handle = (msg: Msg): Effect.Effect<void, never, Scope.Scope> => {
        switch (msg._tag) {
          case "Tick":
            return handleTick;
          case "AgentEvent":
            return handleAgentEvent(msg.issueId, msg.event);
          case "WorkerDone":
            return handleWorkerDone(msg.issueId, msg.outcome);
          case "RetryDue":
            return handleRetryDue(msg.issueId);
        }
      };

      // ───────────────────────────── Startup + run ─────────────────────────────

      const startupCleanup = Effect.gen(function* () {
        const fetched = yield* Effect.either(
          tracker.fetchIssuesByStates(config.tracker.terminal_states),
        );
        if (Either.isLeft(fetched)) {
          yield* observer.emit({
            _tag: "TrackerError",
            op: "fetchIssuesByStates",
            message: errLabel(fetched.left),
          });
          return;
        }
        const identifiers = fetched.right.map((i) => i.identifier);
        const removed = yield* Effect.either(wsm.cleanupTerminalWorkspaces(identifiers));
        if (Either.isLeft(removed)) {
          yield* observer.emit({
            _tag: "TrackerError",
            op: "cleanupTerminalWorkspaces",
            message: errLabel(removed.left),
          });
          return;
        }
        yield* observer.emit({ _tag: "StartupCleanup", removed: removed.right });
      });

      const initial = yield* store.get;
      yield* observer.emit({
        _tag: "Started",
        pollIntervalMs: initial.poll_interval_ms,
        maxConcurrent: initial.max_concurrent_agents,
      });
      yield* startupCleanup;
      yield* Queue.offer(mailbox, { _tag: "Tick" });

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const s = yield* store.get;
            yield* Effect.sleep(Duration.millis(s.poll_interval_ms));
            yield* Queue.offer(mailbox, { _tag: "Tick" });
          }),
        ),
      );

      yield* Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(handle)));
    }),
  );
