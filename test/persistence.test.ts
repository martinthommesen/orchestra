import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Duration, Effect, Option, Schema, TestClock } from "effect";
import { describe, expect } from "vitest";
import { AgentTotals, OrchestratorState } from "../src/core/domain/orchestrator-state";
import { RetryEntry } from "../src/core/domain/retry-entry";
import { RunAttempt } from "../src/core/domain/run-attempt";
import { ServiceConfig } from "../src/core/domain/workflow";
import { OrchestratorStore, setRunning, zeroTotals } from "../src/core/orchestrator/state";
import {
  layerDurableOrchestratorStore,
  makeDurableStore,
} from "../src/core/persistence/durable-store";
import {
  decodePersisted,
  encodePersisted,
  toPersisted,
} from "../src/core/persistence/persisted-state";
import { layerPersistence, makePersistence, STATE_FILE } from "../src/core/persistence/persistence";

/**
 * Sprint 4 / #40 — the durable persistence layer (durability spike §2.8). Proves the
 * encode→write→read→decode→restore fixed point, corruption → rename-aside clean start
 * (never throws), and the debounced writer + guaranteed final flush under `TestClock`,
 * plus the bookkeeping-only seed boundary (#40/#41 line).
 */

const platform = NodeContext.layer;

/** A service config rooted at `dir`, with the checkpoint written directly into `dir`. */
const makeConfig = (dir: string, debounceMs = 500): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)({
    tracker: { kind: "github", repo: "o/r", api_key: "t" },
    workspace: { root: dir },
    persistence: { dir, debounce_ms: debounceMs },
  });

/** A representative state: a running attempt + a wall-clock-scheduled retry + bookkeeping. */
const sampleState = (): OrchestratorState => {
  let s = OrchestratorState.make({
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: {},
    claimed: [],
    retry_attempts: {},
    completed: ["done-1", "done-2"],
    agent_totals: AgentTotals.make({
      input_tokens: 11,
      output_tokens: 22,
      total_tokens: 33,
      runtime_seconds: 4.5,
    }),
    // vendor-shaped passthrough (Unknown): must round-trip via parseJson.
    agent_rate_limits: { primary: { remaining: 7, reset_at: "2026-01-01T00:00:00.000Z" } },
  });
  s = setRunning(
    s,
    RunAttempt.make({
      issue_id: "i1",
      issue_identifier: "ORC-1",
      attempt: null,
      workspace_path: "/ws/ORC-1",
      started_at: new Date("2026-06-24T10:00:00.000Z"),
      status: "StreamingTurn",
    }),
  );
  return {
    ...s,
    retry_attempts: {
      i2: RetryEntry.make({
        issue_id: "i2",
        identifier: "ORC-2",
        attempt: 2,
        due_at_ms: 123_456,
        scheduled_at: new Date("2026-06-24T09:59:30.000Z"),
        delay_ms: 30_000,
        error: "boom",
      }),
    },
    claimed: ["i1", "i2"],
  };
};

/** Let real filesystem IO settle (independent of the virtual `TestClock`). */
const settle = Effect.promise(() => new Promise<void>((res) => setImmediate(res)));

describe("persistence — codec round-trip (§2.8)", () => {
  it.effect("encode → decode is a fixed point (Dates equal as Dates)", () =>
    Effect.gen(function* () {
      const p0 = toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z"));
      const json = yield* encodePersisted(p0);
      // ISO encoding, not [object Object]: Dates serialize as strings.
      expect(json).toContain("2026-06-24T10:00:00.000Z");
      const p1 = yield* decodePersisted(json);
      expect(p1).toEqual(p0);
      expect(p1.state.running.i1?.started_at).toBeInstanceOf(Date);
      expect(p1.state.retry_attempts.i2?.scheduled_at?.getTime()).toBe(
        new Date("2026-06-24T09:59:30.000Z").getTime(),
      );
    }),
  );

  it.effect("decode rejects a corrupt string with a ParseError (no throw)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(decodePersisted("{ not json"));
      expect(result._tag).toBe("Left");
    }),
  );
});

