import type { FileSystem } from "@effect/platform";
import { Clock, Effect, Layer, Option, Ref, type Scope } from "effect";
import { OrchestratorState } from "../domain/orchestrator-state";
import type { ServiceConfig } from "../domain/workflow";
import { initialState, OrchestratorStore } from "../orchestrator/state";
import type { PersistedState } from "./persisted-state";
import { toPersisted } from "./persisted-state";
import { layerPersistence, Persistence } from "./persistence";

/**
 * Sprint 4 / #40 — the transparent durable {@link OrchestratorStore} decorator
 * (durability spike §2.4, §2.7).
 *
 * It is a **drop-in replacement** for `layerOrchestratorStore` in the daemon's
 * `appLayer`: it loads the checkpoint, seeds the `Ref`, wraps `update`/`modify` to signal
 * the persistence writer after each mutation, and forks the single scoped debounced writer
 * (with a guaranteed final flush). `get`/`update`/`modify` semantics are byte-identical, so
 * `loop.ts` and `snapshot-server.ts` need no edits.
 *
 * ## Seed boundary — #40 restores BOOKKEEPING ONLY (the deliberate #40/#41 line)
 * The checkpoint persists the *whole* state (the writer saves `store.get`, scheduling state
 * included), but on restore #40 seeds only the **safe bookkeeping**: `completed`,
 * `agent_totals`, `agent_rate_limits`, and the config-derived knobs. The **scheduling**
 * slice — `running`, `claimed`, `retry_attempts` — is intentionally reset to empty, because
 * restoring it live requires the registry rebuild + wall-clock retry re-arm +
 * orphan→continuation reconcile that is #41. Seeding it without #41 would either strand
 * issues (a `running` entry with no worker fiber is never reconciled to progress; a
 * `retry_attempts` entry with no re-armed timer never fires — both stay `claimed` forever)
 * or risk the per-tick reconcile mishandling orphaned `running` entries. Resetting that
 * slice reproduces today's safe behavior (next tick re-selects active issues fresh) with
 * zero new double-dispatch risk, while bookkeeping/totals survive the restart immediately.
 * #41 replaces {@link seedState} with a full restore + reconcile.
 */
export const seedState = (
  loaded: Option.Option<PersistedState>,
  config: ServiceConfig,
): OrchestratorState => {
  const base = initialState(config);
  return Option.match(loaded, {
    onNone: () => base,
    onSome: (p) =>
      OrchestratorState.make({
        ...base,
        // SAFE bookkeeping (gates nothing in dispatch) — restored as-is.
        completed: p.state.completed,
        agent_totals: p.state.agent_totals,
        agent_rate_limits: p.state.agent_rate_limits,
        // SCHEDULING slice (running / claimed / retry_attempts) stays empty until #41
        // can rebuild the registry, re-arm retries from wall-clock, and convert orphans.
        // TODO(#41): seed running/claimed/retry_attempts from p.state and reconcile+re-arm.
      }),
  });
};

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
