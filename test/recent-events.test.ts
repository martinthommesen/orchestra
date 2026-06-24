import { it } from "@effect/vitest";
import { Effect, Logger, TestClock } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { LiveActivity } from "../src/core/observability/live-activity";
import { ObservabilityLive } from "../src/core/observability/observer-tee";
import {
  EVENT_MESSAGE_MAX,
  type EventEnvelope,
  makeRecentEvents,
  RecentEvents,
  toEventDraft,
} from "../src/core/observability/recent-events";
import type { Observation } from "../src/core/orchestrator/observer";
import { Observer } from "../src/core/orchestrator/observer";

/**
 * Sprint 3 / #36 — recent-events ring + tee observer. {@link toEventDraft} is pure, so we
 * cover the whole {@link Observation} union for shape (drops vs envelopes). The ring's
 * monotonic `seq`, bounding, and truncation are exercised directly, and the tee is proven
 * to (a) still emit log records and (b) append the right drafts.
 */

const sample: Record<Observation["_tag"], Observation> = {
  Started: { _tag: "Started", pollIntervalMs: 1000, maxConcurrent: 3 },
  RestoredAfterRestart: {
    _tag: "RestoredAfterRestart",
    orphanedRunningConverted: 1,
    reArmedRetries: 2,
    restoredCompleted: 3,
  },
  StartupCleanup: { _tag: "StartupCleanup", removed: ["a", "b"] },
  TickStart: { _tag: "TickStart" },
  TickEnd: { _tag: "TickEnd", dispatched: ["i1"], dispatchSkipped: false },
  Reconciled: { _tag: "Reconciled", actions: [{ _tag: "StallKill", issueId: "i1" }] },
  Dispatched: {
    _tag: "Dispatched",
    issueId: "42",
    identifier: "#42",
    attempt: 1,
    turn: 1,
    resumed: false,
  },
  AgentEvent: {
    _tag: "AgentEvent",
    issueId: "42",
    identifier: "#42",
    sessionId: "sess-1",
    eventTag: "AgentMessage",
  },
  WorkerCompleted: { _tag: "WorkerCompleted", issueId: "42", identifier: "#42" },
  WorkerFailed: { _tag: "WorkerFailed", issueId: "42", identifier: "#42", message: "boom" },
  WorkerKilled: { _tag: "WorkerKilled", issueId: "42", reason: "stall" },
  WorkspaceCleaned: { _tag: "WorkspaceCleaned", issueId: "42", identifier: "#42" },
  RetryScheduled: {
    _tag: "RetryScheduled",
    issueId: "42",
    identifier: "#42",
    kind: "failure",
    attempt: 2,
    delayMs: 4000,
  },
  RetryFired: { _tag: "RetryFired", issueId: "42", identifier: "#42" },
  PreflightFailed: { _tag: "PreflightFailed", reason: "missing token" },
  TrackerError: { _tag: "TrackerError", op: "fetchCandidates", message: "429" },
};

/** The cadence/chatter observations the feed deliberately drops. */
const DROPPED: ReadonlyArray<Observation["_tag"]> = [
  "AgentEvent",
  "TickStart",
  "TickEnd",
  "Reconciled",
];

