import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Queue,
  type Scope,
  Stream,
} from "effect";
import type { AgentEvent, Usage } from "../domain/agent-event";
import { Issue, type IssueStateRef, normalizeState } from "../domain/issue";
import type { OrchestratorState } from "../domain/orchestrator-state";
import type { RetryEntry } from "../domain/retry-entry";
import { RunAttempt } from "../domain/run-attempt";
import type { WorkflowDefinition } from "../domain/workflow";
import type { Workspace } from "../domain/workspace";
import { ControlStatus } from "../observability/control-status";
import { LiveBudget } from "../observability/live-budget";
import { RecentCompletions } from "../observability/recent-completions";
import { RestoreStatus } from "../observability/restore-status";
import type { AgentRunParams } from "../ports/agent-runner";
import { AgentRunner } from "../ports/agent-runner";
import { Clock } from "../ports/clock";
import { IssueTracker } from "../ports/issue-tracker";
import { WorkspaceManager } from "../ports/workspace-manager";
import { renderPrompt } from "../workflow/render";
import { computeWorkspacePath, sanitizeWorkspaceKey } from "../workspace/safety";
import { CONTINUATION_DELAY_MS, failureBackoffMs } from "./backoff";
import { type BudgetStatus, evaluateBudget } from "./budget";
import { type Command, CommandBus, type CommandResult, type ControlState } from "./command";
import { concurrencyContext, planDispatch } from "./concurrency";
import type { Msg, WorkerOutcome } from "./messages";
import { Observer, type RetryKind } from "./observer";
import { preflight } from "./preflight";
import {
  type AbandonedView,
  classifyTrackerOnly,
  planReconciliation,
  type ReconcileAction,
  type RetryingView,
  type RunningView,
} from "./reconcile";
import { selectCandidates, selectionContext } from "./selection";
import {
  abandon,
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
  | Observer
  | RecentCompletions
  | RestoreStatus
  | ControlStatus
  | LiveBudget
  | CommandBus;

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
      const completions = yield* RecentCompletions;
      const restoreStatus = yield* RestoreStatus;
      const controlStatus = yield* ControlStatus;
      const liveBudget = yield* LiveBudget;
      const commandBus = yield* CommandBus;

      const config = def.config;
      // Hot-reloadable knobs (Sprint 6 / #66, DD-4) are read off `liveConfig`, which a
      // `ReloadConfig` command swaps wholesale from a re-parsed WORKFLOW.md. Only whitelisted
      // keys can change (the cockpit edits nothing else), so the non-whitelisted fields are
      // identical across the swap; reads happen at point-of-use each tick, so the new values
      // apply on the NEXT tick/completion/backoff without disturbing any in-flight work.
      let liveConfig = config;
      const template = def.prompt_template;
      const activeStates = new Set(config.tracker.active_states.map(normalizeState));
      const terminalStates = new Set(config.tracker.terminal_states.map(normalizeState));

      const mailbox = yield* Queue.unbounded<Msg>();
      const registry = new Map<string, IssueRuntime>();

      // Budget guardrail (#53) — runtime-only latch tracking whether the dispatch gate
      // is currently paused, so the BudgetExceeded observation fires ONCE per transition
      // (entering paused / resuming) rather than every tick. It is pure display/transition
      // bookkeeping and never gates worker, retry, or reconcile paths.
      let budgetPaused = false;

      // Operator-pause latch (#64, DD-3) — a runtime-only gate, distinct from the budget
      // gate. When set (via a PauseDispatch command) the tick plans ZERO new dispatches,
      // exactly like the budget gate, and touches nothing else (in-flight workers, retries,
      // reconcile are unaffected). It is owner-fiber-local (only this fiber reads/writes it),
      // mirrored into the ControlStatus service so the snapshot server can project it. It is
      // never persisted: a restart resumes dispatch.
      let operatorPaused = false;

      /** The live dispatch-gate state for a control CommandResult / the snapshot block. */
      const controlState = (): ControlState => ({
        dispatchPaused: operatorPaused || budgetPaused,
        pausedBy: operatorPaused ? "operator" : budgetPaused ? "budget" : null,
      });

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
                  // Continuity persisted for restart resume (#41): clean turns done so far
                  // and failure-backoff count. An orphaned `running` issue rebuilds its
                  // registry `turnCount`/`failureAttempts` from these on the next boot.
                  turn: rec.turnCount,
                  failure_attempts: rec.failureAttempts,
                  // Session id for opt-in resume across restart (#42). Null on a fresh
                  // dispatch (reset above); set once `SessionStarted` arrives or carried
                  // in from a restored continuation when resume is enabled.
                  session_id: rec.sessionId,
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
              : failureBackoffMs(attempt, liveConfig.agent.max_retry_backoff_ms);
          const mono = yield* clock.monotonicMillis;
          // Capture wall-clock at schedule time (#37) so observers can show an honest
          // wall-clock due time (scheduled_at + delay_ms); the monotonic due_at_ms is
          // never turned into a countdown.
          const wall = yield* clock.currentTimeMillis;
          rec.pendingKind = kind;
          rec.pendingAttempt = attempt;

          yield* store.update((s) =>
            setRetry(clearRunning(s, rec.issue.id), {
              issue_id: rec.issue.id,
              identifier: rec.issue.identifier,
              attempt,
              due_at_ms: mono + delay,
              scheduled_at: new Date(wall),
              delay_ms: delay,
              // Persist the retry shape (#41) so a restart can re-dispatch the correct
              // path (continuation vs failure) via `handleRetryDue` after re-arming.
              kind,
              // Carry the agent session id onto the retry (#42) so a restart can optionally
              // resume the thread when re-dispatching a continuation (gated on restore by
              // `persistence.resume_sessions`). Truthful/additive; `null` when unknown.
              session_id: rec.sessionId,
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

      const abandonFailure = (
        rec: IssueRuntime,
        reason: string,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const issueId = rec.issue.id;
          if (rec.timerFiber !== null) {
            yield* Fiber.interrupt(rec.timerFiber);
            rec.timerFiber = null;
          }
          rec.pendingKind = null;
          rec.pendingAttempt = 0;
          const ws = rec.workspace;
          if (ws !== null) {
            rec.workspace = null;
            // Await the removal BEFORE persisting the parked state. The issue stays claimed
            // and active, and `AbandonedIssue` carries no workspace_path, so a forked `rm`
            // that loses the race against the next checkpoint would leak the dir forever
            // (startup cleanup only reaps terminal issues). Best-effort: a failure logs and
            // continues — we still park the issue.
            yield* cleanupWorkspaceEffect(issueId, rec.issue.identifier, ws);
          }
          const wall = yield* clock.currentTimeMillis;
          yield* store.update((s) =>
            abandon(s, {
              issue_id: issueId,
              identifier: rec.issue.identifier,
              attempts: rec.failureAttempts,
              abandoned_at: new Date(wall),
              reason,
            }),
          );
          yield* observer.emit({
            _tag: "WorkerAbandoned",
            issueId,
            identifier: rec.issue.identifier,
            attempts: rec.failureAttempts,
            maxRetries: liveConfig.agent.max_failure_retries,
            reason,
          });
        });

      const retryFailureOrAbandon = (
        rec: IssueRuntime,
        reason: string,
      ): Effect.Effect<void, never, Scope.Scope> =>
        rec.failureAttempts > liveConfig.agent.max_failure_retries
          ? abandonFailure(rec, reason)
          : scheduleRetry(rec, "failure", rec.failureAttempts, reason);

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

      const cleanupWorkspaceEffect = (issueId: string, identifier: string, ws: Workspace) =>
        wsm.removeWorkspace(ws).pipe(
          Effect.matchCauseEffect({
            onSuccess: () => observer.emit({ _tag: "WorkspaceCleaned", issueId, identifier }),
            onFailure: (cause) =>
              Effect.logWarning(`workspace cleanup failed: ${causeToMessage(cause)}`).pipe(
                Effect.annotateLogs({ issue_id: issueId, issue_identifier: identifier }),
              ),
          }),
        );

      /** Fork the removal — terminal/neither reconcile reaps a completed issue, so the tick
       *  need not block on the `rm`; the issue is already off every map. */
      const cleanupWorkspace = (issueId: string, identifier: string, ws: Workspace) =>
        Effect.forkScoped(cleanupWorkspaceEffect(issueId, identifier, ws));

      /** Drop a claimed registry entry, interrupt its fibers, then apply the durable
       *  transition — the canonical kill-and-forget dance, extracted from the three
       *  sites (TerminalKill / NeitherKill / CancelSession) that share it verbatim.
       *  Ordering is load-bearing: delete FIRST (suppresses spurious WorkerDone and
       *  stale RetryDue), then interrupt worker, then timer, then persist the state
       *  change.  All caller-specific follow-up (emits, completions, Deferred) stays
       *  in the caller. */
      const killAndForget = (
        issueId: string,
        rec: IssueRuntime,
        transition: (s: OrchestratorState) => OrchestratorState,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const fiber = rec.workerFiber;
          const timer = rec.timerFiber;
          registry.delete(issueId); // FIRST — before any interrupt
          if (fiber !== null) yield* Fiber.interrupt(fiber);
          if (timer !== null) yield* Fiber.interrupt(timer);
          yield* store.update(transition);
        });

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
              yield* retryFailureOrAbandon(rec, "stalled");
              break;
            }
            case "TerminalKill": {
              const ws = rec.workspace;
              yield* killAndForget(action.issueId, rec, (s) => markCompleted(s, action.issueId));
              yield* completions.record({
                issue_id: action.issueId,
                identifier: rec.issue.identifier,
                outcome: "killed",
              });
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
              yield* killAndForget(action.issueId, rec, (s) => release(s, action.issueId));
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
        const abandonedIds = Object.keys(state.abandoned).filter(
          (id) => state.running[id] === undefined && state.retry_attempts[id] === undefined,
        );
        const refreshIds = Array.from(new Set([...runningIds, ...retryingIds, ...abandonedIds]));
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
        const abandonedIssues: ReadonlyArray<AbandonedView> = abandonedIds.map((id) => ({
          issueId: id,
        }));
        const actions = planReconciliation({
          running,
          retrying,
          abandoned: abandonedIssues,
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

        // ── Budget guardrail (#53): a PURE, additive pre-planDispatch gate ──
        // Compute current spend vs. the configured ceiling. When spend ≥ ceiling we plan
        // ZERO new dispatches this tick — and ONLY that. Reconciliation already ran above,
        // retries fire on their own timers via the separate `handleRetryDue` path, and
        // in-flight worker fibers keep streaming and reconcile exactly as today. The guard
        // touches neither the concurrency math nor the retry/reconcile paths. The
        // BudgetExceeded observation is emitted once per transition (latched on
        // `budgetPaused`), never every tick.
        const budget: BudgetStatus = evaluateBudget(liveConfig.budget, state.agent_totals);
        if (budget.paused !== budgetPaused) {
          budgetPaused = budget.paused;
          yield* observer.emit({
            _tag: "BudgetExceeded",
            paused: budget.paused,
            limitTokens: budget.limitTokens ?? 0,
            spentTokens: budget.spentTokens,
          });
        }

        const selCtx = selectionContext({
          activeStates: config.tracker.active_states,
          terminalStates: config.tracker.terminal_states,
          requiredLabels: config.tracker.required_labels,
          claimed: state.claimed,
        });
        const sorted = selectCandidates(candidatesResult.right, selCtx);
        const conCtx = concurrencyContext({
          globalLimit: state.max_concurrent_agents,
          perStateLimits: liveConfig.agent.max_concurrent_agents_by_state,
          runningTotal: runningTotal(),
          runningByState: runningByState(),
        });
        const toDispatch = budget.paused || operatorPaused ? [] : planDispatch(sorted, conCtx);
        for (const issue of toDispatch) {
          yield* dispatch(issue, { kind: "fresh", attempt: null });
        }
        yield* observer.emit({
          _tag: "TickEnd",
          dispatched: toDispatch.map((i) => i.id),
          dispatchSkipped: budget.paused || operatorPaused,
        });
      }).pipe(Effect.withSpan("orchestrator.tick"));

      // ───────────────────────────── Message handlers ─────────────────────────────

      const handleAgentEvent = (issueId: string, event: AgentEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const rec = registry.get(issueId);
          if (rec === undefined) {
            return;
          }
          rec.lastEventAt = yield* clock.monotonicMillis;
          const usage: Usage | undefined = event.usage;
          if (usage !== undefined) {
            yield* store.update((s) => addUsage(s, usage));
          }
          if (event._tag === "AgentProgress") return; // liveness only — stall clock + usage refreshed above
          if (event._tag === "SessionStarted") {
            rec.sessionId = event.session_id;
          }
          yield* store.update((s) => {
            const ra = s.running[issueId];
            // Fold the (now-known) session id into the persisted running attempt (#42) so
            // an orphaned `running` issue can optionally resume its agent thread on the
            // next boot. Idempotent: `rec.sessionId` only ever moves null → set per turn.
            return ra === undefined
              ? s
              : setRunning(s, { ...ra, status: "StreamingTurn", session_id: rec.sessionId });
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
            if (rec.turnCount < liveConfig.agent.max_turns) {
              yield* scheduleRetry(rec, "continuation", rec.turnCount + 1, null);
            } else {
              yield* store.update((s) => markCompleted(s, issueId));
              yield* completions.record({
                issue_id: issueId,
                identifier: rec.issue.identifier,
                outcome: "completed",
              });
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
            yield* retryFailureOrAbandon(rec, outcome.message);
          }
        });

      const handleRetryDue = (issueId: string): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const rec = registry.get(issueId);
          // Idempotent against a stale/duplicate RetryDue (exactly-once guard). When an
          // operator `RetryNow` fires the backoff ahead of a still-queued `RetryDue`, the
          // timer has already offered its `RetryDue` before being interrupted; that message
          // is now stale. A running issue is never legitimately in backoff (`scheduleRetry`
          // calls `clearRunning`, and the only path that re-dispatches a retrying issue is
          // this one), so an already-running worker means this re-fire must be dropped —
          // otherwise it would dispatch a second worker and orphan the first.
          if (rec === undefined || rec.workerFiber !== null) {
            return;
          }
          rec.timerFiber = null;
          // Consume the pending shape: clear it so a subsequent stale re-fire can't reuse it.
          const kind = rec.pendingKind;
          const attempt = rec.pendingAttempt;
          rec.pendingKind = null;
          rec.pendingAttempt = 0;
          // #81: a handoff can land in the 1s continuation window (CONTINUATION_DELAY_MS), which is far
          // shorter than the poll interval — so reconcile's mid-backoff terminal check (classifyTrackerOnly
          // on the `retrying` view) usually cannot run in time and we'd waste a whole turn re-running
          // COMPLETED work on an issue a human has taken over. Re-check this one issue's tracker state right
          // before re-dispatching a continuation; terminal → clean up, neither/vanished → release, both via
          // the same reconcile action. Fail-open on a tracker error (reconcile's refresh-failed semantics):
          // proceed with the continuation — the next reconcile tick still catches a genuine handoff.
          // ponytail: continuation only. A failure retry has the same theoretical window, but it re-runs a
          // FAILED turn (lower value) and its exponential backoff usually spans a poll tick; drop the `kind`
          // gate to guard that path too if it ever matters.
          if (kind === "continuation") {
            const stateResult = yield* Effect.either(tracker.fetchIssueStatesByIds([issueId]));
            if (Either.isRight(stateResult)) {
              const refreshed = new Map(stateResult.right.map((r) => [r.id, r] as const));
              const action = classifyTrackerOnly(issueId, refreshed, activeStates, terminalStates);
              if (action !== null) {
                yield* applyReconcileAction(action);
                return;
              }
            } else {
              yield* observer.emit({
                _tag: "TrackerError",
                op: "fetchIssueStatesByIds",
                message: errLabel(stateResult.left),
              });
            }
          }
          yield* store.update((s) => clearRetry(s, issueId));
          yield* observer.emit({ _tag: "RetryFired", issueId, identifier: rec.issue.identifier });
          if (kind === "continuation") {
            yield* dispatch(rec.issue, { kind: "continuation", turn: attempt });
          } else {
            yield* dispatch(rec.issue, { kind: "fresh", attempt: rec.failureAttempts });
          }
        });

      // ───────────────────────────── Commands (#64, DD-2) ─────────────────────────────

      /**
       * Apply one operator {@link Command} serially on the owner fiber and complete its
       * `reply` Deferred with a {@link CommandResult}. This runs in the exact same place,
       * and under the same single-consumer guarantee, as every other mailbox message — so
       * commands can never race a tick, a worker-done, or each other.
       */
      const handleCommand = (
        command: Command,
        reply: Deferred.Deferred<CommandResult>,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          // If the caller already gave up (its `send` await was interrupted on timeout →
          // the reply Deferred is interrupted/done), DROP the command without applying it:
          // a caller that got a 503 must not have its command silently take effect. There
          // is a tiny residual window — the owner can observe not-done here and the caller
          // can time out a microsecond later, applying anyway — which is acceptable (the
          // caller's 503 then merely raced an applied command; exactly-once is preserved).
          if (yield* Deferred.isDone(reply)) {
            return;
          }
          switch (command._tag) {
            case "PauseDispatch": {
              if (!operatorPaused) {
                operatorPaused = true;
                yield* controlStatus.setOperatorPaused(true);
                yield* observer.emit({ _tag: "OperatorControl", paused: true });
              }
              yield* Deferred.succeed(reply, { _tag: "Control", state: controlState() });
              break;
            }
            case "ResumeDispatch": {
              if (operatorPaused) {
                operatorPaused = false;
                yield* controlStatus.setOperatorPaused(false);
                yield* observer.emit({ _tag: "OperatorControl", paused: false });
              }
              yield* Deferred.succeed(reply, { _tag: "Control", state: controlState() });
              break;
            }
            case "RetryNow": {
              const rec = registry.get(command.issueId);
              // Eligible only when a retry/continuation backoff timer is pending: fire it
              // NOW. Interrupt the armed timer first so it cannot also post a RetryDue later
              // (double-dispatch), then run the normal re-dispatch path.
              if (rec !== undefined && rec.timerFiber !== null) {
                yield* Fiber.interrupt(rec.timerFiber);
                rec.timerFiber = null;
                yield* handleRetryDue(command.issueId);
                yield* observer.emit({
                  _tag: "RetryNowRequested",
                  issueId: command.issueId,
                  accepted: true,
                });
                yield* Deferred.succeed(reply, { _tag: "Ack", accepted: true, reason: null });
                break;
              }
              const reason =
                rec === undefined
                  ? "no such tracked issue"
                  : rec.workerFiber !== null
                    ? "issue is already running"
                    : "issue has no pending retry";
              yield* observer.emit({
                _tag: "RetryNowRequested",
                issueId: command.issueId,
                accepted: false,
              });
              yield* Deferred.succeed(reply, { _tag: "Ack", accepted: false, reason });
              break;
            }
            case "CancelSession": {
              const rec = registry.get(command.issueId);
              if (rec === undefined) {
                yield* Deferred.succeed(reply, {
                  _tag: "Ack",
                  accepted: false,
                  reason: "no such tracked issue",
                });
                break;
              }
              // Interrupt ONLY this issue's worker + its pending timer, then fully release
              // it (not a completion — it can be re-picked later) and drop the registry
              // entry. No other worker is touched. Dropping the entry first means the
              // interrupted worker's onExit posts no spurious WorkerDone.
              const identifier = rec.issue.identifier;
              yield* killAndForget(command.issueId, rec, (s) => release(s, command.issueId));
              yield* observer.emit({
                _tag: "SessionCancelled",
                issueId: command.issueId,
                identifier,
              });
              yield* Deferred.succeed(reply, { _tag: "Ack", accepted: true, reason: null });
              break;
            }
            case "ReloadConfig": {
              // Sprint 6 / #66 (DD-4): settings hot-reload. The WorkflowFile already
              // validated + atomically wrote the patched WORKFLOW.md; here the owner fiber
              // (the only writer) swaps the live config and patches the two state-seeded
              // knobs so the next dispatch tick plans against the new values. NOTHING in
              // flight is touched — only future-tick decisions change.
              liveConfig = command.config;
              yield* store.update((s) => ({
                ...s,
                poll_interval_ms: liveConfig.polling.interval_ms,
                max_concurrent_agents: liveConfig.agent.max_concurrent_agents,
              }));
              // Mirror the new ceiling into the live-budget holder so the cockpit read
              // snapshot projects the reloaded budget block, not the stale startup ceiling.
              yield* liveBudget.set(liveConfig.budget);
              yield* observer.emit({
                _tag: "ConfigReloaded",
                pollIntervalMs: liveConfig.polling.interval_ms,
                maxConcurrent: liveConfig.agent.max_concurrent_agents,
              });
              yield* Deferred.succeed(reply, { _tag: "Reloaded" });
              break;
            }
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
          case "Command":
            return handleCommand(msg.command, msg.reply);
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

      // ───────────────────────────── Restore + reconcile (#41) ─────────────────────────────

      /**
       * Build a minimal {@link Issue} for a restored issue. The checkpoint persists only
       * id/identifier per attempt (not the full tracker issue), which is all the
       * continuation/reconcile paths need: workspace key + guidance use `identifier`, and
       * the first tick's reconcile refreshes the real tracker state. `state` is seeded to
       * the first configured active state so per-state concurrency accounting treats the
       * restored issue as active until reconcile corrects it.
       */
      const restoredActiveState = config.tracker.active_states[0] ?? "";
      const restoredIssue = (id: string, identifier: string): Issue =>
        Issue.make({
          id,
          identifier,
          title: identifier,
          description: null,
          priority: null,
          state: restoredActiveState,
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        });

      /** A restored re-arm: which registry record fires, and after how many wall-clock ms. */
      interface ReArm {
        readonly rec: IssueRuntime;
        readonly delayMs: number;
      }

      /**
       * Fork a restored retry's timer with its residual wall-clock delay and record it as
       * `rec.timerFiber` so the issue occupies a concurrency slot. Forked AFTER the first
       * `Tick` is enqueued (see boot sequence) so the FIFO mailbox guarantees the tick's
       * reconcile runs before any `RetryDue` — a restored issue that went terminal/vanished
       * while the daemon was down is killed by reconcile, never re-dispatched.
       */
      const armRestoredRetry = (arm: ReArm): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const issueId = arm.rec.issue.id;
          const timer = yield* Effect.forkScoped(
            Effect.sleep(Duration.millis(arm.delayMs)).pipe(
              Effect.zipRight(Queue.offer(mailbox, { _tag: "RetryDue", issueId })),
              Effect.asVoid,
            ),
          );
          arm.rec.timerFiber = timer;
        });

      /** Residual wall-clock ms until a restored retry is due (NEVER the monotonic `due_at_ms`). */
      const remainingWallMs = (entry: RetryEntry, wallNow: number): number => {
        // `scheduled_at + delay_ms` is the absolute wall-clock fire instant captured at
        // schedule time (#37) — the only restart-safe countdown. The persisted `due_at_ms`
        // is monotonic, relative to the dead process's clock origin, and is never read here.
        if (entry.scheduled_at === undefined || entry.delay_ms === undefined) {
          return 0; // pre-#37 file (durability never writes one) → due immediately, defensive.
        }
        const fireInstant = entry.scheduled_at.getTime() + entry.delay_ms;
        return Math.max(fireInstant - wallNow, 0);
      };

      /**
       * Rebuild the runtime registry from the restored checkpoint, convert orphaned
       * `running` issues into due-immediately continuation retries, and compute the
       * wall-clock re-arm plan for every pending retry. The returned plan's timers are
       * forked by the caller AFTER the first `Tick` is enqueued. Returns an empty plan on a
       * cold/empty start (nothing to restore).
       */
      const restoreFromCheckpoint: Effect.Effect<ReadonlyArray<ReArm>, never> = Effect.gen(
        function* () {
          const restored = yield* store.get;
          const runningEntries = Object.entries(restored.running);
          const retryEntries = Object.entries(restored.retry_attempts);
          const abandonedEntries = Object.entries(restored.abandoned);
          const restoredCompleted = restored.completed.length;
          if (
            runningEntries.length === 0 &&
            retryEntries.length === 0 &&
            abandonedEntries.length === 0 &&
            restoredCompleted === 0
          ) {
            return []; // cold start — nothing was restored.
          }

          const wallNow = yield* clock.currentTimeMillis;
          const monoNow = yield* clock.monotonicMillis;
          const plan: ReArm[] = [];
          // Opt-in best-effort session resume (#42). When off (default), restored
          // continuations run FRESH — the #41 baseline (`rec.sessionId` stays null). When
          // on, a restored continuation carries its persisted session id so `dispatch`
          // passes `--resume`; a stale id self-heals via the normal failure path.
          const resumeEnabled = config.persistence.resume_sessions;

          // 1) Orphaned `running` → due-immediately continuation retry. Each persisted
          //    `running` issue has no live worker fiber after a restart, so we reduce it to
          //    the existing retry/reconcile/dispatch machinery: clear it from `running`,
          //    schedule a `kind:"continuation"` retry due now, and let `handleRetryDue`
          //    re-dispatch it as a continuation against its on-disk workspace. With resume
          //    enabled (#42) `rec.sessionId` is restored so the continuation resumes the
          //    agent thread; otherwise it stays null and the turn runs fresh (the
          //    workspace-on-disk is the true record of progress either way).
          let orphanedRunningConverted = 0;
          for (const [id, ra] of runningEntries) {
            const rec = freshRuntime(restoredIssue(id, ra.issue_identifier));
            rec.workspace = {
              path: ra.workspace_path,
              workspace_key: sanitizeWorkspaceKey(ra.issue_identifier),
              created_now: false,
            };
            rec.turnCount = ra.turn ?? 0;
            rec.failureAttempts = ra.failure_attempts ?? 0;
            rec.sessionId = resumeEnabled ? (ra.session_id ?? null) : null;
            rec.lastEventAt = monoNow;
            const attempt = rec.turnCount + 1;
            rec.pendingKind = "continuation";
            rec.pendingAttempt = attempt;
            registry.set(id, rec);
            yield* store.update((s) =>
              setRetry(clearRunning(s, id), {
                issue_id: id,
                identifier: ra.issue_identifier,
                attempt,
                due_at_ms: monoNow,
                scheduled_at: new Date(wallNow),
                delay_ms: 0,
                kind: "continuation",
                // Carry the session id truthfully (#42); the runtime `rec.sessionId` above
                // is what actually gates resume on the immediate re-dispatch.
                session_id: ra.session_id ?? null,
                error: null,
              }),
            );
            plan.push({ rec, delayMs: 0 });
            orphanedRunningConverted += 1;
          }

          // 2) Pending retries → re-arm from WALL-CLOCK. Reconstruct the registry record's
          //    pending kind/attempt from the persisted `RetryEntry` so `handleRetryDue`
          //    re-dispatches the correct shape, then schedule the timer with the residual
          //    wall-clock delay (0 = already due).
          let reArmedRetries = 0;
          for (const [id, entry] of retryEntries) {
            if (registry.has(id)) {
              continue; // running + retry are mutually exclusive; orphan handled above.
            }
            const rec = freshRuntime(restoredIssue(id, entry.identifier));
            const kind = entry.kind ?? "failure";
            rec.pendingKind = kind;
            rec.pendingAttempt = entry.attempt;
            rec.lastEventAt = monoNow;
            // Resume only applies to continuations (a failure retry re-dispatches fresh).
            rec.sessionId =
              resumeEnabled && kind === "continuation" ? (entry.session_id ?? null) : null;
            if (kind === "continuation") {
              rec.turnCount = Math.max(entry.attempt - 1, 0);
            } else {
              rec.failureAttempts = entry.attempt;
            }
            registry.set(id, rec);
            plan.push({ rec, delayMs: remainingWallMs(entry, wallNow) });
            reArmedRetries += 1;
          }

          // 3) Exhausted failures → rebuild an inert registry record so the first tick can
          // reconcile terminal/vanished tracker state. Active issues stay parked/claimed.
          for (const [id, entry] of abandonedEntries) {
            if (registry.has(id)) {
              continue;
            }
            const rec = freshRuntime(restoredIssue(id, entry.identifier));
            rec.failureAttempts = entry.attempts;
            rec.lastEventAt = monoNow;
            registry.set(id, rec);
          }

          // #54: capture the one-shot restore summary as a durable, display-only fact so
          // the snapshot can surface a persistent `restore` block long after this boot
          // observation has scrolled out of the events feed. `wallNow` is the injected
          // clock's instant (deterministic under TestClock); reached only on a real
          // restore (the cold-start path returns above), so a cold start records nothing.
          yield* restoreStatus.record({
            at: new Date(wallNow).toISOString(),
            orphanedRunningConverted,
            reArmedRetries,
            restoredCompleted,
          });
          yield* observer.emit({
            _tag: "RestoredAfterRestart",
            orphanedRunningConverted,
            reArmedRetries,
            restoredCompleted,
          });
          return plan;
        },
      );

      const initial = yield* store.get;
      yield* observer.emit({
        _tag: "Started",
        pollIntervalMs: initial.poll_interval_ms,
        maxConcurrent: initial.max_concurrent_agents,
      });
      // Restore + reconcile + re-arm (#41): rebuild the registry and orphan→continuation
      // BEFORE the first tick. The re-arm timers are forked below, AFTER the Tick is
      // enqueued, so reconcile gates every restored RetryDue (no double-dispatch).
      const reArmPlan = yield* restoreFromCheckpoint;
      yield* startupCleanup;
      yield* Queue.offer(mailbox, { _tag: "Tick" });
      // Fork restored timers now that the first Tick is already in the FIFO mailbox: the
      // single consumer drains the Tick (reconcile → dispatch) before any RetryDue these
      // timers post, and forking them here means the restored issues already occupy
      // concurrency slots when the first tick plans dispatch (no over-admission).
      for (const arm of reArmPlan) {
        yield* armRestoredRetry(arm);
      }

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const s = yield* store.get;
            yield* Effect.sleep(Duration.millis(s.poll_interval_ms));
            yield* Queue.offer(mailbox, { _tag: "Tick" });
          }),
        ),
      );

      // Command pump (#64, DD-2): drain the CommandBus into the SAME mailbox the owner
      // fiber consumes, so every operator command is applied serially alongside ticks /
      // worker-done / retry-due. The HTTP handler offered the command and is awaiting its
      // reply Deferred, which `handleCommand` completes.
      yield* Effect.forkScoped(
        Effect.forever(
          commandBus.take.pipe(
            Effect.flatMap((enq) =>
              Queue.offer(mailbox, {
                _tag: "Command",
                command: enq.command,
                reply: enq.reply,
              }),
            ),
          ),
        ),
      );

      yield* Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(handle)));
    }),
  );
