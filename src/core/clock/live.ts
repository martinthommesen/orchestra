import { Clock as EffectClock, Layer } from "effect";
import { Clock } from "../ports/clock";

/**
 * Live {@link Clock} adapter. Both time sources delegate to Effect's own `Clock`
 * service rather than raw `Date.now()`/`performance.now()` — that indirection is the
 * whole point of the port: under `TestClock` the orchestrator's timers (poll interval,
 * retry backoff, stall detection) advance deterministically with `TestClock.adjust`.
 *
 * `monotonicMillis` is sourced from `Clock.currentTimeMillis` too: a true OS-monotonic
 * source (`performance.now`) would escape `TestClock`'s control and make backoff/stall
 * timing untestable, so we accept Effect's clock as the single, test-controllable time
 * base for v1 (documented trade-off).
 */
export const ClockLive: Layer.Layer<Clock> = Layer.succeed(Clock, {
  currentTimeMillis: EffectClock.currentTimeMillis,
  monotonicMillis: EffectClock.currentTimeMillis,
});
