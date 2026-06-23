import { Schema } from "effect";

/**
 * Scheduled retry state for an issue (SPEC §4.1.7). `due_at_ms` is a *monotonic*
 * clock value (see {@link file://../ports/clock.ts}), not wall-clock, so backoff
 * scheduling is immune to system-clock jumps. `timer_handle` is a runtime-specific
 * reference held outside the serializable state, hence excluded from this schema.
 */
export const RetryEntry = Schema.Struct({
  issue_id: Schema.String,
  /** Best-effort human ID for status surfaces/logs. */
  identifier: Schema.String,
  /** 1-based attempt counter for the retry queue. */
  attempt: Schema.Int,
  /** Monotonic-clock timestamp at which the retry becomes due. */
  due_at_ms: Schema.Number,
  error: Schema.NullOr(Schema.String),
}).annotations({ identifier: "RetryEntry" });
export type RetryEntry = typeof RetryEntry.Type;
