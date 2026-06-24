import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import { toSnapshot } from "../src/core/observability/snapshot";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import { OrchestratorStore } from "../src/core/orchestrator/state";
import * as Ev from "./fakes/events";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import { buildDef, loopLayer, makeIssue, TEST_ROOT, waitFor } from "./fakes/harness";
import { makeRecordingObserver } from "./fakes/recording-observer";

/**
 * Sprint 1, Task 13 — the combined fake end-to-end. Wires `FakeTracker` +
 * `FakeAgentRunner` + `FakeWorkspaceManager` through the *real* {@link runOrchestrator}
 * single fiber under `TestClock`, with zero network and zero real timers, and walks the
 * whole pipeline for two priority-ordered issues: select → dispatch within slots →
 * ensure workspace (+ hooks) → run a Copilot session → accumulate usage → mark completed.
 * Finally it asserts the {@link toSnapshot} projection the `--port` API would serve, so
 * Task 12 and Task 13 are proven together against one run.
 */

describe("fake end-to-end (whole loop, no network)", () => {
  it.scoped("two issues are selected, run, and completed; snapshot reflects the result", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({
        candidates: [
          makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo", priority: 1 }),
          makeIssue({ id: "i2", identifier: "ORC-2", state: "Todo", priority: 2 }),
        ],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();

      for (const [id, tokens] of [
        ["i1", 11],
        ["i2", 31],
      ] as const) {
        yield* runner.control.pushScript(id, [
          Ev.sessionStarted(`s-${id}`),
          Ev.agentMessage(`working on ${id}`),
          Ev.turnCompleted({ total_tokens: tokens }),
          { _tag: "complete" },
        ]);
      }

      const def = buildDef({ maxTurns: 1, maxConcurrent: 10 });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        // Wait until BOTH workers have completed, order-independent (waitFor consumes the
        // queue, so we count rather than wait for a specific issue first).
        const done = new Set<string>();
        yield* waitFor(obs.queue, (o) => {
          if (o._tag === "WorkerCompleted") {
            done.add(o.issueId);
          }
          return done.has("i1") && done.has("i2");
        });

        const store = yield* OrchestratorStore;
        const state = yield* store.get;

        // Both issues completed, nothing left running, usage summed across the run.
        expect([...state.completed].sort()).toEqual(["i1", "i2"]);
        expect(Object.keys(state.running)).toHaveLength(0);
        expect(state.agent_totals.total_tokens).toBe(42);

        // Each issue got its own workspace and ran the before/after_run hooks.
        const created = yield* wsm.control.created;
        expect(created).toHaveLength(2);
        const hookNames = (yield* wsm.control.hooks).map((h) => h.hook);
        expect(hookNames).toContain("before_run");
        expect(hookNames).toContain("after_run");

        // Two sessions ran, first turns, full prompt (no resume).
        const runs = yield* runner.control.runs;
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.attempt === null && r.resumeSessionId === null)).toBe(true);
        expect(runs.map((r) => r.prompt).join("\n")).toContain("ORC-1");

        // The snapshot the --port API would serve mirrors the authoritative state.
        const snap = toSnapshot(state);
        expect(snap.counts.completed).toBe(2);
        expect(snap.counts.running).toBe(0);
        expect(snap.totals.total_tokens).toBe(42);
        expect([...snap.completed].sort()).toEqual(["i1", "i2"]);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
