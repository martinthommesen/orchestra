import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Schema, TestClock } from "effect";
import { describe, expect } from "vitest";
import { ClockLive } from "../src/core/clock/live";
import type { OrchestratorState } from "../src/core/domain/orchestrator-state";
import { ServiceConfig, type WorkflowDefinition } from "../src/core/domain/workflow";
import { RecentCompletionsLive } from "../src/core/observability/recent-completions";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import type { Observation } from "../src/core/orchestrator/observer";
import {
  initialState,
  OrchestratorStore,
  setRetry,
  setRunning,
} from "../src/core/orchestrator/state";
import { layerDurableOrchestratorStore } from "../src/core/persistence/durable-store";
import { toPersisted } from "../src/core/persistence/persisted-state";
import { makePersistence } from "../src/core/persistence/persistence";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import { makeIssue, makeStateRef, waitFor } from "./fakes/harness";
import { makeRecordingObserver } from "./fakes/recording-observer";

/**
 * Sprint 4 / #41 — restore + reconcile + retry re-arm on boot (durability spike §2.4–§2.6).
 *
 * Drives the **real** {@link runOrchestrator} against a pre-written checkpoint through the
 * **durable** store decorator, under `TestClock`, proving the riskiest surgery of Phase B:
 *   - orphaned `running` → due-immediately continuation retry → dispatched EXACTLY ONCE;
 *   - a restored issue that went terminal / vanished while down → killed by reconcile,
 *     never re-dispatched;
 *   - pending retries re-armed from **wall-clock** `scheduled_at + delay_ms`, NOT the stale
 *     monotonic `due_at_ms` (a process restart resets the monotonic origin) — both the
 *     already-due and the future cases, each proven not-monotonic;
 *   - corrupt / missing checkpoint → clean empty boot (regression guard, never crashes);
 *   - the synthetic `RestoredAfterRestart` observation carries the correct counts.
 *
 * `due_at_ms` in every seeded retry is a deliberately bogus large value (5_000_000): if the
 * re-arm ever read it as a monotonic countdown, the timer would need a ~5_000_000ms clock
 * advance to fire. Every re-arm assertion fires with a far smaller advance, which is what
 * proves the wall-clock derivation.
 */

const BOGUS_MONOTONIC_DUE = 5_000_000;

interface DefOpts {
  readonly activeStates?: ReadonlyArray<string>;
  readonly terminalStates?: ReadonlyArray<string>;
  readonly maxConcurrent?: number;
  readonly maxTurns?: number;
}

const buildDurableDef = (dir: string, opts: DefOpts = {}): WorkflowDefinition => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    tracker: {
      kind: "github",
      repo: "octo/repo",
      api_key: "test-token",
      active_states: opts.activeStates ?? ["Todo", "In Progress"],
      terminal_states: opts.terminalStates ?? ["Done", "Closed"],
      required_labels: [],
    },
    polling: { interval_ms: 30_000 },
    agent: {
      max_concurrent_agents: opts.maxConcurrent ?? 10,
      max_turns: opts.maxTurns ?? 2,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
    },
    copilot: { stall_timeout_ms: 300_000 },
    workspace: { root: dir },
    persistence: { dir },
  });
  return { config, prompt_template: "Work on {{ issue.identifier }}." };
};

/** Write a checkpoint to `dir` exactly as the #40 writer would (atomic temp+rename). */
const seedCheckpoint = (
  config: ServiceConfig,
  state: OrchestratorState,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const persistence = yield* makePersistence(config);
    yield* persistence.save(toPersisted(state, new Date("2026-06-24T10:00:00.000Z")));
  });

const isDispatched =
  (issueId: string) =>
  (o: Observation): boolean =>
    o._tag === "Dispatched" && o.issueId === issueId;

