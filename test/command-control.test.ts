import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Queue, TestClock } from "effect";
import { describe, expect } from "vitest";
import { TurnFailed } from "../src/core/errors";
import { CommandBus } from "../src/core/orchestrator/command";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import { type Observation, Observer } from "../src/core/orchestrator/observer";
import { OrchestratorStore } from "../src/core/orchestrator/state";
import * as Ev from "./fakes/events";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import { buildDef, loopLayer, makeIssue, makeStateRef, TEST_ROOT, waitFor } from "./fakes/harness";
import { makeRecordingObserver } from "./fakes/recording-observer";

/**
 * Sprint 6 / #64 — operator control commands, driven through the real
 * {@link runOrchestrator} fiber under `TestClock`. Mirrors `budget-gate.test.ts`: every
 * command flows through the command bus → the single mailbox the owner fiber drains, so
 * these prove the operator-facing contract end-to-end and that in-flight work is never
 * collateral:
 *   - PauseDispatch withholds NEW dispatch while a seeded in-flight worker keeps running;
 *   - ResumeDispatch lets dispatch proceed again;
 *   - CancelSession interrupts ONLY the named worker and no other;
 *   - RetryNow fires a pending retry early, and is a typed no-op for an unknown id.
 */

const isDispatched =
  (issueId: string) =>
  (o: Observation): boolean =>
    o._tag === "Dispatched" && o.issueId === issueId;

