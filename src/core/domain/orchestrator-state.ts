import { Schema } from "effect";
import { RetryEntry } from "./retry-entry";
import { RunAttempt } from "./run-attempt";
import { PositiveInt } from "./workflow";

/** Aggregate token + runtime accounting (spec `codex_totals`, renamed). */
export const AgentTotals = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  total_tokens: Schema.Int,
  runtime_seconds: Schema.Number,
}).annotations({ identifier: "AgentTotals" });
export type AgentTotals = typeof AgentTotals.Type;

/** An active issue parked after exhausting failure retries. */
export const AbandonedIssue = Schema.Struct({
  issue_id: Schema.String,
  /** Best-effort human ID for status surfaces/logs. */
  identifier: Schema.String,
  /** Failure count that crossed `agent.max_failure_retries` (always ≥ 1: `max + 1`). */
  attempts: PositiveInt,
  /** Wall-clock instant the issue was parked. */
  abandoned_at: Schema.Date,
  /** Last failure/stall reason that exhausted the retry budget. */
  reason: Schema.String,
}).annotations({ identifier: "AbandonedIssue" });
export type AbandonedIssue = typeof AbandonedIssue.Type;

/**
 * The single authoritative in-memory state owned by the orchestrator fiber
 * (SPEC §4.1.8). Runtime-only handles (worker fibers, retry timer handles) live
 * outside this serializable view; sets are modeled as string arrays.
 *
 * Orchestra renames the spec's `codex_*` aggregate fields to `agent_*`.
 *
 * Invariant: `running`, `retry_attempts`, and `abandoned` are mutually exclusive —
 * an issue is in at most one of them at a time, and every key in any of the three is
 * also present in `claimed` (it holds a concurrency slot). `completed` is disjoint
 * bookkeeping. The `state.ts` transitions are the only mutators and each preserves
 * this: dispatch/retry/abandon move the issue between the three maps while keeping the
 * claim; `markCompleted`/`release` clear all three plus the claim. This is what keeps a
 * parked (abandoned) issue from being re-dispatched: it stays claimed, so selection
 * skips it, until tracker reconciliation reaps it.
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
  /**
   * `issue_id -> AbandonedIssue`. Exhausted failures stay claimed here so a still-active
   * tracker issue cannot be picked every poll and burn infinite retries. Optional default
   * keeps existing checkpoints decodable.
   */
  abandoned: Schema.optionalWith(Schema.Record({ key: Schema.String, value: AbandonedIssue }), {
    default: () => ({}),
  }),
  /** Issue IDs completed (bookkeeping only — does NOT gate dispatch). */
  completed: Schema.Array(Schema.String),
  agent_totals: AgentTotals,
  /** Latest rate-limit snapshot from agent events (vendor-shaped passthrough). */
  agent_rate_limits: Schema.NullOr(Schema.Unknown),
}).annotations({ identifier: "OrchestratorState" });
export type OrchestratorState = typeof OrchestratorState.Type;
