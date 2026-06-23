import { Schema } from "effect";
import { RetryEntry } from "./retry-entry";
import { RunAttempt } from "./run-attempt";

/** Aggregate token + runtime accounting (spec `codex_totals`, renamed). */
export const AgentTotals = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  total_tokens: Schema.Int,
  runtime_seconds: Schema.Number,
}).annotations({ identifier: "AgentTotals" });
export type AgentTotals = typeof AgentTotals.Type;

/**
 * The single authoritative in-memory state owned by the orchestrator fiber
 * (SPEC §4.1.8). Runtime-only handles (worker fibers, retry timer handles) live
 * outside this serializable view; sets are modeled as string arrays.
 *
 * Orchestra renames the spec's `codex_*` aggregate fields to `agent_*`.
 */
export const OrchestratorState = Schema.Struct({
  /** Current effective poll interval (reloadable). */
  poll_interval_ms: Schema.Int,
  /** Current effective global concurrency limit (reloadable). */
  max_concurrent_agents: Schema.Int,
  /** `issue_id -> running attempt`. */
  running: Schema.Record({ key: Schema.String, value: RunAttempt }),
  /** Issue IDs reserved/running/retrying (claim set). */
  claimed: Schema.Array(Schema.String),
  /** `issue_id -> RetryEntry`. */
  retry_attempts: Schema.Record({ key: Schema.String, value: RetryEntry }),
  /** Issue IDs completed (bookkeeping only — does NOT gate dispatch). */
  completed: Schema.Array(Schema.String),
  agent_totals: AgentTotals,
  /** Latest rate-limit snapshot from agent events (vendor-shaped passthrough). */
  agent_rate_limits: Schema.NullOr(Schema.Unknown),
}).annotations({ identifier: "OrchestratorState" });
export type OrchestratorState = typeof OrchestratorState.Type;
