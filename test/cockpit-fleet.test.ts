import { describe, expect, it } from "vitest";
import type { SnapshotWire } from "../src/cockpit/api/types";
import { badgeForPhase, toFleetView } from "../src/cockpit/model/fleet";

const NOW = Date.parse("2026-01-01T00:01:00.000Z");

type SnapshotOverride = Omit<Partial<SnapshotWire>, "counts"> & {
  readonly counts?: Partial<SnapshotWire["counts"]>;
};

const baseSnapshot = (over: SnapshotOverride = {}): SnapshotWire => {
  const base: SnapshotWire = {
    poll_interval_ms: 1000,
    max_concurrent_agents: 3,
    counts: { running: 0, retrying: 0, abandoned: 0, completed: 0, claimed: 0 },
    running: [],
    retrying: [],
    abandoned: [],
    completed: [],
    recent_completed: [],
    recent_events: [],
    totals: { input_tokens: 10, output_tokens: 20, total_tokens: 30, runtime_seconds: 65 },
    rate_limits: null,
  };
  return { ...base, ...over, counts: { ...base.counts, ...over.counts } };
};

describe("badgeForPhase", () => {
  it("maps known phases via the design-system status vocabulary", () => {
    expect(badgeForPhase("StreamingTurn")).toMatchObject({ label: "running", known: true });
    expect(badgeForPhase("TimedOut")).toMatchObject({ label: "retrying", known: true });
    expect(badgeForPhase("Succeeded")).toMatchObject({ label: "done", known: true });
    expect(badgeForPhase("Failed")).toMatchObject({ label: "failed", known: true });
    expect(badgeForPhase("CanceledByReconciliation")).toMatchObject({
      label: "blocked",
      known: true,
    });
  });

  it("returns an honest unknown badge for a drifted phase (never fake 'running')", () => {
    const b = badgeForPhase("SomeFuturePhase");
    expect(b.known).toBe(false);
    expect(b.label).toBe("unknown");
  });
});

describe("toFleetView", () => {
  it("derives running rows with client-side elapsed, attempt and last-activity", () => {
    const vm = toFleetView(
      baseSnapshot({
        counts: { running: 1, retrying: 0, completed: 0, claimed: 0 },
        running: [
          {
            issue_id: "i1",
            issue_identifier: "ORC-1",
            attempt: 2,
            workspace_path: "/tmp/ws/orc-1",
            started_at: "2026-01-01T00:00:30.000Z",
            status: "StreamingTurn",
            last_activity: {
              event_tag: "TurnCompleted",
              at: "2026-01-01T00:00:55.000Z",
              message: "completed a turn",
            },
          },
        ],
      }),
      NOW,
    );
    expect(vm.running).toHaveLength(1);
    const row = vm.running[0];
    expect(row?.elapsedLabel).toBe("30s");
    expect(row?.attemptLabel).toBe("#2");
    expect(row?.badge.label).toBe("running");
    expect(row?.lastActivityLabel).toBe("completed a turn · 5s ago");
  });

  it("renders elapsed sentinel for an unparseable started_at (never a fake 0s)", () => {
    const vm = toFleetView(
      baseSnapshot({
        running: [
          {
            issue_id: "i1",
            issue_identifier: "ORC-1",
            attempt: null,
            workspace_path: "/ws",
            started_at: "not-a-date",
            status: "PreparingWorkspace",
          },
        ],
      }),
      NOW,
    );
    expect(vm.running[0]?.elapsedLabel).toBe("—");
    expect(vm.running[0]?.attemptLabel).toBe("—");
  });

  it("omits additive panels when the daemon doesn't send them", () => {
    const vm = toFleetView(baseSnapshot(), NOW);
    expect(vm.budget).toBeNull();
    expect(vm.restore).toBeNull();
    expect(vm.rateLimits.available).toBe(false);
    expect(vm.rateLimits.summary).toBe("unavailable");
  });

  it("surfaces budget, restore and rate-limits when present", () => {
    const vm = toFleetView(
      baseSnapshot({
        budget: { limit_tokens: 1000, spent_tokens: 250, remaining_tokens: 750, paused: false },
        restore: {
          at: "2026-01-01T00:00:48.000Z",
          orphaned_running_converted: 1,
          rearmed_retries: 0,
          restored_completed: 3,
        },
        rate_limits: { remaining: 42 },
      }),
      NOW,
    );
    expect(vm.budget).toMatchObject({ paused: false, stateLabel: "active" });
    expect(vm.budget?.summary).toBe("250 / 1000 tokens · 750 left");
    expect(vm.restore?.summary).toContain(
      "1 running · 0 retrying · 3 completed · restored 12s ago",
    );
    expect(vm.rateLimits).toEqual({ available: true, summary: '{"remaining":42}' });
  });

  it("formats totals runtime as a human duration", () => {
    const vm = toFleetView(baseSnapshot(), NOW);
    expect(vm.totals.runtimeLabel).toBe("1m 05s");
    expect(vm.totals.totalTokens).toBe(30);
  });
});