describe("persistence — service load/save (real filesystem)", () => {
  it.scoped("save → load round-trips through an atomic temp+rename write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const persistence = yield* makePersistence(makeConfig(dir));
      const p0 = toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z"));

      yield* persistence.save(p0);
      // no leftover temp sibling after the rename.
      expect(yield* fs.exists(`${dir}/${STATE_FILE}.tmp`)).toBe(false);

      const loaded = yield* persistence.load;
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value).toEqual(p0);
      }
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("missing checkpoint → Option.none (clean cold start)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const persistence = yield* makePersistence(makeConfig(dir));
      const loaded = yield* persistence.load;
      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("corrupt checkpoint → rename-aside + Option.none, never throws (§2.4)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const persistence = yield* makePersistence(makeConfig(dir));
      yield* fs.writeFileString(`${dir}/${STATE_FILE}`, "{ this is not valid json");

      const loaded = yield* persistence.load;
      expect(Option.isNone(loaded)).toBe(true);

      const entries = yield* fs.readDirectory(dir);
      // original renamed aside; a corrupt-<ts> sibling preserved for diagnosis.
      expect(entries.includes(STATE_FILE)).toBe(false);
      expect(entries.some((e) => e.startsWith(`${STATE_FILE}.corrupt-`))).toBe(true);
    }).pipe(Effect.provide(platform)),
  );
});

describe("persistence — durable store decorator", () => {
  it.scoped("seeds BOOKKEEPING ONLY; scheduling slice starts empty (#40/#41 boundary)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const config = makeConfig(dir);
      // Pre-seed a checkpoint that carries running/claimed/retry + bookkeeping.
      const persistence = yield* makePersistence(config);
      yield* persistence.save(toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z")));

      const store = yield* makeDurableStore(config).pipe(Effect.provide(layerPersistence(config)));
      const seeded = yield* store.get;

      // Bookkeeping restored:
      expect(seeded.completed).toEqual(["done-1", "done-2"]);
      expect(seeded.agent_totals.total_tokens).toBe(33);
      expect(seeded.agent_rate_limits).toEqual({
        primary: { remaining: 7, reset_at: "2026-01-01T00:00:00.000Z" },
      });
      // Scheduling slice deliberately empty until #41 reconciles/re-arms:
      expect(seeded.running).toEqual({});
      expect(seeded.retry_attempts).toEqual({});
      expect(seeded.claimed).toEqual([]);
    }).pipe(Effect.provide(platform)),
  );

  it.scoped(
    "debounce: a mutation is NOT written before the window; one write after (TestClock)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
        const config = makeConfig(dir, 500);
        const file = `${dir}/${STATE_FILE}`;

        const store = yield* makeDurableStore(config).pipe(
          Effect.provide(layerPersistence(config)),
        );
        yield* store.update((s) => ({ ...s, completed: [...s.completed, "x1"] }));

        // Before the debounce window elapses, the writer is parked in its sleep: no file.
        yield* TestClock.adjust(Duration.millis(499));
        yield* settle;
        expect(yield* fs.exists(file)).toBe(false);

        // Crossing the window fires exactly one debounced write with the latest state.
        yield* TestClock.adjust(Duration.millis(1));
        yield* settle;
        yield* settle;
        expect(yield* fs.exists(file)).toBe(true);
        const decoded = yield* decodePersisted(yield* fs.readFileString(file));
        expect(decoded.state.completed).toEqual(["x1"]);
      }).pipe(Effect.provide(platform)),
  );

  it.scoped(
    "guaranteed final flush on scope teardown even if debounce never fired (TestClock)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
        const config = makeConfig(dir, 500);
        const file = `${dir}/${STATE_FILE}`;

        // Inner scope owns the writer fiber + final-flush finalizer.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* makeDurableStore(config);
            yield* store.update((s) => ({ ...s, completed: [...s.completed, "flushed"] }));
            // Never advance the clock → the debounce sleep never elapses; the only writer
            // that can run is the teardown final flush.
          }).pipe(Effect.provide(layerPersistence(config))),
        );
        yield* settle;
        yield* settle;

        expect(yield* fs.exists(file)).toBe(true);
        const decoded = yield* decodePersisted(yield* fs.readFileString(file));
        expect(decoded.state.completed).toEqual(["flushed"]);
      }).pipe(Effect.provide(platform)),
  );
});

describe("persistence — config layer wiring", () => {
  it.scoped("layerDurableOrchestratorStore is a drop-in OrchestratorStore (cold start)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const config = makeConfig(dir);
      const store = yield* Effect.provide(OrchestratorStore, layerDurableOrchestratorStore(config));
      const s = yield* store.get;
      expect(s.completed).toEqual([]);
      expect(s.agent_totals).toEqual(zeroTotals());
    }).pipe(Effect.provide(platform)),
  );
});
