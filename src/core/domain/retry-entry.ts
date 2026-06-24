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
  /**
   * Wall-clock instant the retry was *scheduled* (Sprint 3 / #37). Captured at schedule
   * time alongside {@link delay_ms} so observers can compute an honest wall-clock due time
   * (`scheduled_at + delay_ms`) — the monotonic {@link due_at_ms} must never be turned into
   * a wall-clock countdown. Optional for backward compatibility.
   */
  scheduled_at: Schema.optional(Schema.Date),
  /** Backoff delay (ms) applied at schedule time (Sprint 3 / #37). Optional, additive. */
  delay_ms: Schema.optional(Schema.Int),
  /**
   * Whether this retry re-dispatches as a fixed continuation turn or an
   * exponential-backoff failure retry (Sprint 4 / #41). Persisted so a restart can
   * reconstruct the registry's `pendingKind` and re-dispatch the correct shape
   * (`handleRetryDue`). Optional/additive — absent in pre-#41 checkpoints; on restore an
   * absent `kind` defaults to `"failure"`.
   */
  kind: Schema.optional(Schema.Literal("failure", "continuation")),
  error: Schema.NullOr(Schema.String),
}).annotations({ identifier: "RetryEntry" });
export type RetryEntry = typeof RetryEntry.Type;