describe("operator control commands (#64)", () => {
  it.scoped("PauseDispatch withholds new dispatch; an in-flight worker is untouched", () =>
    Effect.gen(function* () {
      const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const i2 = makeIssue({ id: "i2", identifier: "ORC-2", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [i1],
        states: [makeStateRef("i1", "In Progress"), makeStateRef("i2", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // i1 starts, streams, then stays in-flight for 60s before completing.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.turnCompleted({ total_tokens: 10 }),
        { _tag: "delay", ms: 60_000 },
        { _tag: "complete" },
      ]);

      const def = buildDef({
        maxConcurrent: 5,
        maxTurns: 1,
        intervalMs: 10_000,
        stallTimeoutMs: 300_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        // First tick dispatches i1 (no pause yet).
        yield* waitFor(obs.queue, isDispatched("i1"));

        // Operator pauses dispatch. The command is acked by the owner fiber.
        const paused = yield* bus.send({ _tag: "PauseDispatch" });
        expect(paused).toEqual({
          _tag: "Control",
          state: { dispatchPaused: true, pausedBy: "operator" },
        });
        yield* waitFor(obs.queue, (o) => o._tag === "OperatorControl" && o.paused);

        // i2 becomes a candidate, but dispatch is paused → it is withheld on every tick.
        yield* tracker.control.setCandidates([i2]);
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, (o) => o._tag === "TickEnd" && o.dispatchSkipped);

        // The in-flight i1 worker is untouched — let its 60s delay elapse; it completes.
        yield* TestClock.adjust(Duration.millis(60_000));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const overState = yield* (yield* OrchestratorStore).get;
        expect(overState.completed).toContain("i1");
        // New dispatch was withheld: i2 never ran while paused.
        let runs = yield* runner.control.runs;
        expect(runs.map((r) => r.issueId)).toEqual(["i1"]);
        expect(overState.running.i2).toBeUndefined();

        // Resume → dispatch proceeds and i2 finally runs on the next tick.
        const resumed = yield* bus.send({ _tag: "ResumeDispatch" });
        expect(resumed).toEqual({
          _tag: "Control",
          state: { dispatchPaused: false, pausedBy: null },
        });
        yield* runner.control.pushScript("i2", [Ev.sessionStarted("s2"), { _tag: "complete" }]);
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, isDispatched("i2"));
        runs = yield* runner.control.runs;
        expect(runs.map((r) => r.issueId).sort()).toEqual(["i1", "i2"]);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("CancelSession interrupts only the named worker", () =>
    Effect.gen(function* () {
      const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const i2 = makeIssue({ id: "i2", identifier: "ORC-2", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [i1, i2],
        states: [makeStateRef("i1", "In Progress"), makeStateRef("i2", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // Both workers stay in-flight indefinitely (long delay) until cancelled/torn down.
      for (const id of ["i1", "i2"]) {
        yield* runner.control.pushScript(id, [
          Ev.sessionStarted(`s-${id}`),
          { _tag: "delay", ms: 600_000 },
          { _tag: "complete" },
        ]);
      }

      const def = buildDef({
        maxConcurrent: 5,
        maxTurns: 1,
        intervalMs: 10_000,
        stallTimeoutMs: 3_600_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        yield* waitFor(obs.queue, isDispatched("i1"));
        yield* waitFor(obs.queue, isDispatched("i2"));
        const before = yield* (yield* OrchestratorStore).get;
        expect(before.running.i1).toBeDefined();
        expect(before.running.i2).toBeDefined();

        // Cancel ONLY i1.
        const ack = yield* bus.send({ _tag: "CancelSession", issueId: "i1" });
        expect(ack).toEqual({ _tag: "Ack", accepted: true, reason: null });
        yield* waitFor(obs.queue, (o) => o._tag === "SessionCancelled" && o.issueId === "i1");

        const after = yield* (yield* OrchestratorStore).get;
        // i1 was released; i2's worker is untouched and still running.
        expect(after.running.i1).toBeUndefined();
        expect(after.claimed).not.toContain("i1");
        expect(after.completed).not.toContain("i1");
        expect(after.running.i2).toBeDefined();

        // Cancelling an unknown id is a typed no-op.
        const miss = yield* bus.send({ _tag: "CancelSession", issueId: "nope" });
        expect(miss).toEqual({
          _tag: "Ack",
          accepted: false,
          reason: "no such tracked issue",
        });

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("RetryNow fires a pending retry early; unknown id is a typed no-op", () =>
    Effect.gen(function* () {
      const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [i1],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // First attempt fails → schedules a (long-backoff) failure retry; second attempt
      // succeeds once retry-now fires it early.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "fail", error: new TurnFailed({ message: "boom" }) },
      ]);
      yield* runner.control.pushScript("i1", [Ev.sessionStarted("s2"), { _tag: "complete" }]);

      const def = buildDef({
        maxConcurrent: 5,
        maxTurns: 1,
        intervalMs: 10_000,
        maxRetryBackoffMs: 300_000,
        stallTimeoutMs: 3_600_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        yield* waitFor(obs.queue, isDispatched("i1"));
        // The first attempt fails and a retry is scheduled with a long backoff.
        yield* waitFor(obs.queue, (o) => o._tag === "RetryScheduled" && o.issueId === "i1");

        const pending = yield* (yield* OrchestratorStore).get;
        expect(pending.retry_attempts.i1).toBeDefined();

        // Unknown id → typed no-op.
        const miss = yield* bus.send({ _tag: "RetryNow", issueId: "nope" });
        expect(miss).toEqual({
          _tag: "Ack",
          accepted: false,
          reason: "no such tracked issue",
        });

        // Fire the pending retry NOW (without waiting out the 300s backoff).
        const ack = yield* bus.send({ _tag: "RetryNow", issueId: "i1" });
        expect(ack).toEqual({ _tag: "Ack", accepted: true, reason: null });
        // The retry fired and re-dispatched i1; the second attempt completes.
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const done = yield* (yield* OrchestratorStore).get;
        expect(done.completed).toContain("i1");
        expect(done.retry_attempts.i1).toBeUndefined();
        const runs = yield* runner.control.runs;
        expect(runs.filter((r) => r.issueId === "i1")).toHaveLength(2);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  // Regression (exactly-once): a `RetryNow` that fires the backoff just as the timer's own
  // `RetryDue` lands must NOT double-dispatch. The window: the backoff timer has already
  // offered its `RetryDue` (so `RetryNow`'s interrupt is a no-op) but the owner drains the
  // `RetryNow` first; `handleRetryDue` must drop the now-stale `RetryDue` rather than
  // dispatch a second worker and orphan the first. We force the interleaving deterministically
  // by stalling the owner INSIDE the `RetryScheduled` emit (so the mailbox cannot drain) while
  // the `RetryNow` is queued ahead of the timer's `RetryDue`, then releasing it.
  it.scoped("RetryNow racing a fired backoff timer dispatches exactly one worker", () =>
    Effect.gen(function* () {
      const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [i1],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);

      // Gated observer: record to a queue (like RecordingObserver) but block the owner fiber
      // when it emits `RetryScheduled`, so a stale `RetryDue` can be queued behind a `RetryNow`
      // while the single-consumer mailbox is unable to drain.
      const queue = yield* Queue.unbounded<Observation>();
      const gate = yield* Deferred.make<void>();
      const obsLayer = Layer.succeed(Observer, {
        emit: (obs: Observation) =>
          Queue.offer(queue, obs).pipe(
            Effect.zipRight(obs._tag === "RetryScheduled" ? Deferred.await(gate) : Effect.void),
            Effect.asVoid,
          ),
      });

      // Attempt 1 fails → schedules a (near-zero backoff) failure retry; attempts 2 and 3 are
      // long-running, so a buggy double-dispatch shows up as a THIRD run for i1.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "fail", error: new TurnFailed({ message: "boom" }) },
      ]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s2"),
        { _tag: "delay", ms: 60_000 },
        { _tag: "complete" },
      ]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s3"),
        { _tag: "delay", ms: 60_000 },
        { _tag: "complete" },
      ]);

      const def = buildDef({
        maxConcurrent: 5,
        maxTurns: 1,
        intervalMs: 10_000,
        maxRetryBackoffMs: 1, // near-zero backoff so a 1ms tick fires the timer
        stallTimeoutMs: 3_600_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obsLayer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        yield* waitFor(queue, isDispatched("i1"));
        // Owner is now STALLED inside the `RetryScheduled` emit; the backoff timer is armed.
        yield* waitFor(queue, (o) => o._tag === "RetryScheduled" && o.issueId === "i1");

        // Queue `RetryNow` into the mailbox ahead of the timer (the pump is sleepless, so this
        // lands without advancing the clock).
        const sendFiber = yield* Effect.forkScoped(bus.send({ _tag: "RetryNow", issueId: "i1" }));
        yield* Effect.yieldNow().pipe(Effect.repeatN(10));

        // Fire the armed timer: it offers its (now stale) `RetryDue` BEHIND the `RetryNow`.
        yield* TestClock.adjust(Duration.millis(1));

        // Release the owner: it drains `RetryNow` (re-dispatch), then the stale `RetryDue`.
        yield* Deferred.succeed(gate, undefined);
        const ack = yield* Fiber.join(sendFiber);
        expect(ack).toEqual({ _tag: "Ack", accepted: true, reason: null });
        yield* Effect.yieldNow().pipe(Effect.repeatN(20));

        // Exactly-once: one initial run + one retry = two runs. A stale `RetryDue` that
        // double-dispatched would orphan a worker and show a third run.
        const runs = yield* runner.control.runs;
        expect(runs.filter((r) => r.issueId === "i1")).toHaveLength(2);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
