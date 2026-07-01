import type { AgentTotals } from "../domain/orchestrator-state";
import type { BudgetConfig } from "../domain/workflow";

/**
 * Sprint 5 / #53, Sprint 6 / #77 — the **budget guardrail** evaluation, kept as a pure
 * function so the dispatch gate stays trivially testable and out of the worker/reconcile
 * paths.
 *
 * The guard reads the cumulative spend (`agent_totals.total_tokens`, accumulated by
 * `addUsage`) and compares it to the configured ceiling(s). When spend reaches either
 * ceiling the orchestrator **pauses NEW dispatch only** — it never kills, interrupts, or
 * reschedules in-flight workers, pending retries, or reconciliation (Sprint 5 constraint
 * #2). An absent ceiling makes the status `configured: false` / `paused: false`, so an
 * unchanged config behaves exactly as it did pre-#53.
 *
 * Two ceiling types are supported (either or both can be configured):
 * - Token ceiling (`max_total_tokens`): pauses when `total_tokens ≥ limit`.
 * - Cost ceiling (`max_cost_usd` priced via `usd_per_million_tokens`): pauses when
 *   `total_tokens / 1e6 * rate ≥ max_cost_usd`. Requires both knobs; the config filter
 *   rejects a missing rate at load time so this path is always coherent.
 *
 * This module performs **no IO and holds no state**: the loop calls it once per tick with
 * the current totals and decides whether to plan zero dispatches; the snapshot server
 * calls it to project a display-only budget block. Neither path mutates `OrchestratorState`.
 */

/** Display-/decision-ready snapshot of the budget guard for one set of totals. */
export interface BudgetStatus {
  /** True when a token OR a cost ceiling is configured; false leaves the guard inert. */
  readonly configured: boolean;
  /** Configured token ceiling, or null when none is set. */
  readonly limitTokens: number | null;
  /** Cumulative tokens spent so far (`agent_totals.total_tokens`). */
  readonly spentTokens: number;
  /** `max(limitTokens - spentTokens, 0)`, or null when no token ceiling is set. */
  readonly remainingTokens: number | null;
  /** Configured USD spend ceiling (`max_cost_usd`), or null when not set. */
  readonly limitUsd: number | null;
  /** `spentTokens / 1e6 * rate`, or null when no rate is configured. */
  readonly spentUsd: number | null;
  /** `max(limitUsd - spentUsd, 0)`, or null when either USD input is absent. */
  readonly remainingUsd: number | null;
  /** True when spend ≥ token ceiling OR cost ≥ cost ceiling → NEW dispatch withheld. */
  readonly paused: boolean;
}

/**
 * Evaluate the budget guard for the given config + cumulative totals. Pure and total:
 * no ceiling → inert (`paused: false`); otherwise paused iff either ceiling is reached.
 */
export const evaluateBudget = (budget: BudgetConfig, totals: AgentTotals): BudgetStatus => {
  const limitTokens = budget.max_total_tokens ?? null;
  const spentTokens = totals.total_tokens;
  const rate = budget.usd_per_million_tokens ?? null;
  const limitUsd = budget.max_cost_usd ?? null;
  const spentUsd = rate === null ? null : (spentTokens / 1_000_000) * rate;
  const tokenPaused = limitTokens !== null && spentTokens >= limitTokens;
  const costPaused = limitUsd !== null && spentUsd !== null && spentUsd >= limitUsd;
  return {
    configured: limitTokens !== null || limitUsd !== null,
    limitTokens,
    spentTokens,
    remainingTokens: limitTokens === null ? null : Math.max(limitTokens - spentTokens, 0),
    limitUsd,
    spentUsd,
    remainingUsd: limitUsd === null || spentUsd === null ? null : Math.max(limitUsd - spentUsd, 0),
    paused: tokenPaused || costPaused,
  };
};
