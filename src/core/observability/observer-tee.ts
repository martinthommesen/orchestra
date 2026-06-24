import { Effect, Layer } from "effect";
import { Observer } from "../orchestrator/observer";
import { humanizeAgentEvent } from "./humanize";
import { LiveActivity, LiveActivityLive } from "./live-activity";
import { logObservation } from "./live-observer";
import { RecentEvents, RecentEventsLive, toEventDraft } from "./recent-events";

/**
 * Sprint 3 / #36 + #37 — the **tee observer**. `Observer` is a single `Context.Tag`, NOT
 * a multicast bus, so `Layer.merge` cannot fan it out (Sprint 3 design-review ruling).
 * Instead this layer *wraps* the live observer: every observation is
 *   1. logged exactly as {@link file://./live-observer.ts ObserverLive} would (reusing
 *      {@link logObservation} verbatim — no behavior drift),
 *   2. teed into the {@link RecentEvents} ring for the dashboard feed (cadence/chatter
 *      filtered by {@link toEventDraft}), and
 *   3. for `AgentEvent`s, recorded into {@link LiveActivity} as that issue's last activity
 *      (per-session "what is this worker doing now?", #37).
 * All appends are non-failing and cheap; logging is unaffected.
 */
export const observerTee: Layer.Layer<Observer, never, RecentEvents | LiveActivity> = Layer.effect(
  Observer,
  Effect.gen(function* () {
    const events = yield* RecentEvents;
    const activity = yield* LiveActivity;
    return {
      emit: (obs) =>
        Effect.gen(function* () {
          // 1) Preserve the canonical structured log line, byte-for-byte.
          yield* logObservation(obs);
          // 2) Record per-session activity, keeping the raw tag and a humanized summary.
          if (obs._tag === "AgentEvent") {
            yield* activity.set(obs.issueId, {
              event_tag: obs.eventTag,
              message: humanizeAgentEvent(obs.eventTag),
            });
          }
          // 3) Tee a display-safe envelope into the feed (cadence/chatter → null → skip).
          const draft = toEventDraft(obs);
          if (draft !== null) {
            yield* events.append(draft);
          }
        }),
    };
  }),
);

/**
 * Bundled observability layer: provides the {@link Observer} (tee) plus the
 * {@link RecentEvents} ring and {@link LiveActivity} map it writes to, feeding them into
 * the tee while still exporting them so the snapshot server can read both. Drop-in
 * replacement for `ObserverLive` in the daemon's application layer.
 */
export const ObservabilityLive: Layer.Layer<Observer | RecentEvents | LiveActivity> =
  observerTee.pipe(Layer.provideMerge(Layer.merge(RecentEventsLive, LiveActivityLive)));
