import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { describe, expect } from "vitest";
import { RunAttempt } from "../src/core/domain/run-attempt";
import { LiveActivityLive } from "../src/core/observability/live-activity";
import { RecentCompletionsLive } from "../src/core/observability/recent-completions";
import { RecentEventsLive } from "../src/core/observability/recent-events";
import { runSnapshotServer, toSnapshot } from "../src/core/observability/snapshot-server";
import {
  initialState,
  makeOrchestratorStore,
  OrchestratorStore,
  setRunning,
} from "../src/core/orchestrator/state";
import { buildDef } from "./fakes/harness";

/** Empty observability rings to satisfy the enriched snapshot server's dependencies. */
const ObservabilityRings = Layer.mergeAll(
  RecentEventsLive,
  RecentCompletionsLive,
  LiveActivityLive,
);

/**
 * Task 12 — JSON snapshot API. {@link toSnapshot} is the pure projection (deterministic,
 * the bulk of the assertions); one `it.scopedLive` integration test boots the real
 * loopback server, reads its bound port, and fetches `GET /api/v1/state` to prove the
 * route + JSON shape end-to-end.
 */

const config = buildDef({ intervalMs: 5000, maxConcurrent: 4 }).config;

const seededState = () =>
  setRunning(
    initialState(config),
    RunAttempt.make({
      issue_id: "42",
      issue_identifier: "#42",
      attempt: null,
      workspace_path: "/tmp/ws/42",
      started_at: new Date("2024-01-01T00:00:00.000Z"),
      status: "StreamingTurn",
    }),
  );

/** Grab a free loopback TCP port, then release it for the server to claim. */
const freePort = Effect.async<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close(() => resume(Effect.succeed(port)));
  });
});

describe("toSnapshot", () => {
  it.effect("projects counts, running, totals, and rate limits", () =>
    Effect.sync(() => {
      const snap = toSnapshot(seededState());
      expect(snap.poll_interval_ms).toBe(5000);
      expect(snap.max_concurrent_agents).toBe(4);
      expect(snap.counts.running).toBe(1);
      expect(snap.counts.completed).toBe(0);
      expect(snap.running).toHaveLength(1);
      expect(snap.running[0]?.issue_identifier).toBe("#42");
      expect(snap.rate_limits).toBeNull();
      expect(snap.totals.total_tokens).toBe(0);
    }),
  );

  it.effect("serializes Date fields to ISO strings via JSON", () =>
    Effect.sync(() => {
      const json = JSON.parse(JSON.stringify(toSnapshot(seededState())));
      expect(json.running[0].started_at).toBe("2024-01-01T00:00:00.000Z");
    }),
  );
});

describe("runSnapshotServer", () => {
  it.scopedLive("serves GET /api/v1/state over loopback", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const store = yield* makeOrchestratorStore(seededState());

      yield* Effect.forkScoped(
        runSnapshotServer(port).pipe(
          Effect.provideService(OrchestratorStore, store),
          Effect.provide(ObservabilityRings),
        ),
      );

      // Poll until the listener is up (bind is async in the forked fiber), then assert.
      const fetchState = Effect.tryPromise(() =>
        fetch(`http://127.0.0.1:${port}/api/v1/state`).then((r) => r.json()),
      );
      const res = (yield* fetchState.pipe(
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }),
      )) as ReturnType<typeof toSnapshot>;

      expect(res.poll_interval_ms).toBe(5000);
      expect(res.counts.running).toBe(1);
      expect(res.running[0]?.issue_identifier).toBe("#42");
    }),
  );
});
