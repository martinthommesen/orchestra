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
}).annotations({ identifier: "RunAttempt" });
export type RunAttempt = typeof RunAttempt.Type;
