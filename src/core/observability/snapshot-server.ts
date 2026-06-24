import { createServer } from "node:http";
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, type Scope } from "effect";
import type { OrchestratorState } from "../domain/orchestrator-state";
import type { BudgetConfig } from "../domain/workflow";
import { type BudgetStatus, evaluateBudget } from "../orchestrator/budget";
import { OrchestratorStore } from "../orchestrator/state";
import { ControlStatus } from "./control-status";
import { type ActivityEntry, LiveActivity } from "./live-activity";
import { type RecentCompletion, RecentCompletions } from "./recent-completions";
import { type EventEnvelope, RecentEvents } from "./recent-events";
import { RestoreStatus, type RestoreSummary } from "./restore-status";

/**
 * Optional JSON snapshot API (Task 12, SPEC §13.3/§13.7). When the CLI is given
 * `--port N`, this exposes a single read-only endpoint — `GET /api/v1/state` — bound to
 * **loopback only** (`127.0.0.1`), returning the orchestrator's live running/retrying/
 * totals/rate-limit view. It reads the same authoritative {@link OrchestratorStore} the
 * owner fiber writes (a serialized `Ref.get`), so it never mutates state and never races
 * the fiber. Served via `@effect/platform` so it stays inside Effect (no Promise escape)
 * and is torn down with the orchestrator scope.
 *
 * Sprint 3 / #37 enriches the projection with **strictly additive** observability fields
 * sourced from the sibling rings ({@link RecentEvents}, {@link RecentCompletions}) and the
 * {@link LiveActivity} map. Existing fields stay byte-compatible — `completed` remains the
 * IDs-only authoritative list and `retrying[].due_at_ms` is unchanged — so the Sprint 2
 * dashboard parser keeps working without changes.
 */

/** Observability projections read alongside the authoritative state. */
export interface SnapshotExtras {
  readonly recentEvents?: ReadonlyArray<EventEnvelope>;
  readonly recentCompleted?: ReadonlyArray<RecentCompletion>;
  readonly activity?: ReadonlyMap<string, ActivityEntry>;
  /**
   * Budget guardrail status (#53). Strictly additive: the projected `budget` block is
   * emitted ONLY when a ceiling is configured (`configured: true`), so an unconfigured
   * daemon — and every older dashboard — sees no `budget` field at all.
   */
  readonly budget?: BudgetStatus;
  /**
   * Restore/durability status (#54). Strictly additive: the projected `restore` block is
   * emitted ONLY after a real boot-time restore (the loop captured a {@link RestoreSummary}),
   * so a cold start — and every older dashboard — sees no `restore` field at all.
   */
  readonly restore?: RestoreSummary;
  /**
   * Operator-pause latch (#64). Strictly additive: the projected `control` block is
   * emitted ONLY when dispatch is actually withheld (operator OR budget), so a daemon
   * dispatching normally — and every older dashboard — sees no `control` field at all.
   */
  readonly operatorPaused?: boolean;
}

/** Project the operator/budget pause into the additive `control` block, or null to omit. */
const controlProjection = (operatorPaused: boolean, budget: BudgetStatus | undefined) => {
  const budgetPaused = budget?.paused ?? false;
  const dispatchPaused = operatorPaused || budgetPaused;
  if (!dispatchPaused) {
    return null;
  }
  return {
    dispatch_paused: true,
    paused_by: operatorPaused ? ("operator" as const) : ("budget" as const),
  };
};

/** Project the budget status onto the additive wire block, or null to omit it. */
const budgetProjection = (budget: BudgetStatus | undefined) =>
  budget?.configured
    ? {
        limit_tokens: budget.limitTokens,
        spent_tokens: budget.spentTokens,
        remaining_tokens: budget.remainingTokens,
        paused: budget.paused,
      }
    : null;

/** Project the boot-time restore summary onto the additive wire block, or null to omit it. */
const restoreProjection = (restore: RestoreSummary | undefined) =>
  restore === undefined
    ? null
    : {
        at: restore.at,
        orphaned_running_converted: restore.orphanedRunningConverted,
        rearmed_retries: restore.reArmedRetries,
        restored_completed: restore.restoredCompleted,
      };

