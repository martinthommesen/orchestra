/**
 * Retry + backoff timing (SPEC §8.4). Two retry flavors:
 *
 *   - **Continuation** after a clean turn exit: a fixed short delay so the agent
 *     picks up the next turn promptly (the issue is still active, more work to do).
 *   - **Failure** retry: exponential backoff `10000 * 2^(attempt-1)`, capped at
 *     `max_retry_backoff_ms`.
 *
 * These are pure millisecond functions; the actual timer management (schedule,
 * cancel-on-reschedule) lives in the loop and is driven by Effect `Clock`/`sleep`
 * so `TestClock` controls it deterministically in tests.
 */

/** Fixed delay before a continuation turn after a clean exit (SPEC §8.4). */
export const CONTINUATION_DELAY_MS = 1000;

/** Base unit for failure backoff (SPEC §8.4): first failure waits 10s. */
export const FAILURE_BASE_MS = 10_000;

/**
 * Failure-retry backoff for a 1-based `attempt`: `min(10000 * 2^(attempt-1), cap)`.
 * Monotonically non-decreasing in `attempt` and never exceeds `maxBackoffMs`. Large
 * attempts overflow `2^(attempt-1)` to `Infinity`, which the `min` safely clamps to
 * the cap.
 */
export const failureBackoffMs = (attempt: number, maxBackoffMs: number): number => {
  const exponent = Math.max(1, Math.floor(attempt)) - 1;
  const raw = FAILURE_BASE_MS * 2 ** exponent;
  return Math.min(raw, maxBackoffMs);
};
