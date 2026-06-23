import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import { TurnFailed } from "../src/core/errors";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import type { Observation } from "../src/core/orchestrator/observer";
import { OrchestratorStore } from "../src/core/orchestrator/state";
import * as Ev from "./fakes/events";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import { buildDef, loopLayer, makeIssue, makeStateRef, TEST_ROOT, waitFor } from "./fakes/harness";
import { makeRecordingObserver } from "./fakes/recording-observer";

/**
 * Sprint 1, Task 11 (full-loop scenarios) — drives the real {@link runOrchestrator}
 * single fiber against the Task 10 fakes under `TestClock`, proving the end-to-end
 * control loop deterministically: dispatch→success, continuation turns, failure backoff,
 * terminal kill + workspace cleanup, stall detection + retry, and concurrency requeue.
 * Stepping is done by `waitFor` on the recording observer (never bare sleeps), with
 * `TestClock.adjust` only to fire the loop's own timers.
 */

const isDispatched =
  (issueId: string, turn?: number) =>
  (o: Observation): boolean =>
    o._tag === "Dispatched" && o.issueId === issueId && (turn === undefined || o.turn === turn);

describe("orchestrator loop (fakes + TestClock)", () => {
  it.scoped("dispatch → success: single turn completes and is recorded", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.agentMessage("working"),
        Ev.turnCompleted({ total_tokens: 7 }),
        { _tag: "complete" },
      ]);

      const def = buildDef({ maxTurns: 1 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toContain("i1");
        expect(state.running.i1).toBeUndefined();
        expect(state.agent_totals.total_tokens).toBe(7);

        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(1);
        expect(runs[0]?.attempt).toBeNull();
        expect(runs[0]?.prompt).toContain("ORC-1");

        const hooks = yield* wsm.control.hooks;
        expect(hooks.map((h) => h.hook)).toContain("before_run");
        expect(hooks.map((h) => h.hook)).toContain("after_run");

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("dispatch → continuation: second turn resumes the session", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.turnCompleted(),
        { _tag: "complete" },
      ]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.turnCompleted(),
        { _tag: "complete" },
      ]);

      const def = buildDef({ maxTurns: 2 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        // turn 1 finishes and a continuation is scheduled
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "continuation",
        );
        // fire the fixed continuation delay (1s)
        yield* TestClock.adjust(Duration.millis(1_100));
        yield* waitFor(obs.queue, isDispatched("i1", 2));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(2);
        expect(runs[1]?.resumeSessionId).toBe("s1");

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("failure → exponential backoff retry then success", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "fail", error: new TurnFailed({ message: "boom" }) },
      ]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s2"),
        Ev.turnCompleted(),
        { _tag: "complete" },
      ]);

      const def = buildDef({ maxTurns: 1 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        const failed = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerFailed" && o.issueId === "i1",
        );
        expect(failed._tag === "WorkerFailed" && failed.message).toContain("boom");
        const scheduled = yield* waitFor(
          obs.queue,
          (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "failure",
        );
        expect(scheduled._tag === "RetryScheduled" && scheduled.delayMs).toBe(10_000);

        // fire the 10s backoff
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, isDispatched("i1"));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(2);
        expect(runs[1]?.attempt).toBe(1);
        expect(runs[1]?.resumeSessionId).toBeNull();

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("reconcile terminal → kill worker, clean workspace, mark completed", () =>
    Effect.gen(function* () {
      const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [issue],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // worker starts a session then hangs — only reconciliation can end it
      yield* runner.control.pushScript("i1", [Ev.sessionStarted("s1"), { _tag: "stall" }]);

      const def = buildDef({ maxTurns: 5, intervalMs: 30_000, stallTimeoutMs: 300_000 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        yield* waitFor(obs.queue, isDispatched("i1"));
        // the issue is closed out in the tracker
        yield* tracker.control.setStateOf("i1", "Done");
        // next poll tick reconciles and kills it
        yield* TestClock.adjust(Duration.millis(30_000));
        const killed = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
        );
        expect(killed._tag === "WorkerKilled" && killed.reason).toBe("terminal");
        yield* waitFor(obs.queue, (o) => o._tag === "WorkspaceCleaned" && o.issueId === "i1");

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toContain("i1");
        expect(state.running.i1).toBeUndefined();

        const removed = yield* wsm.control.removed;
        expect(removed).toContain("ORC-1");

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("reconcile stall → kill worker and schedule a failure retry", () =>
    Effect.gen(function* () {
      const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [issue],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [Ev.sessionStarted("s1"), { _tag: "stall" }]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s2"),
        Ev.turnCompleted(),
        { _tag: "complete" },
      ]);

      const def = buildDef({ maxTurns: 1, intervalMs: 10_000, stallTimeoutMs: 5_000 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        yield* waitFor(obs.queue, isDispatched("i1"));
        // poll tick at 10s: 10s of inactivity > 5s stall timeout → kill
        yield* TestClock.adjust(Duration.millis(10_000));
        const killed = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
        );
        expect(killed._tag === "WorkerKilled" && killed.reason).toBe("stall");
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "failure",
        );
        // fire the backoff and let the retry attempt complete
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const runs = yield* runner.control.runs;
        expect(runs.length).toBeGreaterThanOrEqual(2);
        expect(runs[1]?.attempt).toBe(1);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("concurrency cap of 1 dispatches one issue, requeues the next after a slot frees", () =>
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
      // both hang so the slot stays occupied until we close i1 out
      yield* runner.control.pushScript("i1", [Ev.sessionStarted("s1"), { _tag: "stall" }]);
      yield* runner.control.pushScript("i2", [Ev.sessionStarted("s2"), { _tag: "stall" }]);

      const def = buildDef({
        maxConcurrent: 1,
        maxTurns: 5,
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
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        // first tick: only one of the two eligible issues dispatches
        const tickEnd = yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
        expect(tickEnd._tag === "TickEnd" && tickEnd.dispatched).toEqual(["i1"]);

        // close i1 out in the tracker and drop it from candidates (it's terminal now)
        yield* tracker.control.setStateOf("i1", "Done");
        yield* tracker.control.setCandidates([i2]);

        // next tick: i1 is reconciled away, freeing the slot for i2
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, isDispatched("i2"));

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toContain("i1");
        expect(state.running.i2).toBeDefined();

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
