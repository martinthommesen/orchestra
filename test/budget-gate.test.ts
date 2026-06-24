import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, Queue, TestClock } from "effect";
import { describe, expect } from "vitest";
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
 * Sprint 5 / #53 — the **budget guardrail** dispatch gate, driven through the real
 * {@link runOrchestrator} fiber under `TestClock`. These prove the operator-facing
 * contract end-to-end:
 *   - under the ceiling (or no ceiling) NEW dispatch proceeds exactly as before;
 *   - at/over the ceiling NEW dispatch is withheld, while a seeded in-flight worker is
 *     **never touched** and still completes + reconciles;
 *   - the paused observation fires **once per transition**, not every tick.
 * The pure evaluator + snapshot/view-model shape are covered in `budget-pure.test.ts`.
 */

const isDispatched =
  (issueId: string) =>
  (o: Observation): boolean =>
    o._tag === "Dispatched" && o.issueId === issueId;

const isPaused = (o: Observation): boolean => o._tag === "BudgetExceeded" && o.paused;

const isSkippedTickEnd = (o: Observation): boolean => o._tag === "TickEnd" && o.dispatchSkipped;

/** Take observations into an array until (and including) the first match of `pred`. */
const collectUntil = (
  queue: Queue.Dequeue<Observation>,
  pred: (o: Observation) => boolean,
): Effect.Effect<ReadonlyArray<Observation>> =>
  Effect.gen(function* () {
    const acc: Observation[] = [];
    let done = false;
    while (!done) {
      const o = yield* Queue.take(queue);
      acc.push(o);
      done = pred(o);
    }
    return acc;
  });

describe("budget guardrail dispatch gate (#53)", () => {
  it.scoped("under ceiling → dispatch proceeds, no pause observation", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.turnCompleted({ total_tokens: 50 }),
        { _tag: "complete" },
      ]);

      // Ceiling well above the 50 tokens i1 will report.
      const def = buildDef({ maxTurns: 1, budgetMaxTotalTokens: 1_000 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        const seen = yield* collectUntil(
          obs.queue,
          (o) => o._tag === "WorkerCompleted" && o.issueId === "i1",
        );

        // Dispatch happened normally; the guard never paused (spend < ceiling).
        expect(seen.some(isDispatched("i1"))).toBe(true);
        expect(seen.some((o) => o._tag === "BudgetExceeded")).toBe(false);

        const state = yield* (yield* OrchestratorStore).get;
        expect(state.completed).toContain("i1");
        expect(state.agent_totals.total_tokens).toBe(50);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scoped(
    "at/over ceiling → NEW dispatch withheld, but an in-flight worker is untouched and completes",
    () =>
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
        // i1 reports usage that BLOWS the ceiling, then stays in-flight for 60s before
        // completing — so when i2 becomes a candidate the budget is already exceeded.
        yield* runner.control.pushScript("i1", [
          Ev.sessionStarted("s1"),
          Ev.turnCompleted({ total_tokens: 50 }),
          { _tag: "delay", ms: 60_000 },
          { _tag: "complete" },
        ]);

        const def = buildDef({
          maxConcurrent: 5,
          maxTurns: 1,
          intervalMs: 10_000,
          stallTimeoutMs: 300_000,
          budgetMaxTotalTokens: 10,
        });
        const env = loopLayer(def, {
          tracker: tracker.layer,
          runner: runner.layer,
          workspace: wsm.layer,
          observer: obs.layer,
        });

        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(runOrchestrator(def));

          // First tick: budget still under (spend 0) → i1 dispatches.
          yield* waitFor(obs.queue, isDispatched("i1"));
          // Wait until i1's TurnCompleted usage is folded into agent_totals.
          yield* waitFor(
            obs.queue,
            (o) => o._tag === "AgentEvent" && o.issueId === "i1" && o.eventTag === "TurnCompleted",
          );
          const overState = yield* (yield* OrchestratorStore).get;
          expect(overState.agent_totals.total_tokens).toBe(50);

          // i2 is now eligible — but spend (50) ≥ ceiling (10).
          yield* tracker.control.setCandidates([i2]);
          yield* TestClock.adjust(Duration.millis(10_000));
          // The very next tick crosses into paused and skips dispatch.
          yield* waitFor(obs.queue, isPaused);

          // Let i1's in-flight worker finish (the 60s delay elapses).
          yield* TestClock.adjust(Duration.millis(60_000));
          yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

          const state = yield* (yield* OrchestratorStore).get;
          // In-flight work was untouched: i1 finished and reconciled exactly as normal.
          expect(state.completed).toContain("i1");
          expect(state.running.i1).toBeUndefined();

          // New dispatch was withheld: i2 never ran while the budget was exceeded.
          const runs = yield* runner.control.runs;
          expect(runs.map((r) => r.issueId)).toEqual(["i1"]);
          expect(state.running.i2).toBeUndefined();

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }),
  );

  it.scoped("paused observation fires once per transition, not every tick", () =>
    Effect.gen(function* () {
      const i2 = makeIssue({ id: "i2", identifier: "ORC-2", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" })],
        states: [makeStateRef("i2", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // i1 blows the ceiling and completes; i2 then stays a perpetual candidate.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        Ev.turnCompleted({ total_tokens: 50 }),
        { _tag: "complete" },
      ]);

      const def = buildDef({
        maxConcurrent: 5,
        maxTurns: 1,
        intervalMs: 10_000,
        stallTimeoutMs: 300_000,
        budgetMaxTotalTokens: 10,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        // i1 runs and blows the budget on the first tick.
        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");
        // Keep a fresh candidate present so dispatch WOULD happen if not for the budget.
        yield* tracker.control.setCandidates([i2]);

        // Tick #2: crosses into paused → exactly one BudgetExceeded(paused) emitted.
        yield* TestClock.adjust(Duration.millis(10_000));
        const tick2 = yield* collectUntil(obs.queue, isSkippedTickEnd);
        expect(tick2.filter(isPaused)).toHaveLength(1);

        // Tick #3: still paused → NO further BudgetExceeded (no per-tick spam).
        yield* TestClock.adjust(Duration.millis(10_000));
        const tick3 = yield* collectUntil(obs.queue, isSkippedTickEnd);
        expect(tick3.some((o) => o._tag === "BudgetExceeded")).toBe(false);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
