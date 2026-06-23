import { Schema } from "effect";

/**
 * State tracked while a coding-agent subprocess is running (SPEC §4.1.6).
 *
 * Orchestra renames the spec's `codex_*` fields to `agent_*` since the agent is
 * GitHub Copilot, not Codex; the semantics are unchanged.
 */
export const LiveSession = Schema.Struct({
  /** `<thread_id>-<turn_id>` (SPEC §4.2). */
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  /** Agent subprocess PID (spec `codex_app_server_pid`). */
  agent_pid: Schema.NullOr(Schema.String),
  /** Last observed agent event tag (spec `last_codex_event`). */
  last_agent_event: Schema.NullOr(Schema.String),
  last_agent_timestamp: Schema.NullOr(Schema.Date),
  /** Summarized last message payload (spec `last_codex_message`). */
  last_agent_message: Schema.NullOr(Schema.String),
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  total_tokens: Schema.Int,
  last_reported_input_tokens: Schema.Int,
  last_reported_output_tokens: Schema.Int,
  last_reported_total_tokens: Schema.Int,
  /** Coding-agent turns started within the current worker lifetime. */
  turn_count: Schema.Int,
}).annotations({ identifier: "LiveSession" });
export type LiveSession = typeof LiveSession.Type;
