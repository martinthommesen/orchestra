import { Context, Effect, Layer, Ref } from "effect";
import type { Usage } from "../domain/agent-event";
import { type AbandonedIssue, AgentTotals, OrchestratorState } from "../domain/orchestrator-state";
import type { RetryEntry } from "../domain/retry-entry";
import type { RunAttempt } from "../domain/run-attempt";
import type { ServiceConfig } from "../domain/workflow";

/**
 * Task 1 — the orchestrator's single authoritative in-memory state (SPEC §4.1.8, §7),
 * held behind a service so only the owning fiber mutates it. The serializable view is
 * the {@link OrchestratorState} schema (running / claimed / retry_attempts / completed /
 * agent_totals / rate_limits + effective poll/concurrency knobs); runtime-only handles
 * (worker fibers, retry timers, live-session bookkeeping) live in the loop, not here.
 *
 * Mutations are expressed as **pure** `OrchestratorState -> OrchestratorState`
 * functions (below) so they are unit/property-testable without a runtime; the service
 * just applies them atomically via a `Ref`. The snapshot API (Task 12) reads the same
 * `Ref` concurrently, which `Ref.get` makes safe.
 */

// ───────────────────────────── Pure state transitions ──────────────────────────────

/** The all-zero token/runtime accumulator. */
export const zeroTotals = (): AgentTotals =>
  AgentTotals.make({ input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_seconds: 0 });

/** Derive the initial state from a resolved {@link ServiceConfig}. */
export const initialState = (config: ServiceConfig): OrchestratorState =>
  OrchestratorState.make({
    poll_interval_ms: config.polling.interval_ms,
    max_concurrent_agents: config.agent.max_concurrent_agents,
    running: {},
    claimed: [],
    retry_attempts: {},
    abandoned: {},
    completed: [],
    agent_totals: zeroTotals(),
    agent_rate_limits: null,
  });

const withClaim = (claimed: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  claimed.includes(id) ? claimed : [...claimed, id];

const withoutItem = (xs: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  xs.filter((x) => x !== id);

const omitKey = <V>(rec: Readonly<Record<string, V>>, id: string): Readonly<Record<string, V>> => {
  if (!(id in rec)) {
    return rec;
  }
  const { [id]: _omit, ...rest } = rec;
  return rest;
};

/** Add an issue to the claim set (idempotent). */
export const claim = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  claimed: withClaim(s.claimed, id),
});

/** Drop an issue from the claim set (does not touch running/retry maps). */
export const unclaim = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  claimed: withoutItem(s.claimed, id),
});

/** Record/replace a running attempt and ensure the issue is claimed. */
export const setRunning = (s: OrchestratorState, attempt: RunAttempt): OrchestratorState => ({
  ...s,
  running: { ...s.running, [attempt.issue_id]: attempt },
  abandoned: omitKey(s.abandoned, attempt.issue_id),
  claimed: withClaim(s.claimed, attempt.issue_id),
});

/** Remove a running attempt (leaves the claim — caller decides whether to retry). */
export const clearRunning = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  running: omitKey(s.running, id),
});

/** Schedule/replace a retry entry and ensure the issue stays claimed. */
export const setRetry = (s: OrchestratorState, entry: RetryEntry): OrchestratorState => ({
  ...s,
  retry_attempts: { ...s.retry_attempts, [entry.issue_id]: entry },
  abandoned: omitKey(s.abandoned, entry.issue_id),
  claimed: withClaim(s.claimed, entry.issue_id),
});

/** Remove a retry entry. */
export const clearRetry = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  retry_attempts: omitKey(s.retry_attempts, id),
});

/** Park an issue after exhausting failure retries; it remains claimed until tracker state changes. */
export const abandon = (s: OrchestratorState, entry: AbandonedIssue): OrchestratorState => ({
  ...s,
  running: omitKey(s.running, entry.issue_id),
  retry_attempts: omitKey(s.retry_attempts, entry.issue_id),
  abandoned: { ...s.abandoned, [entry.issue_id]: entry },
  claimed: withClaim(s.claimed, entry.issue_id),
});

/**
 * Mark an issue completed: add to `completed` (bookkeeping only — does NOT gate
 * dispatch, SPEC §4.1.8) and clear it from running/retry/claimed.
 */
export const markCompleted = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  completed: s.completed.includes(id) ? s.completed : [...s.completed, id],
  running: omitKey(s.running, id),
  retry_attempts: omitKey(s.retry_attempts, id),
  abandoned: omitKey(s.abandoned, id),
  claimed: withoutItem(s.claimed, id),
});

/** Fully release an issue (clear running/retry/claim) without marking it completed. */
export const release = (s: OrchestratorState, id: string): OrchestratorState => ({
  ...s,
  running: omitKey(s.running, id),
  retry_attempts: omitKey(s.retry_attempts, id),
  abandoned: omitKey(s.abandoned, id),
  claimed: withoutItem(s.claimed, id),
});

/** Accumulate reported {@link Usage} into the aggregate totals (SPEC §4.1.8). */
export const addUsage = (s: OrchestratorState, usage: Usage): OrchestratorState => ({
  ...s,
  agent_totals: AgentTotals.make({
    input_tokens: s.agent_totals.input_tokens + (usage.input_tokens ?? 0),
    output_tokens: s.agent_totals.output_tokens + (usage.output_tokens ?? 0),
    // `total = input + output`. When the source reports an explicit `total_tokens`, use it;
    // otherwise derive it from the parts. Copilot surfaces only per-message `output_tokens`
    // (no input/total — Sprint 7), so this lets `budget.max_total_tokens` actually bind on the
    // one token signal it gives instead of staying inert. It under-counts by the unreported
    // input tokens — inherent to the source, and a conservative (more permissive) ceiling.
    total_tokens:
      s.agent_totals.total_tokens +
      (usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    runtime_seconds: s.agent_totals.runtime_seconds + (usage.total_api_duration_ms ?? 0) / 1000,
  }),
});

// ───────────────────────────────── The service ─────────────────────────────────────

/**
 * The state service. `get` is a safe concurrent read (snapshot API); `update`/`modify`
 * apply pure transitions atomically. Only the orchestrator fiber should call the
 * mutators, preserving the single-writer invariant.
 */
export class OrchestratorStore extends Context.Tag("orchestra/OrchestratorState")<
  OrchestratorStore,
  {
    readonly get: Effect.Effect<OrchestratorState>;
    readonly update: (f: (s: OrchestratorState) => OrchestratorState) => Effect.Effect<void>;
    readonly modify: <A>(
      f: (s: OrchestratorState) => readonly [A, OrchestratorState],
    ) => Effect.Effect<A>;
  }
>() {}

/** Construct a store seeded with `initial`. */
export const makeOrchestratorStore = (
  initial: OrchestratorState,
): Effect.Effect<Context.Tag.Service<OrchestratorStore>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    return {
      get: Ref.get(ref),
      update: (f) => Ref.update(ref, f),
      modify: (f) => Ref.modify(ref, f),
    };
  });

/** Layer providing an {@link OrchestratorStore} seeded from config defaults. */
export const layerOrchestratorStore = (config: ServiceConfig): Layer.Layer<OrchestratorStore> =>
  Layer.effect(OrchestratorStore, makeOrchestratorStore(initialState(config)));
