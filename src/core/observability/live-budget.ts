import { Context, Effect, Layer, Ref } from "effect";
import type { BudgetConfig } from "../domain/workflow";

/**
 * Sprint 6 / PR #74 review — **live budget visibility**. The budget ceiling is a
 * hot-reloadable knob (`budget.max_total_tokens`, DD-4): a `ReloadConfig` command swaps the
 * loop's live config so the next dispatch tick gates against the new ceiling. The cockpit's
 * read snapshot must project that SAME live ceiling, otherwise after a settings reload the
 * budget block keeps reporting the stale startup limit.
 *
 * This tiny service mirrors {@link file://./control-status.ts ControlStatus} exactly: a holder
 * written ONLY by the owner fiber (in the same place it applies `ReloadConfig` and patches
 * `liveConfig`) and read by the snapshot server — so the snapshot fiber never reaches into the
 * loop. It seeds with the startup budget so the read path is correct from the first request,
 * before the loop applies any reload.
 *
 * It holds no scheduling state and can never influence dispatch — the authoritative ceiling is
 * the loop-local `liveConfig.budget`. The snapshot still omits the budget block when the ceiling
 * is not constraining (pure `evaluateBudget` returns the additive shape), exactly as before.
 */
export class LiveBudget extends Context.Tag("orchestra/LiveBudget")<
  LiveBudget,
  {
    /** Mirror the live budget ceiling (owner-fiber write, on `ReloadConfig`). */
    readonly set: (budget: BudgetConfig) => Effect.Effect<void>;
    /** Read the live budget ceiling (snapshot-server read). */
    readonly get: Effect.Effect<BudgetConfig>;
  }
>() {}

/** Build a live-budget holder seeded with the startup budget. */
export const makeLiveBudget = (
  seed: BudgetConfig,
): Effect.Effect<Context.Tag.Service<LiveBudget>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(seed);
    return {
      set: (budget) => Ref.set(ref, budget),
      get: Ref.get(ref),
    };
  });

/** Layer providing a {@link LiveBudget} seeded with the startup `config.budget`. */
export const LiveBudgetLive = (seed: BudgetConfig): Layer.Layer<LiveBudget> =>
  Layer.effect(LiveBudget, makeLiveBudget(seed));
