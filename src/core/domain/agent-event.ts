import { Schema } from "effect";

/**
 * Normalized agent runtime events (SPEC §10.4), the orchestrator-facing vocabulary
 * the {@link file://../ports/agent-runner.ts AgentRunner} streams. The runner maps
 * its raw transport (Copilot JSONL envelopes for v1 — see
 * `docs/sprint-0/spike-copilot.md`) into this discriminated union so the
 * orchestrator never depends on a vendor wire format.
 *
 * Discriminated by `_tag`. Every variant shares the {@link EventEnvelope} fields.
 */

/** Token / request accounting attached to events that report usage (SPEC §10.4). */
export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Int),
  output_tokens: Schema.optional(Schema.Int),
  total_tokens: Schema.optional(Schema.Int),
  /** Copilot premium-request credits consumed (observed in the spike PoC `result`). */
  premium_requests: Schema.optional(Schema.Number),
  total_api_duration_ms: Schema.optional(Schema.Number),
}).annotations({ identifier: "Usage" });
export type Usage = typeof Usage.Type;

/**
 * Common envelope fields on every {@link AgentEvent} (SPEC §10.4: `timestamp`,
 * agent pid, OPTIONAL `usage`). Spread into each tagged variant.
 */
const EventEnvelope = {
  timestamp: Schema.Date,
  /** The agent subprocess PID when available (SPEC's `codex_app_server_pid`). */
  agent_pid: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Usage),
};

/** Session established; carries the composed `<thread_id>-<turn_id>` session id. */
const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  ...EventEnvelope,
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
});

/** Agent failed to start its session (maps to SPEC `startup_failed`). */
const StartupFailed = Schema.TaggedStruct("StartupFailed", {
  ...EventEnvelope,
  message: Schema.String,
});

/** A turn finished successfully (SPEC `turn_completed`). */
const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {
  ...EventEnvelope,
  turn_id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/** A turn failed (SPEC `turn_failed`). */
const TurnFailed = Schema.TaggedStruct("TurnFailed", {
  ...EventEnvelope,
  message: Schema.String,
});

/** A turn was cancelled, e.g. by reconciliation (SPEC `turn_cancelled`). */
const TurnCancelled = Schema.TaggedStruct("TurnCancelled", {
  ...EventEnvelope,
  reason: Schema.optional(Schema.String),
});

/** A turn ended carrying an error payload (SPEC `turn_ended_with_error`). */
const TurnEndedWithError = Schema.TaggedStruct("TurnEndedWithError", {
  ...EventEnvelope,
  message: Schema.String,
});

/** The agent is blocked awaiting user input (SPEC `turn_input_required`). */
const TurnInputRequired = Schema.TaggedStruct("TurnInputRequired", {
  ...EventEnvelope,
  prompt: Schema.optional(Schema.String),
});

/** An approval was auto-granted under the high-trust policy (SPEC `approval_auto_approved`). */
const ApprovalAutoApproved = Schema.TaggedStruct("ApprovalAutoApproved", {
  ...EventEnvelope,
  kind: Schema.optional(Schema.String),
});

/** The agent requested an unsupported tool (SPEC `unsupported_tool_call`). */
const UnsupportedToolCall = Schema.TaggedStruct("UnsupportedToolCall", {
  ...EventEnvelope,
  tool: Schema.String,
});

/** Free-form notification from the agent (SPEC `notification`). */
const Notification = Schema.TaggedStruct("Notification", {
  ...EventEnvelope,
  message: Schema.String,
});

/** Any other assistant message payload (SPEC `other_message`). */
const AgentMessage = Schema.TaggedStruct("AgentMessage", {
  ...EventEnvelope,
  role: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

/** An event that could not be parsed into a known shape (SPEC `malformed`). */
const Malformed = Schema.TaggedStruct("Malformed", {
  ...EventEnvelope,
  raw: Schema.String,
});

/** The normalized agent event union streamed to the orchestrator (SPEC §10.4). */
export const AgentEvent = Schema.Union(
  SessionStarted,
  StartupFailed,
  TurnCompleted,
  TurnFailed,
  TurnCancelled,
  TurnEndedWithError,
  TurnInputRequired,
  ApprovalAutoApproved,
  UnsupportedToolCall,
  Notification,
  AgentMessage,
  Malformed,
).annotations({ identifier: "AgentEvent" });
export type AgentEvent = typeof AgentEvent.Type;
export type AgentEventEncoded = typeof AgentEvent.Encoded;

/** Literal union of every {@link AgentEvent} `_tag`, handy for exhaustive matching. */
export type AgentEventTag = AgentEvent["_tag"];
