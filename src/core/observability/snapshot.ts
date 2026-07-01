import type { OrchestratorState } from "../domain/orchestrator-state";
import type { BudgetStatus } from "../orchestrator/budget";
import type { ActivityEntry } from "./live-activity";
import type { RecentCompletion } from "./recent-completions";
import type { EventEnvelope } from "./recent-events";
import type { RestoreSummary } from "./restore-status";
import type { SnapshotWire } from "./snapshot-wire";

/**
 * The JSON snapshot **projection** (SPEC §13.3/§13.7) consumed by `GET /api/v1/state`.
 *
 * Sprint 6 / #65 (DD-1) moved HTTP serving out of this module into the typed cockpit
 * `HttpApi` ({@link file://../cockpit/api.ts}); what remains here is the pure, byte-stable
 * projection of the authoritative {@link OrchestratorState} (plus the additive observability
 * blocks). The cockpit's read handler returns `HttpServerResponse.json(toSnapshot(...))`, so
 * the wire bytes a Sprint-5 reader sees do not regress (a round-trip test pins it).
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
const budgetProjection = (budget: BudgetStatus | undefined) => {
  if (!budget?.configured || budget.limitTokens === null || budget.remainingTokens === null) {
    return null;
  }
  return {
    limit_tokens: budget.limitTokens,
    spent_tokens: budget.spentTokens,
    remaining_tokens: budget.remainingTokens,
    paused: budget.paused,
  };
};

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

/** JSON-friendly projection of the authoritative state (Dates → ISO explicitly). */
export const toSnapshot = (s: OrchestratorState, extra: SnapshotExtras = {}): SnapshotWire => {
  const running = Object.values(s.running).map((ra) => {
    const act = extra.activity?.get(ra.issue_id);
    // Build conforming RunAttemptWire: explicit Date→string + exact-optional handling
    // (Effect Schema's optional fields widen to `T | undefined`; exactOptionalPropertyTypes
    // requires the absent-or-T form, so each optional field needs a conditional spread).
    const base = {
      issue_id: ra.issue_id,
      issue_identifier: ra.issue_identifier,
      attempt: ra.attempt,
      workspace_path: ra.workspace_path,
      started_at: ra.started_at.toISOString(),
      status: ra.status,
      ...(ra.error !== undefined ? { error: ra.error } : {}),
      ...(ra.turn !== undefined ? { turn: ra.turn } : {}),
      ...(ra.failure_attempts !== undefined ? { failure_attempts: ra.failure_attempts } : {}),
      ...(ra.session_id !== undefined ? { session_id: ra.session_id } : {}),
    };
    // Additive: attach last_activity only when this running issue has any (else omit).
    return act === undefined ? base : { ...base, last_activity: act };
  });
  const retrying = Object.values(s.retry_attempts).map((e) => ({
    issue_id: e.issue_id,
    identifier: e.identifier,
    attempt: e.attempt,
    due_at_ms: e.due_at_ms,
    // Convert scheduled_at Date → ISO string; use conditional spread for exactOptionalPropertyTypes.
    ...(e.scheduled_at !== undefined ? { scheduled_at: e.scheduled_at.toISOString() } : {}),
    ...(e.delay_ms !== undefined ? { delay_ms: e.delay_ms } : {}),
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.session_id !== undefined ? { session_id: e.session_id } : {}),
    error: e.error,
  }));
  const abandoned = Object.values(s.abandoned).map((a) => ({
    issue_id: a.issue_id,
    identifier: a.identifier,
    attempts: a.attempts,
    // Convert abandoned_at Date → ISO string (the wire contract is string).
    abandoned_at: a.abandoned_at.toISOString(),
    reason: a.reason,
  }));
  const budget = budgetProjection(extra.budget);
  const restore = restoreProjection(extra.restore);
  const control = controlProjection(extra.operatorPaused ?? false, extra.budget);
  return {
    poll_interval_ms: s.poll_interval_ms,
    max_concurrent_agents: s.max_concurrent_agents,
    counts: {
      running: running.length,
      retrying: retrying.length,
      abandoned: abandoned.length,
      completed: s.completed.length,
      claimed: s.claimed.length,
    },
    running,
    // retrying carries the new (optional) scheduled_at/delay_ms automatically; due_at_ms
    // (monotonic) is retained unchanged.
    retrying,
    abandoned,
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
