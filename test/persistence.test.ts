import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Duration, Effect, Option, Schema, TestClock } from "effect";
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
    abandoned: {},
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
      // #41/#42 additive continuity fields: must survive the persisted codec end-to-end.
      turn: 3,
      failure_attempts: 1,
      session_id: "sess-i1",
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
        // #41/#42 additive continuity fields on the retry slice.
        kind: "continuation",
        session_id: "sess-i2",
        error: "boom",
      }),
    },
    claimed: ["i1", "i2"],
  };
};

/** Let real filesystem IO settle (independent of the virtual `TestClock`). */
const settle = Effect.promise(() => new Promise<void>((res) => setImmediate(res)));

/**
 * A small REAL (TestClock-independent) delay between filesystem polls. `TestClock` is
 * installed, so `Effect.sleep` would block on the virtual clock and never elapse — this uses a
 * real `setTimeout` instead.
 */
const realDelay = (ms: number): Effect.Effect<void> =>
  Effect.promise(() => new Promise<void>((res) => setTimeout(res, ms)));

/**
 * Deterministically block until the forked debounced writer has parked in its
 * `Effect.sleep(debounce_ms)` — i.e. registered a wake-up with the `TestClock`. The writer
 * fiber races the test fiber: under parallel suite load it can still be working through its
 * `Queue.take` when the test advances the virtual clock, so its sleep deadline is then
 * computed from an already-advanced clock and the window-crossing `adjust` never reaches it
 * (the pre-existing #40 flake). Waiting for the registered sleep removes that race without
 * weakening what the debounce assertions prove (this store forks only the writer fiber, so a
 * pending `TestClock` sleep is unambiguously its debounce window). `yieldNow` hands the
 * scheduler to the writer between polls so it can drain the dirty signal and park.
 */
const awaitWriterParked = Effect.iterate(false, {
  while: (parked) => !parked,
  body: () =>
    Effect.yieldNow().pipe(Effect.zipRight(TestClock.sleeps()), Effect.map(Chunk.isNonEmpty)),
});

/**
 * Poll the real filesystem (independent of the frozen `TestClock`) until `path` exists,
 * bounded by a generous REAL wall-clock deadline rather than a fixed setImmediate-iteration
 * count. The debounced flush performs a multi-step atomic write (`mkdir → writeFile → rename`)
 * on the real event loop; under parallel suite IO load a fixed iteration budget can spin out in
 * only a few ms of wall-clock — less than a contended write takes — and return a false negative
 * (the #40/#61 flake). A real ~5s deadline with a tiny real delay between polls tolerates IO
 * contention while still failing fast for a genuine regression (the write never happens)
 * instead of hanging. `TestClock` is installed, so the inter-poll wait uses a REAL timer
 * (`realDelay`/`setTimeout`) and a REAL `Date.now()` deadline, never `Effect.sleep`.
 */
const awaitFileExists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    const deadline = Date.now() + 5_000;
    return Effect.iterate(false, {
      while: (found) => !found && Date.now() < deadline,
      body: () =>
        fs.exists(path).pipe(
          Effect.orElseSucceed(() => false),
          Effect.tap((found) => (found ? Effect.void : realDelay(5))),
        ),
    });
  });

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
      // The #41/#42 additive continuity fields survive the encode→decode fixed point.
      expect(p1.state.running.i1?.turn).toBe(3);
      expect(p1.state.running.i1?.failure_attempts).toBe(1);
      expect(p1.state.running.i1?.session_id).toBe("sess-i1");
      expect(p1.state.retry_attempts.i2?.kind).toBe("continuation");
      expect(p1.state.retry_attempts.i2?.session_id).toBe("sess-i2");
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
        // Dates and the #41/#42 additive continuity fields survive the real
        // encode→write→read→decode path, not just the in-memory codec.
        expect(loaded.value.state.running.i1?.started_at).toBeInstanceOf(Date);
        expect(loaded.value.state.running.i1?.turn).toBe(3);
        expect(loaded.value.state.running.i1?.session_id).toBe("sess-i1");
        expect(loaded.value.state.retry_attempts.i2?.kind).toBe("continuation");
        expect(loaded.value.state.retry_attempts.i2?.session_id).toBe("sess-i2");
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
  it.scoped("seeds the FULL state — scheduling slice included (#41 restore)", () =>
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
      // #41: the scheduling slice is restored too (the loop's startup rebuilds the registry,
      // converts orphans, and re-arms timers — see test/restore-reconcile.test.ts).
      expect(seeded.running.i1?.issue_identifier).toBe("ORC-1");
      expect(seeded.retry_attempts.i2?.identifier).toBe("ORC-2");
      expect(seeded.claimed).toEqual(["i1", "i2"]);
      // Reloadable knobs always come from the live config, never the checkpoint.
      expect(seeded.poll_interval_ms).toBe(config.polling.interval_ms);
      expect(seeded.max_concurrent_agents).toBe(config.agent.max_concurrent_agents);
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

        // Wait until the writer has parked in its debounce sleep so the window is measured
        // from t=0, not from an already-advanced clock (the pre-existing flake). See
        // `awaitWriterParked`.
        yield* awaitWriterParked;

        // Before the debounce window elapses, the writer is parked in its sleep: no file.
        yield* TestClock.adjust(Duration.millis(499));
        yield* settle;
        expect(yield* fs.exists(file)).toBe(false);

        // Crossing the window fires exactly one debounced write with the latest state.
        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* awaitFileExists(fs, file)).toBe(true);
        const decoded = yield* decodePersisted(yield* fs.readFileString(file));
        expect(decoded.state.completed).toEqual(["x1"]);
      }).pipe(Effect.provide(platform)),
  );

  it.scoped(
    "debounce coalesces a burst of mutations into exactly one scheduled write (TestClock)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
        const config = makeConfig(dir, 500);
        const file = `${dir}/${STATE_FILE}`;

        const store = yield* makeDurableStore(config).pipe(
          Effect.provide(layerPersistence(config)),
        );

        // Five mutations land synchronously within one window, before the writer parks.
        for (const tag of ["a", "b", "c", "d", "e"]) {
          yield* store.update((s) => ({ ...s, completed: [...s.completed, tag] }));
        }

        // The coalescing `Queue.sliding(1)` dirty signal + single debounced writer collapse
        // the burst into exactly ONE scheduled flush — not five (this store forks only the
        // writer, so a single pending `TestClock` sleep is its one debounce window).
        yield* awaitWriterParked;
        expect(Chunk.size(yield* TestClock.sleeps())).toBe(1);

        // One window later: a single write carrying the LATEST coalesced state...
        yield* TestClock.adjust(Duration.millis(500));
        expect(yield* awaitFileExists(fs, file)).toBe(true);
        const decoded = yield* decodePersisted(yield* fs.readFileString(file));
        expect(decoded.state.completed).toEqual(["a", "b", "c", "d", "e"]);

        // ...and no trailing debounce window was scheduled by the coalesced burst (the
        // writer is back parked on `Queue.take`, not in a second sleep).
        expect(Chunk.isEmpty(yield* TestClock.sleeps())).toBe(true);
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

        expect(yield* awaitFileExists(fs, file)).toBe(true);
        const decoded = yield* decodePersisted(yield* fs.readFileString(file));
        expect(decoded.state.completed).toEqual(["flushed"]);
      }).pipe(Effect.provide(platform)),
  );
});