/** JSON-friendly projection of the authoritative state (Dates → ISO via JSON). */
export const toSnapshot = (s: OrchestratorState, extra: SnapshotExtras = {}) => {
  const running = Object.values(s.running).map((ra) => {
    const act = extra.activity?.get(ra.issue_id);
    // Additive: attach last_activity only when this running issue has any (else omit).
    return act === undefined ? ra : { ...ra, last_activity: act };
  });
  const retrying = Object.values(s.retry_attempts);
  const budget = budgetProjection(extra.budget);
  const restore = restoreProjection(extra.restore);
  const control = controlProjection(extra.operatorPaused ?? false, extra.budget);
  return {
    poll_interval_ms: s.poll_interval_ms,
    max_concurrent_agents: s.max_concurrent_agents,
    counts: {
      running: running.length,
      retrying: retrying.length,
      completed: s.completed.length,
      claimed: s.claimed.length,
    },
    running,
    // retrying carries the new (optional) scheduled_at/delay_ms automatically; due_at_ms
    // (monotonic) is retained unchanged.
    retrying,
    completed: s.completed,
    // Rich completion history (additive; the IDs-only `completed` above is authoritative).
    recent_completed: extra.recentCompleted ?? [],
    // Bounded lifecycle event feed (additive), newest-last.
    recent_events: extra.recentEvents ?? [],
    totals: s.agent_totals,
    rate_limits: s.agent_rate_limits,
    // Budget guardrail status (#53), additive — only present when a ceiling is configured.
    ...(budget === null ? {} : { budget }),
    // Restore/durability status (#54), additive — only present after a real restore.
    ...(restore === null ? {} : { restore }),
    // Control/pause status (#64), additive — only present when dispatch is withheld.
    ...(control === null ? {} : { control }),
  };
};

/**
 * Build the snapshot router. The `budget` config (#53) is closed over so the read handler
 * can project a display-only budget status from the live totals without ever mutating
 * state. Budget evaluation is pure (`evaluateBudget`); the gate that actually withholds
 * dispatch lives in the loop, not here. The boot-time restore fact (#54) is read from the
 * {@link RestoreStatus} ring (written once by the loop) — also display-only.
 */
const makeRouter = (budgetConfig: BudgetConfig) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/v1/state",
      Effect.gen(function* () {
        const store = yield* OrchestratorStore;
        const events = yield* RecentEvents;
        const completions = yield* RecentCompletions;
        const activity = yield* LiveActivity;
        const restoreStatus = yield* RestoreStatus;
        const controlStatus = yield* ControlStatus;
        const state = yield* store.get;
        const recentEvents = yield* events.list;
        const recentCompleted = yield* completions.list;
        const activityMap = yield* activity.snapshot;
        const restore = yield* restoreStatus.get;
        const operatorPaused = yield* controlStatus.get;
        return yield* HttpServerResponse.json(
          toSnapshot(state, {
            recentEvents,
            recentCompleted,
            activity: activityMap,
            budget: evaluateBudget(budgetConfig, state.agent_totals),
            operatorPaused,
            // Additive (#54): absent until a real restore was captured at boot.
            ...(restore === null ? {} : { restore }),
          }),
        ).pipe(Effect.orDie);
      }),
    ),
  );

/**
 * Run the snapshot server on `127.0.0.1:<port>` until interrupted. Fork this into the
 * orchestrator scope alongside the loop; reads the authoritative store plus the
 * observability rings from context. `budgetConfig` (#53) drives the additive budget block.
 */
export const runSnapshotServer = (
  port: number,
  budgetConfig: BudgetConfig,
): Effect.Effect<
  void,
  never,
  | Scope.Scope
  | OrchestratorStore
  | RecentEvents
  | RecentCompletions
  | LiveActivity
  | RestoreStatus
  | ControlStatus
> =>
  HttpServer.serveEffect(makeRouter(budgetConfig)).pipe(
    // `serveEffect` installs the server and returns; the listener lives for as long as
    // the provided layer's scope stays open, so we idle (`Effect.never`) to keep it bound
    // for the lifetime of the orchestrator (interrupting the fiber tears it down cleanly).
    Effect.zipRight(Effect.never),
    Effect.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })),
    // A bind failure (e.g. port in use) must not take down orchestration — log and idle.
    Effect.catchAll((error) =>
      Effect.logError(`snapshot server failed to bind on 127.0.0.1:${port}`).pipe(
        Effect.annotateLogs({ event: "snapshot_server_error", message: String(error) }),
        Effect.zipRight(Effect.never),
      ),
    ),
  );
