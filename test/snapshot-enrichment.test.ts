import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { RetryEntry } from "../src/core/domain/retry-entry";
import { RunAttempt } from "../src/core/domain/run-attempt";
import type { ActivityEntry } from "../src/core/observability/live-activity";
import type { RecentCompletion } from "../src/core/observability/recent-completions";
import type { EventEnvelope } from "../src/core/observability/recent-events";
import { toSnapshot } from "../src/core/observability/snapshot-server";
import { initialState, setRetry, setRunning } from "../src/core/orchestrator/state";
import { buildDef } from "./fakes/harness";

/**
 * Sprint 3 / #37 — snapshot enrichment. Proves the projection is **strictly additive**:
 * existing fields stay byte-compatible while `recent_events`, `recent_completed`,
 * `running[].last_activity`, and retry `scheduled_at`/`delay_ms` appear when sourced.
 */

const config = buildDef({ intervalMs: 5000, maxConcurrent: 4 }).config;

const running = () =>
  setRunning(
    initialState(config),
    RunAttempt.make({
      issue_id: "i1",
      issue_identifier: "ORC-1",
      attempt: null,
      workspace_path: "/tmp/ws/i1",
      started_at: new Date("2024-01-01T00:00:00.000Z"),
      status: "StreamingTurn",
    }),
  );

describe("toSnapshot enrichment (#37)", () => {
  it.effect("is additive: with no extras the new fields are empty and old fields unchanged", () =>
    Effect.sync(() => {
      const snap = toSnapshot(running());
      // New additive fields default empty.
      expect(snap.recent_events).toEqual([]);
      expect(snap.recent_completed).toEqual([]);
      // running entry carries NO last_activity when there is none.
      expect((snap.running[0] as { last_activity?: unknown }).last_activity).toBeUndefined();
      // Old fields byte-compatible.
      expect(snap.completed).toEqual([]);
      expect(snap.counts.running).toBe(1);
      expect(snap.running[0]?.issue_identifier).toBe("ORC-1");
    }),
  );

  it.effect("projects recent_events and recent_completed from the rings (newest-last)", () =>
    Effect.sync(() => {
      const recentEvents: ReadonlyArray<EventEnvelope> = [
        {
          seq: 1,
          emitted_at: "2024-01-01T00:00:00.000Z",
          level: "info",
          kind: "dispatched",
          message: "a",
        },
        {
          seq: 2,
          emitted_at: "2024-01-01T00:00:01.000Z",
          level: "warn",
          kind: "failed",
          message: "b",
        },
      ];
      const recentCompleted: ReadonlyArray<RecentCompletion> = [
        {
          issue_id: "i0",
          identifier: "ORC-0",
          finished_at: "2024-01-01T00:00:02.000Z",
          outcome: "completed",
        },
      ];
      const snap = toSnapshot(running(), { recentEvents, recentCompleted });
      expect(snap.recent_events.map((e) => e.seq)).toEqual([1, 2]);
      expect(snap.recent_completed[0]?.outcome).toBe("completed");
    }),
  );

  it.effect("merges last_activity onto the matching running issue only", () =>
    Effect.sync(() => {
      const activity = new Map<string, ActivityEntry>([
        ["i1", { event_tag: "TurnCompleted", at: "2024-01-01T00:00:03.000Z" }],
        ["other", { event_tag: "SessionStarted", at: "2024-01-01T00:00:04.000Z" }],
      ]);
      const snap = toSnapshot(running(), { activity });
      const row = snap.running[0] as { issue_id: string; last_activity?: ActivityEntry };
      expect(row.issue_id).toBe("i1");
      expect(row.last_activity?.event_tag).toBe("TurnCompleted");
    }),
  );

  it.effect("retrying carries scheduled_at + delay_ms (ISO via JSON) while due_at_ms is kept", () =>
    Effect.sync(() => {
      const state = setRetry(initialState(config), {
        issue_id: "i2",
        identifier: "ORC-2",
        attempt: 2,
        due_at_ms: 123456,
        scheduled_at: new Date("2024-01-01T00:00:05.000Z"),
        delay_ms: 4000,
        error: "boom",
      });
      const json = JSON.parse(JSON.stringify(toSnapshot(state)));
      const r = json.retrying[0];
      expect(r.due_at_ms).toBe(123456); // monotonic value unchanged
      expect(r.scheduled_at).toBe("2024-01-01T00:00:05.000Z");
      expect(r.delay_ms).toBe(4000);
    }),
  );

  it.effect("a retry without the new fields omits them (backward compatible)", () =>
    Effect.sync(() => {
      const state = setRetry(
        initialState(config),
        RetryEntry.make({
          issue_id: "i3",
          identifier: "ORC-3",
          attempt: 1,
          due_at_ms: 999,
          error: null,
        }),
      );
      const json = JSON.parse(JSON.stringify(toSnapshot(state)));
      const r = json.retrying[0];
      expect(r.due_at_ms).toBe(999);
      expect(r.scheduled_at).toBeUndefined();
      expect(r.delay_ms).toBeUndefined();
    }),
  );
});
