import { Context, Effect, Clock as EffectClock, Layer, Ref } from "effect";
import type { Observation } from "../orchestrator/observer";
import { truncateOneLine } from "./glyphs";

/**
 * Sprint 3 / #36 — the **recent-events ring buffer**: a bounded, display-safe history
 * of orchestrator lifecycle events that the snapshot API surfaces so the dashboard can
 * render a live feed. It is **observability, NOT scheduling state** (PROJECT_BRIEF /
 * Sprint 3 constraint #2): it lives in this service, never inside `OrchestratorState`,
 * so it can never influence dispatch. The snapshot server reads it alongside the store.
 *
 * Append must be **non-failing and cheap** — it runs inline on the single state-owning
 * loop fiber (driven by the {@link file://./observer-tee.ts tee observer}). The buffer is
 * bounded to {@link RECENT_EVENTS_CAP}; messages are truncated **at ingestion** so a
 * runaway message can never blow up the ring or a snapshot response.
 *
 * High-volume `AgentEvent` observations are deliberately **dropped** here (see
 * {@link toEventDraft}) so per-token agent chatter cannot drown the terminal/lifecycle
 * events an operator actually wants in the feed; live agent activity is surfaced
 * separately via {@link file://./live-activity.ts LiveActivity} (#37).
 */

/** Max envelopes retained in the ring (oldest dropped past this). */
export const RECENT_EVENTS_CAP = 200;

/** Per-message ingestion budget (chars) — keeps one event on one line, bounds size. */
export const EVENT_MESSAGE_MAX = 160;

/** A bounded, display-safe event envelope (the snapshot's `recent_events[]` shape). */
export interface EventEnvelope {
  /** Monotonic sequence number (1-based, assigned at append). */
  readonly seq: number;
  /** Wall-clock ISO instant the event was recorded. */
  readonly emitted_at: string;
  readonly level: "info" | "warn";
  /** Stable event kind (e.g. `dispatched`, `worker_failed`). */
  readonly kind: string;
  readonly issue_id?: string;
  readonly identifier?: string;
  /** Human-readable, already truncated at ingestion. */
  readonly message: string;
}

/** The pure mapping output (envelope minus the append-assigned `seq`/`emitted_at`). */
export interface EventDraft {
  readonly level: "info" | "warn";
  readonly kind: string;
  readonly issue_id?: string;
  readonly identifier?: string;
  readonly message: string;
}

/**
 * Pure {@link Observation} → {@link EventDraft} mapping for the feed. Returns `null` for
 * observations that must NOT enter the feed:
 *   - `AgentEvent` — high-volume per-turn chatter (surfaced via {@link LiveActivity});
 *   - `TickStart` / `TickEnd` / `Reconciled` — internal loop cadence, not operator-facing.
 * Everything else becomes a display-safe draft (the message is truncated at append).
 */
