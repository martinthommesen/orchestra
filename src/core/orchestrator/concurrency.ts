import { type Issue, normalizeState } from "../domain/issue";

/**
 * Concurrency control (SPEC §8.3). Global available slots plus optional per-state
 * caps. Pure and property-tested: the dispatch plan never exceeds the global limit
 * nor any per-state cap. The orchestrator feeds the sorted candidate list (see
 * `selection.ts`) into {@link planDispatch} and starts exactly the returned issues.
 */

export interface ConcurrencyContext {
  /** Global `max_concurrent_agents`. */
  readonly globalLimit: number;
  /** Normalized `state -> limit` overrides (`max_concurrent_agents_by_state`). */
  readonly perStateLimits: ReadonlyMap<string, number>;
  /** Count of currently-running agents (all states). */
  readonly runningTotal: number;
  /** Normalized `state -> running count` for the running agents. */
  readonly runningByState: ReadonlyMap<string, number>;
}

/** Build a {@link ConcurrencyContext}, normalizing the per-state limit keys. */
export const concurrencyContext = (input: {
  readonly globalLimit: number;
  readonly perStateLimits: Readonly<Record<string, number>>;
  readonly runningTotal: number;
  readonly runningByState: ReadonlyMap<string, number>;
}): ConcurrencyContext => {
  const perStateLimits = new Map<string, number>();
  for (const [state, limit] of Object.entries(input.perStateLimits)) {
    perStateLimits.set(normalizeState(state), limit);
  }
  return {
    globalLimit: input.globalLimit,
    perStateLimits,
    runningTotal: input.runningTotal,
    runningByState: input.runningByState,
  };
};

/** Global free slots: `max(limit - running, 0)` (SPEC §8.3). */
export const availableSlots = (limit: number, running: number): number =>
  Math.max(limit - running, 0);

/**
 * The effective per-state cap: an explicit `max_concurrent_agents_by_state` entry if
 * present, else the global limit (SPEC §8.3 — states without an override fall back to
 * the global cap).
 */
export const perStateLimit = (state: string, ctx: ConcurrencyContext): number =>
  ctx.perStateLimits.get(normalizeState(state)) ?? ctx.globalLimit;

/**
 * Choose which sorted candidates to dispatch this tick without exceeding the global
 * free slots or any per-state cap (SPEC §8.3). Walks the (already priority-ordered)
 * candidates, greedily admitting each while both budgets allow, decrementing the
 * per-state budget as it goes. Returns the issues to start, in order.
 */
export const planDispatch = (
  sorted: ReadonlyArray<Issue>,
  ctx: ConcurrencyContext,
): ReadonlyArray<Issue> => {
  const globalAvailable = availableSlots(ctx.globalLimit, ctx.runningTotal);
  if (globalAvailable <= 0) {
    return [];
  }
  const chosen: Issue[] = [];
  const byState = new Map(ctx.runningByState);
  for (const issue of sorted) {
    if (chosen.length >= globalAvailable) {
      break;
    }
    const state = normalizeState(issue.state);
    const limit = perStateLimit(state, ctx);
    const current = byState.get(state) ?? 0;
    if (current >= limit) {
      continue;
    }
    chosen.push(issue);
    byState.set(state, current + 1);
  }
  return chosen;
};
