import { Effect, Layer } from "effect";
import { Observer } from "../orchestrator/observer";
import { logObservation } from "./live-observer";
import { RecentEvents, RecentEventsLive, toEventDraft } from "./recent-events";

/**
 * Sprint 3 / #36 — the **tee observer**. `Observer` is a single `Context.Tag`, NOT a
 * multicast bus, so `Layer.merge` cannot fan it out (Sprint 3 design-review ruling).
 * Instead this layer *wraps* the live observer: every observation is (1) logged exactly
 * as {@link file://./live-observer.ts ObserverLive} would (reusing {@link logObservation}
 * verbatim — no behavior drift) AND (2) appended to the {@link RecentEvents} ring for the
 * dashboard feed. The append is non-failing and cheap; high-volume / cadence
 * observations are filtered out by {@link toEventDraft}, so logging is unaffected.
 */
export const observerTee: Layer.Layer<Observer, never, RecentEvents> = Layer.effect(
  Observer,
  Effect.gen(function* () {
    const events = yield* RecentEvents;
    return {
      emit: (obs) =>
        Effect.gen(function* () {
          // 1) Preserve the canonical structured log line, byte-for-byte.
          yield* logObservation(obs);
          // 2) Tee a display-safe envelope into the ring (cadence/chatter → null → skip).
          const draft = toEventDraft(obs);
          if (draft !== null) {
            yield* events.append(draft);
          }
        }),
    };
  }),
);

/**
 * Bundled observability layer: provides both the {@link Observer} (tee) and the
 * {@link RecentEvents} ring it writes to, feeding the ring into the tee while still
 * exporting it so the snapshot server can read the feed. Drop-in replacement for
 * `ObserverLive` in the daemon's application layer.
 */
export const ObservabilityLive: Layer.Layer<Observer | RecentEvents> = observerTee.pipe(
  Layer.provideMerge(RecentEventsLive),
);
