import { Effect, Layer, Queue } from "effect";
import { type Observation, Observer } from "../../src/core/orchestrator/observer";

/**
 * `RecordingObserver` (Task 10/12 seam) — a queue-backed {@link Observer}. Every typed
 * {@link Observation} the loop emits is pushed onto an unbounded queue, so tests step the
 * single-fiber loop *deterministically*: take observations until a predicate matches
 * (see `waitFor` in `harness.ts`) instead of racing on `TestClock.adjust`. The unbounded
 * queue means the loop never blocks on observation backpressure.
 */
export interface RecordingObserver {
  readonly layer: Layer.Layer<Observer>;
  readonly queue: Queue.Queue<Observation>;
}

export const makeRecordingObserver = (): Effect.Effect<RecordingObserver> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Observation>();
    const layer = Layer.succeed(Observer, {
      emit: (obs) => Queue.offer(queue, obs).pipe(Effect.asVoid),
    });
    return { layer, queue };
  });
