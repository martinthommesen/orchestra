import type { AgentTotals } from "../domain/orchestrator-state";
import type { BudgetConfig } from "../domain/workflow";

/**
 * Sprint 5 / #53 — the **budget guardrail** evaluation, kept as a pure function so the
 * dispatch gate stays trivially testable and out of the worker/reconcile paths.
 *
 * The guard reads the cumulative spend (`agent_totals.total_tokens`, accumulated by
 * `addUsage`) and compares it to the configured token ceiling. When spend reaches the
 * ceiling the orchestrator **pauses NEW dispatch only** — it never kills, interrupts, or
 * reschedules in-flight workers, pending retries, or reconciliation (Sprint 5 constraint
 * #2). An absent ceiling makes the status `configured: false` / `paused: false`, so an
 * unchanged config behaves exactly as it did pre-#53.
 *
 * This module performs **no IO and holds no state**: the loop calls it once per tick with
 * the current totals and decides whether to plan zero dispatches; the snapshot server
 * calls it to project a display-only budget block. Neither path mutates `OrchestratorState`.
 */

/** Display-/decision-ready snapshot of the budget guard for one set of totals. */
export interface BudgetStatus {
  /** True when a ceiling is configured; false leaves the guard inert. */
  readonly configured: boolean;
  /** Configured token ceiling, or null when none is set. */
  readonly limitTokens: number | null;
  /** Cumulative tokens spent so far (`agent_totals.total_tokens`). */
  readonly spentTokens: number;
  /** `max(limit - spent, 0)`, or null when no ceiling is set. */
  readonly remainingTokens: number | null;
  /** True when spend ≥ ceiling → NEW dispatch is withheld this tick. */
  readonly paused: boolean;
}

/**
 * Evaluate the budget guard for the given config + cumulative totals. Pure and total:
 * no ceiling → inert (`paused: false`); otherwise paused iff `total_tokens ≥ ceiling`.
 */
export const evaluateBudget = (budget: BudgetConfig, totals: AgentTotals): BudgetStatus => {
  const limit = budget.max_total_tokens ?? null;
  const spent = totals.total_tokens;
  if (limit === null) {
    return {
      configured: false,
      limitTokens: null,
      spentTokens: spent,
      remainingTokens: null,
      paused: false,
    };
  }
  return {
    configured: true,
    limitTokens: limit,
    spentTokens: spent,
    remainingTokens: Math.max(limit - spent, 0),
    paused: spent >= limit,
  };
};
