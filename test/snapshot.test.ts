import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { RunAttempt } from "../src/core/domain/run-attempt";
import { toSnapshot } from "../src/core/observability/snapshot";
import { initialState, setRunning } from "../src/core/orchestrator/state";
import { buildDef } from "./fakes/harness";

/**
 * The pure {@link toSnapshot} projection (SPEC §13.3/§13.7). Deterministic, no server — the
 * byte-compatible end-to-end serving is exercised in `cockpit-server.test.ts` (Sprint 6,
 * DD-1). These assertions pin the projected shape and Date→ISO serialization.
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
