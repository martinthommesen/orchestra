import { it } from "@effect/vitest";
import { Effect, HashMap, Logger, type LogLevel, Option } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { formatObservation, ObserverLive } from "../src/core/observability/live-observer";
import type { Observation } from "../src/core/orchestrator/observer";
import { Observer } from "../src/core/orchestrator/observer";

/**
 * Task 12 — structured observability. {@link formatObservation} is pure, so we cover the
 * whole {@link Observation} union exhaustively for shape (required context fields,
 * level) and prove that {@link ObserverLive} actually emits log records carrying those
 * annotations through Effect's logging pipeline (logfmt-compatible).
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
  BudgetExceeded: { _tag: "BudgetExceeded", paused: true, limitTokens: 1000, spentTokens: 1200 },
  OperatorControl: { _tag: "OperatorControl", paused: true },
  SessionCancelled: { _tag: "SessionCancelled", issueId: "42", identifier: "#42" },
  RetryNowRequested: { _tag: "RetryNowRequested", issueId: "42", accepted: true },
};

describe("formatObservation", () => {
  it.effect("covers every Observation tag with an event annotation", () =>
    Effect.sync(() => {
      for (const obs of Object.values(sample)) {
        const line = formatObservation(obs);
        expect(line.level === "info" || line.level === "warn").toBe(true);
        expect(line.message.length).toBeGreaterThan(0);
        expect(typeof line.annotations.event).toBe("string");
        expect((line.annotations.event ?? "").length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("carries issue context fields where the observation has them", () =>
    Effect.sync(() => {
      const dispatched = formatObservation(sample.Dispatched);
      expect(dispatched.annotations.issue_id).toBe("42");
      expect(dispatched.annotations.issue_identifier).toBe("#42");

      const agent = formatObservation(sample.AgentEvent);
      expect(agent.annotations.session_id).toBe("sess-1");

      const failed = formatObservation(sample.WorkerFailed);
      expect(failed.level).toBe("warn");
    }),
  );

  it.effect("humanizes the AgentEvent line while keeping the raw event_tag (#55)", () =>
    Effect.sync(() => {
      const line = formatObservation(sample.AgentEvent);
      // Friendly summary in the human-readable message…
      expect(line.message).toContain("working");
      expect(line.message).not.toContain("AgentMessage");
      // …raw tag retained on the wire for fidelity/debugging.
      expect(line.annotations.event_tag).toBe("AgentMessage");

      // Unknown tag falls back to the raw label, never blank.
      const unknown = formatObservation({
        _tag: "AgentEvent",
        issueId: "1",
        identifier: "#1",
        sessionId: null,
        eventTag: "SomeFutureTag",
      });
      expect(unknown.message).toContain("SomeFutureTag");
      expect(unknown.annotations.event_tag).toBe("SomeFutureTag");
    }),
  );

  it.effect("never overflows: long messages are truncated", () =>
    Effect.sync(() => {
      const line = formatObservation({
        _tag: "WorkerFailed",
        issueId: "1",
        identifier: "#1",
        message: "x".repeat(5000),
      });
      expect(line.message.length).toBeLessThan(500);
      expect((line.annotations.message ?? "").length).toBeLessThanOrEqual(121);
    }),
  );

  it.effect("is total over an arbitrary tag (property)", () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.constantFrom(...Object.keys(sample)), (tag) => {
          const line = formatObservation(sample[tag as Observation["_tag"]]);
          return typeof line.annotations.event === "string" && line.message.length > 0;
        }),
      );
    }),
  );
});

describe("ObserverLive", () => {
  it.effect("emits a log record carrying the formatted annotations", () =>
    Effect.gen(function* () {
      const captured: Array<{
        level: LogLevel.LogLevel;
        annotations: HashMap.HashMap<string, unknown>;
      }> = [];
      const capturing = Logger.make(({ logLevel, annotations }) => {
        captured.push({ level: logLevel, annotations });
      });

      yield* Effect.gen(function* () {
        const observer = yield* Observer;
        yield* observer.emit(sample.Dispatched);
        yield* observer.emit(sample.WorkerFailed);
      }).pipe(
        Effect.provide(ObserverLive),
        Effect.provide(Logger.replace(Logger.defaultLogger, capturing)),
      );

      const anno = (i: number, key: string) =>
        Option.getOrUndefined(HashMap.get(captured[i]?.annotations ?? HashMap.empty(), key));

      expect(captured).toHaveLength(2);
      expect(anno(0, "event")).toBe("dispatched");
      expect(anno(0, "issue_identifier")).toBe("#42");
      expect(anno(1, "event")).toBe("worker_failed");
      expect(captured[1]?.level.label).toBe("WARN");
    }),
  );
});
