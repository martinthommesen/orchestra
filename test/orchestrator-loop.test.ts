import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import { TrackerApiRequest, TurnFailed } from "../src/core/errors";
import { RecentCompletions } from "../src/core/observability/recent-completions";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import type { Observation } from "../src/core/orchestrator/observer";
import { OrchestratorStore } from "../src/core/orchestrator/state";
import * as Ev from "./fakes/events";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import {
  buildDef,
  drain,
  loopLayer,
  makeIssue,
  makeStateRef,
  TEST_ROOT,
  waitFor,
} from "./fakes/harness";
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

        // #37: the natural completion is also recorded into the rich-completion ring,
        // with wall-clock finished_at + outcome (kept OUT of the IDs-only `completed`).
        const completions = yield* RecentCompletions;
        const recent = yield* completions.list;
        expect(recent.map((c) => c.issue_id)).toContain("i1");
        expect(recent.find((c) => c.issue_id === "i1")?.outcome).toBe("completed");

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
        states: [makeStateRef("i1", "Todo")],
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

  it.scoped("failure retry cap parks the issue and prevents re-dispatch burn", () =>
    Effect.gen(function* () {
      const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" });
      const tracker = yield* makeFakeTracker({
        candidates: [issue],
        states: [makeStateRef("i1", "Todo")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "fail", error: new TurnFailed({ message: "boom-1" }) },
      ]);
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s2"),
        { _tag: "fail", error: new TurnFailed({ message: "boom-2" }) },
      ]);
      // If the issue is incorrectly released after the cap, this third script will run.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s3"),
        Ev.turnCompleted(),
        { _tag: "complete" },
      ]);

      const def = buildDef({ maxTurns: 1, maxFailureRetries: 1, intervalMs: 5_000 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        const store = yield* OrchestratorStore;

        yield* waitFor(obs.queue, isDispatched("i1"));
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "failure",
        );
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, isDispatched("i1"));
        // Cleanup is now awaited before parking, so WorkspaceCleaned precedes WorkerAbandoned.
        yield* waitFor(obs.queue, (o) => o._tag === "WorkspaceCleaned" && o.issueId === "i1");
        const abandoned = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerAbandoned" && o.issueId === "i1",
        );
        expect(abandoned._tag === "WorkerAbandoned" && abandoned.attempts).toBe(2);

        const parked = yield* store.get;
        expect(parked.running.i1).toBeUndefined();
        expect(parked.retry_attempts.i1).toBeUndefined();
        expect(parked.abandoned.i1?.reason).toContain("boom-2");
        expect(parked.claimed).toContain("i1");
        expect(yield* wsm.control.removed).toContain("ORC-1");

        // The tracker still reports the issue active. A later poll must keep it parked
        // instead of dispatching the third queued script.
        yield* drain(obs.queue);
        yield* TestClock.adjust(Duration.millis(30_000));
        yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(2);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped("max_failure_retries=0 parks on the FIRST failure (fail-fast, no retry)", () =>
    Effect.gen(function* () {
      const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" });
      const tracker = yield* makeFakeTracker({
        candidates: [issue],
        states: [makeStateRef("i1", "Todo")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "fail", error: new TurnFailed({ message: "boom-1" }) },
      ]);
      // If the cap were not fail-fast, a retry would dispatch this second script.
      yield* runner.control.pushScript("i1", [Ev.sessionStarted("s2"), { _tag: "complete" }]);

      const def = buildDef({ maxTurns: 1, maxFailureRetries: 0, intervalMs: 5_000 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        const store = yield* OrchestratorStore;

        yield* waitFor(obs.queue, isDispatched("i1"));
        const abandoned = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerAbandoned" && o.issueId === "i1",
        );
        // First (and only) failure: attempts crosses max=0 immediately.
        expect(abandoned._tag === "WorkerAbandoned" && abandoned.attempts).toBe(1);

        const parked = yield* store.get;
        expect(parked.abandoned.i1?.reason).toContain("boom-1");
        expect(parked.claimed).toContain("i1");

        // No retry was ever scheduled, and the second script never runs.
        yield* drain(obs.queue);
        yield* TestClock.adjust(Duration.millis(30_000));
        yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(1);

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

  // ── #17 regression (#22 live concurrency invariant) ──────────────────────────────
  it.scoped(
    "concurrency cap is held across a retry backoff: a retrying issue reserves its slot (Fixes #17)",
    () =>
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
        // i1 fails the first turn (→ failure backoff), then succeeds on the retry.
        yield* runner.control.pushScript("i1", [
          Ev.sessionStarted("s1"),
          { _tag: "fail", error: new TurnFailed({ message: "boom" }) },
        ]);
        yield* runner.control.pushScript("i1", [
          Ev.sessionStarted("s2"),
          Ev.turnCompleted(),
          { _tag: "complete" },
        ]);
        // i2 would hang forever if it were ever (wrongly) admitted into the cap-1 slot.
        yield* runner.control.pushScript("i2", [Ev.sessionStarted("s9"), { _tag: "stall" }]);

        const def = buildDef({
          maxConcurrent: 1,
          maxTurns: 1,
          intervalMs: 5_000,
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
          const store = yield* OrchestratorStore;

          // tick1 dispatches only i1 (cap = 1); it then fails and schedules a backoff.
          yield* waitFor(obs.queue, isDispatched("i1", 1));
          yield* waitFor(obs.queue, (o) => o._tag === "WorkerFailed" && o.issueId === "i1");
          yield* waitFor(
            obs.queue,
            (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "failure",
          );

          // Mid-backoff i1 holds no worker — but it MUST still reserve its slot.
          const backoff = yield* store.get;
          expect(Object.keys(backoff.running)).toEqual([]);
          expect(backoff.retry_attempts.i1).toBeDefined();

          // A poll tick lands inside the backoff window. Pre-fix this over-admitted i2
          // into the apparently-free slot (cap=1 → 2 in flight); post-fix the retrying
          // issue reserves the slot so nothing is dispatched.
          yield* TestClock.adjust(Duration.millis(5_000));
          const tick2 = yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
          expect(tick2._tag === "TickEnd" && tick2.dispatched).toEqual([]);

          const afterTick = yield* store.get;
          expect(Object.keys(afterTick.running).length).toBeLessThanOrEqual(1);
          expect(afterTick.running.i2).toBeUndefined();

          // Fire the backoff: i1 re-dispatches into its own slot and completes; i2 never runs.
          yield* TestClock.adjust(Duration.millis(5_000));
          yield* waitFor(obs.queue, isDispatched("i1"));
          yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

          const done = yield* store.get;
          expect(done.completed).toContain("i1");
          expect(done.running.i2).toBeUndefined();
          const runs = yield* runner.control.runs;
          expect(runs.filter((r) => r.issueId === "i2")).toHaveLength(0);

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  it.scoped(
    "a retrying issue that goes terminal mid-backoff is reconciled, not re-dispatched (Fixes #17)",
    () =>
      Effect.gen(function* () {
        const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
        const tracker = yield* makeFakeTracker({
          candidates: [i1],
          states: [makeStateRef("i1", "In Progress")],
        });
        const runner = yield* makeFakeAgentRunner();
        const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
        const obs = yield* makeRecordingObserver();
        // i1 fails once → schedules a 10s failure backoff. A second run must never happen.
        yield* runner.control.pushScript("i1", [
          Ev.sessionStarted("s1"),
          { _tag: "fail", error: new TurnFailed({ message: "boom" }) },
        ]);

        const def = buildDef({
          maxConcurrent: 5,
          maxTurns: 1,
          intervalMs: 5_000,
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
          const store = yield* OrchestratorStore;

          yield* waitFor(obs.queue, isDispatched("i1"));
          yield* waitFor(
            obs.queue,
            (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "failure",
          );

          // The issue is closed in the tracker while i1 is mid-backoff.
          yield* tracker.control.setStateOf("i1", "Done");
          yield* tracker.control.setCandidates([]);

          // Next poll tick: reconcile now SEES the retrying issue and kills it (cancelling
          // the pending retry) instead of letting the backoff fire a wasted dispatch.
          yield* TestClock.adjust(Duration.millis(5_000));
          const killed = yield* waitFor(
            obs.queue,
            (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
          );
          expect(killed._tag === "WorkerKilled" && killed.reason).toBe("terminal");
          yield* waitFor(obs.queue, (o) => o._tag === "WorkspaceCleaned" && o.issueId === "i1");

          const afterKill = yield* store.get;
          expect(afterKill.completed).toContain("i1");
          expect(afterKill.retry_attempts.i1).toBeUndefined();

          // Advance well past where the 10s backoff would have fired: still exactly one run.
          yield* TestClock.adjust(Duration.millis(20_000));
          const runs = yield* runner.control.runs;
          expect(runs).toHaveLength(1);

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  // ── #82 AgentProgress liveness pulses ──────────────────────────────────────────

  it.scoped(
    "AgentProgress pulses prevent stall kill: a worker quiet between pulses is not killed (#82)",
    () =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
        const tracker = yield* makeFakeTracker({
          candidates: [issue],
          states: [makeStateRef("i1", "In Progress")],
        });
        const runner = yield* makeFakeAgentRunner();
        const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
        const obs = yield* makeRecordingObserver();
        // Worker: agentProgress pulses 2s apart (< 5s stall timeout), with an AgentMessage
        // as a synchronization sentinel after the second pulse. The sentinel creates an
        // AgentEvent observer observation we can waitFor, which guarantees the preceding
        // agentProgress has already been processed (and lastEventAt refreshed) before we
        // let the reconcile tick fire in phase 2.
        yield* runner.control.pushScript("i1", [
          Ev.agentProgress(), // immediate pulse
          { _tag: "delay", ms: 2_000 }, // 2s quiet gap (< stall 5s)
          Ev.agentProgress(), // second pulse
          Ev.agentMessage("still working"), // sync sentinel: produces AgentEvent obs
          { _tag: "delay", ms: 2_000 }, // 2s more simulated tool work
          Ev.agentProgress(), // third pulse
          Ev.turnCompleted(),
          { _tag: "complete" },
        ]);

        // Poll every 3.5s; stall if silent for 5s. The 3.5s interval is chosen so that
        // the first reconcile tick fires at t=3500 (while the worker is still live and
        // claimed) and the SECOND tick falls at t=7000, which is beyond the total
        // adjust(6000) window — preventing a spurious re-dispatch after completion.
        const def = buildDef({ maxTurns: 1, intervalMs: 3_500, stallTimeoutMs: 5_000 });
        const env = loopLayer(def, {
          tracker: tracker.layer,
          runner: runner.layer,
          workspace: wsm.layer,
          observer: obs.layer,
        });

        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(runOrchestrator(def));
          yield* waitFor(obs.queue, isDispatched("i1"));

          // Phase 1: advance 2s — fires delay(2000), emitting the second agentProgress
          // and then the AgentMessage sentinel. Wait for the AgentEvent obs from the
          // sentinel: by then the preceding agentProgress is guaranteed processed, so
          // lastEventAt is fresh (≤ 2000ms ago) before the reconcile tick fires.
          yield* TestClock.adjust(Duration.millis(2_000));
          yield* waitFor(obs.queue, (o) => o._tag === "AgentEvent");

          // Phase 2: advance 4s more (total 6s). Interval fires at t=3.5s → Tick →
          // reconcile: lastEventAt≈2000, gap < stall threshold → no stall. Worker
          // completes at t=4s. The next interval tick is at t=7s (outside this window).
          yield* TestClock.adjust(Duration.millis(4_000));
          yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

          // Exactly one run — no stall-retry was triggered.
          const runs = yield* runner.control.runs;
          expect(runs).toHaveLength(1);

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  it.scoped(
    "stall detection still fires for a genuinely silent worker (fix does not disable it, #82)",
    () =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
        const tracker = yield* makeFakeTracker({
          candidates: [issue],
          states: [makeStateRef("i1", "In Progress")],
        });
        const runner = yield* makeFakeAgentRunner();
        const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
        const obs = yield* makeRecordingObserver();
        // Worker emits NO events at all — completely silent subprocess.
        yield* runner.control.pushScript("i1", [{ _tag: "stall" }]);

        // Stall timeout 5s; poll every 6s — reconcile sees 6s of silence > 5s → StallKill.
        const def = buildDef({ maxTurns: 1, intervalMs: 6_000, stallTimeoutMs: 5_000 });
        const env = loopLayer(def, {
          tracker: tracker.layer,
          runner: runner.layer,
          workspace: wsm.layer,
          observer: obs.layer,
        });

        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(runOrchestrator(def));
          yield* waitFor(obs.queue, isDispatched("i1"));
          yield* TestClock.adjust(Duration.millis(6_000));
          const killed = yield* waitFor(
            obs.queue,
            (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
          );
          expect(killed._tag === "WorkerKilled" && killed.reason).toBe("stall");

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  // ── #81 continuation racing a handoff ────────────────────────────────────────

  it.scoped(
    "continuation racing a terminal handoff is reconciled, not re-dispatched (Fixes #81)",
    () =>
      Effect.gen(function* () {
        const tracker = yield* makeFakeTracker({
          candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
          states: [makeStateRef("i1", "In Progress")],
        });
        const runner = yield* makeFakeAgentRunner();
        const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
        const obs = yield* makeRecordingObserver();
        // Only ONE script: turn 2 must never run.
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
          const store = yield* OrchestratorStore;

          // Wait for turn 1 to finish and a continuation to be scheduled.
          yield* waitFor(
            obs.queue,
            (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "continuation",
          );

          // Hand off to a human BEFORE the continuation fires (within the 1s window).
          yield* tracker.control.setStateOf("i1", "Done");

          // Advance only the continuation delay — well under the 30s poll interval,
          // so NO reconcile tick runs; the continuation must guard itself.
          yield* TestClock.adjust(Duration.millis(1_100));

          const killed = yield* waitFor(
            obs.queue,
            (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
          );
          expect(killed._tag === "WorkerKilled" && killed.reason).toBe("terminal");

          // Turn 2 was never dispatched.
          const runs = yield* runner.control.runs;
          expect(runs).toHaveLength(1);

          // Issue is completed (not just released).
          const state = yield* store.get;
          expect(state.completed).toContain("i1");

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  it.scoped("continuation is fail-open: a tracker error does not block turn N+1 (Fixes #81)", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // Two scripts: turn 2 MUST run because the guard is fail-open.
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

        // Wait for the continuation to be scheduled, then inject a tracker error.
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "RetryScheduled" && o.issueId === "i1" && o.kind === "continuation",
        );
        yield* tracker.control.failStatesRefresh(
          new TrackerApiRequest({ message: "network blip" }),
        );

        // Advance just the continuation delay — the guard should fail-open and proceed.
        yield* TestClock.adjust(Duration.millis(1_100));

        // A TrackerError with op "fetchIssueStatesByIds" must be emitted (fail-open signal).
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "TrackerError" && o.op === "fetchIssueStatesByIds",
        );

        // Turn 2 is still dispatched despite the tracker error.
        yield* waitFor(obs.queue, isDispatched("i1", 2));
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(2);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