describe("persistence — #51 restrictive checkpoint permissions (POSIX)", () => {
  const posix = process.platform !== "win32";

  it.scoped("save creates the state dir 0700 and state.json 0600 (rename preserves mode)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-perms-" });
      // A fresh, not-yet-existing state dir so makeDirectory actually creates it (and so the
      // 0700 assertion proves OUR mode, not the inherited mkdtemp default).
      const dir = `${base}/nested/.orchestra`;
      const persistence = yield* makePersistence(makeConfig(dir));

      yield* persistence.save(toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z")));

      const file = `${dir}/${STATE_FILE}`;
      expect(yield* fs.exists(file)).toBe(true);
      // No leftover temp sibling, and certainly not with looser perms.
      expect(yield* fs.exists(`${dir}/${STATE_FILE}.tmp`)).toBe(false);

      if (posix) {
        // POSIX-only: assert the actual permission bits via stat. Guarded for Windows, where
        // these modes are not meaningfully enforced by the OS.
        expect(nodeFs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(nodeFs.statSync(file).mode & 0o777).toBe(0o600);
      }
    }).pipe(Effect.provide(platform)),
  );

  it.scoped("session_ids are not world-readable: checkpoint mode excludes group/other", () =>
    Effect.gen(function* () {
      if (!posix) return; // POSIX-only guarantee.
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({
        prefix: "orchestra-perms-",
        directory: nodeOs.tmpdir(),
      });
      const dir = `${base}/.orchestra`;
      const persistence = yield* makePersistence(makeConfig(dir));
      yield* persistence.save(toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z")));

      const fileMode = nodeFs.statSync(`${dir}/${STATE_FILE}`).mode & 0o077; // group+other bits
      expect(fileMode).toBe(0); // no read for group/other → session_ids protected at rest.
    }).pipe(Effect.provide(platform)),
  );
});

describe("persistence — #50 degrade agent_rate_limits on encode fault (spike §2.2)", () => {
  /** A `Schema.Unknown` value the codec accepts but `JSON.stringify` rejects (BigInt). */
  const unencodableRateLimits = {
    primary: { remaining: 10n, reset_at: "2026-01-01T00:00:00.000Z" },
  };

  it.scoped(
    "an unencodable agent_rate_limits degrades to null; the rest of the checkpoint is still written",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
        const persistence = yield* makePersistence(makeConfig(dir));

        const bad: OrchestratorState = {
          ...sampleState(),
          // BigInt reaches Schema.Unknown fine, but faults the whole-object JSON encode.
          agent_rate_limits: unencodableRateLimits,
        };
        const p0 = toPersisted(bad, new Date("2026-06-24T10:00:01.000Z"));

        // save is total: it must NOT skip the write (pre-#50 behavior) — it writes the rest.
        yield* persistence.save(p0);

        const loaded = yield* persistence.load;
        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          // Just the fragile field degraded...
          expect(loaded.value.state.agent_rate_limits).toBeNull();
          // ...everything else (running/retry/completed/totals + #41/#42 continuity) intact.
          expect(loaded.value.state.completed).toEqual(["done-1", "done-2"]);
          expect(loaded.value.state.agent_totals.total_tokens).toBe(33);
          expect(loaded.value.state.running.i1?.session_id).toBe("sess-i1");
          expect(loaded.value.state.retry_attempts.i2?.kind).toBe("continuation");
          expect(loaded.value.state.claimed).toEqual(["i1", "i2"]);
        }
      }).pipe(Effect.provide(platform)),
  );

  it.scoped("a normal (JSON-origin) agent_rate_limits is unaffected — no degradation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-persist-" });
      const persistence = yield* makePersistence(makeConfig(dir));

      // sampleState carries a vendor-shaped, JSON-encodable agent_rate_limits.
      const p0 = toPersisted(sampleState(), new Date("2026-06-24T10:00:01.000Z"));
      yield* persistence.save(p0);

      const loaded = yield* persistence.load;
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value.state.agent_rate_limits).toEqual({
          primary: { remaining: 7, reset_at: "2026-01-01T00:00:00.000Z" },
        });
      }
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
