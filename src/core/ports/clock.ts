import { Context, type Effect } from "effect";

/**
 * Clock port. Two distinct time sources, kept separate on purpose:
 *
 *   - `currentTimeMillis` — wall-clock (UTC epoch ms) for logs/timestamps.
 *   - `monotonicMillis` — a monotonic source for retry/backoff scheduling
 *     ({@link file://../domain/retry-entry.ts RetryEntry.due_at_ms}); immune to
 *     wall-clock jumps.
 *
 * The Sprint 1 Live implementation delegates to Effect's own `Clock` so that
 * `TestClock` transparently controls time in tests — that's *why* this is a port
 * rather than raw `Date.now()`/`performance.now()`. Named `Clock` per the brief;
 * do not shadow-import Effect's `Clock` in the implementing module.
 *
 * Signatures only — no implementation in Sprint 0.
 */
export class Clock extends Context.Tag("orchestra/Clock")<
  Clock,
  {
    readonly currentTimeMillis: Effect.Effect<number>;
    readonly monotonicMillis: Effect.Effect<number>;
  }
>() {}