describe("restore + reconcile + retry re-arm on boot (#41)", () => {
  it.scoped("orphaned running → due-now continuation, dispatched EXACTLY ONCE", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir, { maxTurns: 2 });

      // Checkpoint: i1 was running on turn 1 (1 clean turn done) when the daemon died.
      const seeded = setRunning(initialState(def.config), {
        issue_id: "i1",
        issue_identifier: "ORC-1",
        attempt: 1,
        workspace_path: `${dir}/ORC-1`,
        started_at: new Date(0),
        status: "StreamingTurn",
        turn: 1,
        failure_attempts: 0,
      });
      yield* seedCheckpoint(def.config, seeded);

      const tracker = yield* makeFakeTracker({
        candidates: [],
        states: [makeStateRef("i1", "In Progress")], // still active → reconcile leaves it.
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [{ _tag: "complete" }]);

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        // Restore emitted with one orphan converted.
        const restored = yield* waitFor(obs.queue, (o) => o._tag === "RestoredAfterRestart");
        if (restored._tag === "RestoredAfterRestart") {
          expect(restored.orphanedRunningConverted).toBe(1);
        }

        // First tick must NOT dispatch the orphan fresh (it is claimed) — reconcile only.
        const firstTick = yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
        if (firstTick._tag === "TickEnd") {
          expect(firstTick.dispatched).not.toContain("i1");
        }

        // Fire the due-now continuation timer.
        yield* TestClock.adjust(Duration.millis(1));
        const dispatched = yield* waitFor(obs.queue, isDispatched("i1"));
        if (dispatched._tag === "Dispatched") {
          // Continuation against turn 2 (turn_count 1 + 1), running FRESH (no resume in #41).
          expect(dispatched.turn).toBe(2);
          expect(dispatched.resumed).toBe(false);
        }

        yield* waitFor(obs.queue, (o) => o._tag === "WorkerCompleted" && o.issueId === "i1");

        // EXACTLY ONCE: a single run for i1, the continuation, not a session resume.
        const runs = yield* runner.control.runs;
        const i1Runs = runs.filter((r) => r.issueId === "i1");
        expect(i1Runs).toHaveLength(1);
        expect(i1Runs[0]?.attempt).toBe(2);
        expect(i1Runs[0]?.resumeSessionId).toBeNull();
        expect(i1Runs[0]?.prompt).toContain("Continue working on issue ORC-1 (turn 2)");

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toContain("i1");
        expect(state.running.i1).toBeUndefined();
        expect(state.retry_attempts.i1).toBeUndefined();

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("orphaned running that went TERMINAL while down → killed, NOT re-dispatched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);

      const seeded = setRunning(initialState(def.config), {
        issue_id: "i1",
        issue_identifier: "ORC-1",
        attempt: 1,
        workspace_path: `${dir}/ORC-1`,
        started_at: new Date(0),
        status: "StreamingTurn",
        turn: 1,
        failure_attempts: 0,
      });
      yield* seedCheckpoint(def.config, seeded);

      const tracker = yield* makeFakeTracker({
        candidates: [],
        states: [makeStateRef("i1", "Done")], // terminal → reconcile TerminalKill.
        byStates: [], // startup cleanup terminal fetch.
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        const killed = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
        );
        if (killed._tag === "WorkerKilled") {
          expect(killed.reason).toBe("terminal");
        }
        // Even after firing any due-now timer, no dispatch happens (registry entry gone).
        yield* TestClock.adjust(Duration.millis(5));

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toContain("i1");
        expect(state.running.i1).toBeUndefined();
        expect(state.retry_attempts.i1).toBeUndefined();
        expect(state.claimed).not.toContain("i1");

        const runs = yield* runner.control.runs;
        expect(runs.filter((r) => r.issueId === "i1")).toHaveLength(0);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("orphaned running that VANISHED from the tracker → released, NOT re-dispatched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);

      const seeded = setRunning(initialState(def.config), {
        issue_id: "i1",
        issue_identifier: "ORC-1",
        attempt: 1,
        workspace_path: `${dir}/ORC-1`,
        started_at: new Date(0),
        status: "StreamingTurn",
        turn: 0,
        failure_attempts: 0,
      });
      yield* seedCheckpoint(def.config, seeded);

      const tracker = yield* makeFakeTracker({
        candidates: [],
        states: [], // i1 no longer returned by the tracker → NeitherKill (release).
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        const killed = yield* waitFor(
          obs.queue,
          (o) => o._tag === "WorkerKilled" && o.issueId === "i1",
        );
        if (killed._tag === "WorkerKilled") {
          expect(killed.reason).toBe("neither");
        }
        yield* TestClock.adjust(Duration.millis(5));

        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        // Released — not completed, not running, not retrying, not claimed.
        expect(state.completed).not.toContain("i1");
        expect(state.running.i1).toBeUndefined();
        expect(state.retry_attempts.i1).toBeUndefined();
        expect(state.claimed).not.toContain("i1");

        const runs = yield* runner.control.runs;
        expect(runs.filter((r) => r.issueId === "i1")).toHaveLength(0);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("pending retry already past-due → re-armed from WALL-CLOCK, fires immediately", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);

      // fireInstant = scheduled_at(-5000) + delay(1000) = -4000 ms ≤ wall-now(0) → due NOW.
      // due_at_ms is bogus monotonic from the dead process; must never be used.
      const seeded: OrchestratorState = setRetry(initialState(def.config), {
        issue_id: "i1",
        identifier: "ORC-1",
        attempt: 1,
        due_at_ms: BOGUS_MONOTONIC_DUE,
        scheduled_at: new Date(-5000),
        delay_ms: 1000,
        kind: "failure",
        error: "boom",
      });
      yield* seedCheckpoint(def.config, seeded);

      const tracker = yield* makeFakeTracker({
        candidates: [],
        states: [makeStateRef("i1", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [{ _tag: "complete" }]);

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        yield* waitFor(obs.queue, (o) => o._tag === "RestoredAfterRestart");

        // A 1 ms advance fires it. Had the re-arm used the monotonic due_at_ms (5_000_000),
        // this would need a 5_000_000 ms advance — so firing here PROVES wall-clock.
        yield* TestClock.adjust(Duration.millis(1));
        const dispatched = yield* waitFor(obs.queue, isDispatched("i1"));
        // failure retry re-dispatches FRESH (turn 1).
        if (dispatched._tag === "Dispatched") {
          expect(dispatched.turn).toBe(1);
        }
        const runs = yield* runner.control.runs;
        expect(runs.filter((r) => r.issueId === "i1")).toHaveLength(1);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "pending retry in the future → fires at the residual WALL-CLOCK offset (not monotonic)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
        const def = buildDurableDef(dir);

        // fireInstant = scheduled_at(0) + delay(10_000) = 10_000 ms; wall-now(0) → 10_000 left.
        const seeded: OrchestratorState = setRetry(initialState(def.config), {
          issue_id: "i1",
          identifier: "ORC-1",
          attempt: 1,
          due_at_ms: BOGUS_MONOTONIC_DUE,
          scheduled_at: new Date(0),
          delay_ms: 10_000,
          kind: "failure",
          error: "boom",
        });
        yield* seedCheckpoint(def.config, seeded);

        const tracker = yield* makeFakeTracker({
          candidates: [],
          states: [makeStateRef("i1", "In Progress")],
        });
        const runner = yield* makeFakeAgentRunner();
        const wsm = yield* makeFakeWorkspaceManager(dir);
        const obs = yield* makeRecordingObserver();
        yield* runner.control.pushScript("i1", [{ _tag: "complete" }]);

        const env = Layer.mergeAll(
          tracker.layer,
          runner.layer,
          wsm.layer,
          obs.layer,
          ClockLive,
          layerDurableOrchestratorStore(def.config),
          RecentCompletionsLive,
        );

        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(runOrchestrator(def));
          yield* waitFor(obs.queue, (o) => o._tag === "RestoredAfterRestart");
          yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");

          // Not yet due at 9_999 ms.
          yield* TestClock.adjust(Duration.millis(9_999));
          const runsBefore = yield* runner.control.runs;
          expect(runsBefore.filter((r) => r.issueId === "i1")).toHaveLength(0);

          // Crossing the 10_000 ms wall-clock instant fires it (NOT the 5_000_000 monotonic).
          yield* TestClock.adjust(Duration.millis(2));
          yield* waitFor(obs.queue, isDispatched("i1"));
          const runsAfter = yield* runner.control.runs;
          expect(runsAfter.filter((r) => r.issueId === "i1")).toHaveLength(1);

          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(env));
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("RestoredAfterRestart carries the correct counts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);

      let seeded = setRunning(initialState(def.config), {
        issue_id: "i1",
        issue_identifier: "ORC-1",
        attempt: 1,
        workspace_path: `${dir}/ORC-1`,
        started_at: new Date(0),
        status: "StreamingTurn",
        turn: 0,
        failure_attempts: 0,
      });
      seeded = setRetry(seeded, {
        issue_id: "i2",
        identifier: "ORC-2",
        attempt: 1,
        due_at_ms: BOGUS_MONOTONIC_DUE,
        scheduled_at: new Date(0),
        delay_ms: 60_000,
        kind: "failure",
        error: "boom",
      });
      seeded = { ...seeded, completed: ["c1", "c2", "c3"] };
      yield* seedCheckpoint(def.config, seeded);

      const tracker = yield* makeFakeTracker({
        candidates: [],
        states: [makeStateRef("i1", "In Progress"), makeStateRef("i2", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        const restored = yield* waitFor(obs.queue, (o) => o._tag === "RestoredAfterRestart");
        if (restored._tag === "RestoredAfterRestart") {
          expect(restored.orphanedRunningConverted).toBe(1);
          expect(restored.reArmedRetries).toBe(1);
          expect(restored.restoredCompleted).toBe(3);
        }
        // Bookkeeping survived the restart immediately.
        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toEqual(["c1", "c2", "c3"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("missing checkpoint → clean empty boot, normal dispatch (regression guard)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);
      // No checkpoint written → cold start.

      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
        states: [makeStateRef("i1", "Todo")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [{ _tag: "complete" }]);

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        // A cold boot emits NO RestoredAfterRestart and dispatches the candidate normally.
        const dispatched = yield* waitFor(obs.queue, isDispatched("i1"));
        if (dispatched._tag === "Dispatched") {
          expect(dispatched.turn).toBe(1);
        }
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("corrupt checkpoint → clean empty boot, never crashes (regression guard)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-restore-" });
      const def = buildDurableDef(dir);
      // A corrupt checkpoint: the durable store must load `none` and boot clean.
      yield* fs.writeFileString(`${dir}/state.json`, "{ this is not valid json");

      const tracker = yield* makeFakeTracker({
        candidates: [makeIssue({ id: "i1", identifier: "ORC-1", state: "Todo" })],
        states: [makeStateRef("i1", "Todo")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(dir);
      const obs = yield* makeRecordingObserver();
      yield* runner.control.pushScript("i1", [{ _tag: "complete" }]);

      const env = Layer.mergeAll(
        tracker.layer,
        runner.layer,
        wsm.layer,
        obs.layer,
        ClockLive,
        layerDurableOrchestratorStore(def.config),
        RecentCompletionsLive,
      );

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));
        // Clean boot despite the corrupt file: the candidate dispatches normally.
        const dispatched = yield* waitFor(obs.queue, isDispatched("i1"));
        if (dispatched._tag === "Dispatched") {
          expect(dispatched.turn).toBe(1);
        }
        const store = yield* OrchestratorStore;
        const state = yield* store.get;
        expect(state.completed).toEqual([]);
        // The corrupt file was renamed aside, not left in place to re-poison a later boot.
        const entries = yield* fs.readDirectory(dir);
        expect(entries.some((e) => e.startsWith("state.json.corrupt-"))).toBe(true);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
