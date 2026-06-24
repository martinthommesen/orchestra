import type { FileSystem } from "@effect/platform";
import { Clock, Effect, Layer, Option, Ref, type Scope } from "effect";
import { OrchestratorState } from "../domain/orchestrator-state";
import type { ServiceConfig } from "../domain/workflow";
import { initialState, OrchestratorStore } from "../orchestrator/state";
import type { PersistedState } from "./persisted-state";
import { toPersisted } from "./persisted-state";
import { layerPersistence, Persistence } from "./persistence";

/**
 * Sprint 4 / #40+#41 — the transparent durable {@link OrchestratorStore} decorator
 * (durability spike §2.4, §2.7).
 *
 * It is a **drop-in replacement** for `layerOrchestratorStore` in the daemon's
 * `appLayer`: it loads the checkpoint, seeds the `Ref`, wraps `update`/`modify` to signal
 * the persistence writer after each mutation, and forks the single scoped debounced writer
 * (with a guaranteed final flush). `get`/`update`/`modify` semantics are byte-identical, so
 * `loop.ts` and `snapshot-server.ts` need no edits.
 *
 * ## Full state restore (#41)
 * The checkpoint persists the *whole* state (the writer saves `store.get`, scheduling state
 * included). On restore #41 seeds the **complete** {@link OrchestratorState} — bookkeeping
 * (`completed`, `agent_totals`, `agent_rate_limits`) **and** the scheduling slice
 * (`running`, `claimed`, `retry_attempts`). The poll/concurrency knobs are taken from the
 * **live config** (they are reloadable: a checkpoint's values may be stale relative to the
 * current `WORKFLOW.md`), everything else from the checkpoint.
 *
 * Seeding the scheduling slice is only safe because `runOrchestrator`'s startup
 * (the restore + reconcile + wall-clock retry re-arm in `loop.ts`) rebuilds the in-memory
 * registry, converts each orphaned `running` issue into a due-immediately continuation
 * retry, and re-arms every pending retry from its wall-clock due time — all **before** the
 * first tick dispatches. Without that, a `running` entry with no worker fiber would never
 * progress and a `retry_attempts` entry with no re-armed timer would never fire. The two
 * halves (this seed + the loop's reconcile) are a single restore flow.
 */
export const seedState = (
  loaded: Option.Option<PersistedState>,
  config: ServiceConfig,
): OrchestratorState =>
  Option.match(loaded, {
    onNone: () => initialState(config),
    onSome: (p) =>
      OrchestratorState.make({
        ...p.state,
        // Reloadable knobs always come from the live config, never the (possibly stale)
        // checkpoint — matching `initialState`'s config-sourced semantics.
        poll_interval_ms: config.polling.interval_ms,
        max_concurrent_agents: config.agent.max_concurrent_agents,
      }),
  });

/**
 * Build a durable {@link OrchestratorStore}: load → seed → wrap mutators → fork writer.
 * Requires a {@link Scope} (provided by `Layer.scoped`) so the writer fiber is torn down —
 * and the final flush runs — with the orchestrator scope.
 */
export const makeDurableStore = (
  config: ServiceConfig,
): Effect.Effect<typeof OrchestratorStore.Service, never, Persistence | Scope.Scope> =>
  Effect.gen(function* () {
    const persistence = yield* Persistence;
    const loaded = yield* persistence.load;
    const ref = yield* Ref.make(seedState(loaded, config));

    // The latest value to persist, stamped with a wall-clock `saved_at` (diagnostic only).
    const snapshot: Effect.Effect<PersistedState> = Effect.gen(function* () {
      const state = yield* Ref.get(ref);
      const now = yield* Clock.currentTimeMillis;
      return toPersisted(state, new Date(now));
    });

    // Mutator chokepoint: apply, then signal the debounced writer (§2.4).
    const update = (f: (s: OrchestratorState) => OrchestratorState): Effect.Effect<void> =>
      Ref.update(ref, f).pipe(Effect.zipRight(persistence.markDirty));
    const modify = <A>(
      f: (s: OrchestratorState) => readonly [A, OrchestratorState],
    ): Effect.Effect<A> => Ref.modify(ref, f).pipe(Effect.tap(() => persistence.markDirty));

    yield* persistence.runWriter(snapshot);

    return { get: Ref.get(ref), update, modify };
  });

/**
 * Layer providing a durable {@link OrchestratorStore}. Drop-in for
 * `layerOrchestratorStore(config)` in `daemon.ts`; requires `FileSystem` (ambient via
 * `NodeContext.layer`).
 */
export const layerDurableOrchestratorStore = (
  config: ServiceConfig,
): Layer.Layer<OrchestratorStore, never, FileSystem.FileSystem> =>
  Layer.scoped(OrchestratorStore, makeDurableStore(config)).pipe(
    Layer.provide(layerPersistence(config)),
  );
