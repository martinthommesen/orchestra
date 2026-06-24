import { Schema } from "effect";

/**
 * Run-attempt lifecycle phases (SPEC §7.2). Distinct terminal reasons matter
 * because retry logic and logs differ per outcome.
 */
export const RunAttemptPhase = Schema.Literal(
  "PreparingWorkspace",
  "BuildingPrompt",
  "LaunchingAgentProcess",
  "InitializingSession",
  "StreamingTurn",
  "Finishing",
  "Succeeded",
  "Failed",
  "TimedOut",
  "Stalled",
  "CanceledByReconciliation",
).annotations({ identifier: "RunAttemptPhase" });
export type RunAttemptPhase = typeof RunAttemptPhase.Type;

/** One execution attempt for one issue (SPEC §4.1.5). */
export const RunAttempt = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  /** `null` for the first run, `>= 1` for retries/continuation. */
  attempt: Schema.NullOr(Schema.Int),
  workspace_path: Schema.String,
  started_at: Schema.Date,
  status: RunAttemptPhase,
  error: Schema.optional(Schema.String),
  /**
   * Clean turns completed for this issue before the current attempt (Sprint 4 / #41).
   * Persisted so a restart can rebuild the registry's `turnCount` and resume an orphaned
   * `running` issue as a *continuation* (`attempt = turn + 1`) instead of restarting its
   * turn accounting. Optional/additive — absent in pre-#41 checkpoints and ignored by the
   * defensive snapshot client.
   */
  turn: Schema.optional(Schema.Int),
  /**
   * Failure retries so far for this issue (Sprint 4 / #41). Persisted so a restart
   * preserves exponential-backoff accounting across the resumed attempt. Optional/additive.
   */
  failure_attempts: Schema.optional(Schema.Int),
  /**
   * The agent thread/session id for this attempt (Sprint 4 / #42). Captured from the
   * `SessionStarted` event and persisted so a restart can *optionally* resume the agent
   * thread instead of starting fresh — gated behind `persistence.resume_sessions`
   * (default off). Optional/additive: absent in pre-#42 checkpoints; `null` until the
   * session id is known. The workspace on disk remains the true record of progress, so
   * resume is best-effort and self-healing (a stale id falls back to a fresh turn).
   */
  session_id: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({ identifier: "RunAttempt" });
export type RunAttempt = typeof RunAttempt.Type;