export const toEventDraft = (obs: Observation): EventDraft | null => {
  switch (obs._tag) {
    case "AgentEvent":
    case "TickStart":
    case "TickEnd":
    case "Reconciled":
      return null;
    case "Started":
      return { level: "info", kind: "started", message: "orchestrator started" };
    case "RestoredAfterRestart":
      return {
        level: "info",
        kind: "restored",
        message:
          `restored after restart: ${obs.orphanedRunningConverted} running, ` +
          `${obs.reArmedRetries} retrying, ${obs.restoredCompleted} completed`,
      };
    case "StartupCleanup":
      return {
        level: "info",
        kind: "startup_cleanup",
        message: `startup cleanup removed ${obs.removed.length} workspace(s)`,
      };
    case "Dispatched":
      return {
        level: "info",
        kind: "dispatched",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `dispatched ${obs.identifier} (turn ${obs.turn})`,
      };
    case "WorkerCompleted":
      return {
        level: "info",
        kind: "completed",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `completed ${obs.identifier}`,
      };
    case "WorkerFailed":
      return {
        level: "warn",
        kind: "failed",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `failed ${obs.identifier}: ${obs.message}`,
      };
    case "WorkerKilled":
      return {
        level: "warn",
        kind: "killed",
        issue_id: obs.issueId,
        message: `killed ${obs.issueId} (${obs.reason})`,
      };
    case "WorkspaceCleaned":
      return {
        level: "info",
        kind: "workspace_cleaned",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `cleaned workspace ${obs.identifier}`,
      };
    case "RetryScheduled":
      return {
        level: "info",
        kind: "retry_scheduled",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `retry ${obs.identifier} in ${obs.delayMs}ms (${obs.kind}, attempt ${obs.attempt})`,
      };
    case "RetryFired":
      return {
        level: "info",
        kind: "retry_fired",
        issue_id: obs.issueId,
        identifier: obs.identifier,
        message: `retry fired ${obs.identifier}`,
      };
    case "PreflightFailed":
      return {
        level: "warn",
        kind: "preflight_failed",
        message: `preflight failed: ${obs.reason}`,
      };
    case "TrackerError":
      return {
        level: "warn",
        kind: "tracker_error",
        message: `tracker error (${obs.op}): ${obs.message}`,
      };
    case "BudgetExceeded":
      return obs.paused
        ? {
            level: "warn",
            kind: "budget_paused",
            message:
              `budget reached: new dispatch paused ` +
              `(${obs.spentTokens}/${obs.limitTokens} tokens)`,
          }
        : {
            level: "info",
            kind: "budget_resumed",
            message:
              `budget cleared: new dispatch resumed ` +
              `(${obs.spentTokens}/${obs.limitTokens} tokens)`,
          };
  }
};

/** Assemble the immutable envelope from a draft + assigned seq/timestamp (truncating). */
const finalize = (draft: EventDraft, seq: number, emittedAt: string): EventEnvelope => ({
  seq,
  emitted_at: emittedAt,
  level: draft.level,
  kind: draft.kind,
  // exactOptionalPropertyTypes: only attach optional keys when actually present.
  ...(draft.issue_id !== undefined ? { issue_id: draft.issue_id } : {}),
  ...(draft.identifier !== undefined ? { identifier: draft.identifier } : {}),
  message: truncateOneLine(draft.message, EVENT_MESSAGE_MAX),
});

/**
 * The recent-events ring service. `append` records a draft (assigning a monotonic seq +
 * wall-clock instant from Effect's clock, so it is `TestClock`-deterministic) and never
 * fails. `list` is a safe concurrent read for the snapshot server (newest-LAST).
 */
export class RecentEvents extends Context.Tag("orchestra/RecentEvents")<
  RecentEvents,
  {
    readonly append: (draft: EventDraft) => Effect.Effect<void>;
    /** Bounded ring, oldest-first / newest-last (the snapshot `recent_events[]` order). */
    readonly list: Effect.Effect<ReadonlyArray<EventEnvelope>>;
  }
>() {}

interface RingState {
  readonly seq: number;
  readonly buffer: ReadonlyArray<EventEnvelope>;
}

/** Build a recent-events ring bounded to `cap`. */
export const makeRecentEvents = (
  cap: number = RECENT_EVENTS_CAP,
): Effect.Effect<Context.Tag.Service<RecentEvents>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<RingState>({ seq: 0, buffer: [] });
    return {
      append: (draft) =>
        Effect.gen(function* () {
          const ms = yield* EffectClock.currentTimeMillis;
          const emittedAt = new Date(ms).toISOString();
          yield* Ref.update(ref, (st) => {
            const seq = st.seq + 1;
            const next = [...st.buffer, finalize(draft, seq, emittedAt)];
            const buffer = next.length > cap ? next.slice(next.length - cap) : next;
            return { seq, buffer };
          });
        }),
      list: Ref.get(ref).pipe(Effect.map((st) => st.buffer)),
    };
  });

/** Layer providing an empty {@link RecentEvents} ring at the default cap. */
export const RecentEventsLive: Layer.Layer<RecentEvents> = Layer.effect(
  RecentEvents,
  makeRecentEvents(),
);