describe("toEventDraft", () => {
  it.effect("drops high-volume / cadence observations from the feed", () =>
    Effect.sync(() => {
      for (const tag of DROPPED) {
        expect(toEventDraft(sample[tag])).toBeNull();
      }
    }),
  );

  it.effect("maps every non-dropped observation to a display-safe draft", () =>
    Effect.sync(() => {
      for (const obs of Object.values(sample)) {
        const draft = toEventDraft(obs);
        if (DROPPED.includes(obs._tag)) {
          continue;
        }
        expect(draft).not.toBeNull();
        expect(draft?.level === "info" || draft?.level === "warn").toBe(true);
        expect((draft?.kind ?? "").length).toBeGreaterThan(0);
        expect((draft?.message ?? "").length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("carries issue context where the observation has it; warns are warns", () =>
    Effect.sync(() => {
      const dispatched = toEventDraft(sample.Dispatched);
      expect(dispatched?.issue_id).toBe("42");
      expect(dispatched?.identifier).toBe("#42");
      expect(toEventDraft(sample.WorkerFailed)?.level).toBe("warn");
      expect(toEventDraft(sample.TrackerError)?.level).toBe("warn");
    }),
  );

  it.effect("restored-after-restart becomes one info 'restored' draft with the counts (#41)", () =>
    Effect.sync(() => {
      const draft = toEventDraft(sample.RestoredAfterRestart);
      expect(draft?.kind).toBe("restored");
      expect(draft?.level).toBe("info");
      expect(draft?.message).toBe("restored after restart: 1 running, 2 retrying, 3 completed");
    }),
  );

  it.effect("is total over an arbitrary tag (property)", () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.constantFrom(...Object.keys(sample)), (tag) => {
          const draft = toEventDraft(sample[tag as Observation["_tag"]]);
          return draft === null || (draft.message.length > 0 && draft.kind.length > 0);
        }),
      );
    }),
  );
});

describe("RecentEvents ring", () => {
  it.effect("assigns a monotonic 1-based seq and keeps newest-last order", () =>
    Effect.gen(function* () {
      const ring = yield* makeRecentEvents(10);
      yield* ring.append({ level: "info", kind: "started", message: "a" });
      yield* ring.append({ level: "info", kind: "dispatched", message: "b" });
      yield* ring.append({ level: "warn", kind: "failed", message: "c" });
      const list = yield* ring.list;
      expect(list.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(list.map((e) => e.message)).toEqual(["a", "b", "c"]);
    }),
  );

  it.effect("bounds the ring to the cap, dropping oldest while seq keeps climbing", () =>
    Effect.gen(function* () {
      const ring = yield* makeRecentEvents(3);
      for (let i = 1; i <= 5; i += 1) {
        yield* ring.append({ level: "info", kind: "k", message: `m${i}` });
      }
      const list = yield* ring.list;
      expect(list).toHaveLength(3);
      expect(list.map((e) => e.message)).toEqual(["m3", "m4", "m5"]);
      expect(list.map((e) => e.seq)).toEqual([3, 4, 5]);
    }),
  );

  it.effect("truncates the message at ingestion and stamps a wall-clock ISO instant", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const ring = yield* makeRecentEvents();
      yield* ring.append({ level: "info", kind: "k", message: "x".repeat(5000) });
      const list = yield* ring.list;
      const env = list[0] as EventEnvelope;
      expect(env.message.length).toBeLessThanOrEqual(EVENT_MESSAGE_MAX);
      expect(env.emitted_at).toBe(new Date(0).toISOString());
    }),
  );
});

describe("observerTee", () => {
  it.effect("preserves structured logging AND appends drafts to the shared ring", () =>
    Effect.gen(function* () {
      const logged: Array<{ level: string; message: unknown }> = [];
      const capturing = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel.label, message });
      });

      yield* Effect.gen(function* () {
        const observer = yield* Observer;
        yield* observer.emit(sample.Dispatched);
        yield* observer.emit(sample.AgentEvent); // dropped from the feed, still logged
        yield* observer.emit(sample.WorkerFailed);

        // Same graph → same ring the tee wrote to.
        const events = yield* RecentEvents;
        const list = yield* events.list;
        expect(list.map((e) => e.kind)).toEqual(["dispatched", "failed"]);
        expect(list.map((e) => e.seq)).toEqual([1, 2]);
        expect(list[1]?.level).toBe("warn");

        // The AgentEvent is teed into LiveActivity instead of the feed (#37).
        const activity = yield* LiveActivity;
        const map = yield* activity.snapshot;
        expect(map.get("42")?.event_tag).toBe("AgentMessage");
      }).pipe(
        Effect.provide(ObservabilityLive),
        Effect.provide(Logger.replace(Logger.defaultLogger, capturing)),
      );

      // All three observations were logged (logging is unaffected by the feed filter).
      expect(logged).toHaveLength(3);
      expect(logged.map((l) => l.level)).toEqual(["INFO", "INFO", "WARN"]);
    }),
  );
});
