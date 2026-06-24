import { describe, expect, it } from "vitest";
import {
  formatDuration,
  RECENT_COMPLETED,
  toViewModel,
  type ViewModelOptions,
} from "../../src/cli/dashboard/view-model";
import type { Status } from "../../src/core/observability/glyphs";
import { makeRetrying, makeRunning, makeSnapshot } from "./fixtures";

/**
 * #33 — view-model state matrix. The view-model carries all the rendering logic, so this
 * is where the honest-rendering rules are pinned: client-calculated elapsed, retrying
 * with no countdown, completed as IDs-only, defensive rate-limits.
 */

// 60s after the fixture's started_at, so elapsed is a round "1m 00s".
const NOW = Date.parse("2024-01-01T00:01:00.000Z");

const opts = (over: Partial<ViewModelOptions> = {}): ViewModelOptions => ({
  connection: "live",
  error: null,
  lastUpdatedAtMs: NOW,
  baseUrl: "http://127.0.0.1:4317",
  ...over,
});

describe("toViewModel — empty / connecting", () => {
  it("renders a connecting header with no rows and no totals", () => {
    const vm = toViewModel(null, NOW, opts({ connection: "connecting", lastUpdatedAtMs: null }));
    expect(vm.header.connectionLabel).toBe("connecting");
    expect(vm.header.connectionColor).toBe("info");
    expect(vm.header.pollIntervalMs).toBeNull();
    expect(vm.header.maxConcurrentAgents).toBeNull();
    expect(vm.header.updatedLabel).toBeNull();
    expect(vm.running).toEqual([]);
    expect(vm.retrying).toEqual([]);
    expect(vm.completed).toEqual({ count: 0, recentIds: [] });
    expect(vm.totals).toBeNull();
    expect(vm.rateLimits).toEqual({ available: false, summary: "unavailable" });
  });
});

describe("toViewModel — running rows (rich, with elapsed)", () => {
  it("computes elapsed from started_at and maps the phase to an operator status", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    const row = vm.running[0];
    expect(row?.identifier).toBe("ORC-1");
    expect(row?.status).toBe("running"); // StreamingTurn → running
    expect(row?.phase).toBe("StreamingTurn");
    expect(row?.elapsedLabel).toBe("1m 00s");
    expect(row?.attemptLabel).toBe("—"); // null attempt = first run
    expect(row?.workspace).toContain("ws/i1");
    expect(vm.header.pollIntervalMs).toBe(1000);
    expect(vm.header.maxConcurrentAgents).toBe(4);
    expect(vm.header.connectionColor).toBe("success");
    expect(vm.header.updatedLabel).toBe("updated 0s ago");
  });

  it("labels a retry/continuation attempt with #n", () => {
    const vm = toViewModel(makeSnapshot({ running: [makeRunning({ attempt: 3 })] }), NOW, opts());
    expect(vm.running[0]?.attemptLabel).toBe("#3");
  });

  it("surfaces a running-row error truncated to one line", () => {
    const vm = toViewModel(
      makeSnapshot({ running: [makeRunning({ status: "Failed", error: "line1\nline2" })] }),
      NOW,
      opts(),
    );
    expect(vm.running[0]?.status).toBe("failed");
    expect(vm.running[0]?.error).toBe("line1 line2");
  });

  it("maps every phase rollup defensively (unknown → running)", () => {
    const cases: ReadonlyArray<readonly [string, Status]> = [
      ["PreparingWorkspace", "running"],
      ["Succeeded", "done"],
      ["Failed", "failed"],
      ["TimedOut", "retrying"],
      ["Stalled", "retrying"],
      ["CanceledByReconciliation", "blocked"],
      ["TotallyUnknownPhase", "running"],
    ];
    for (const [phase, status] of cases) {
      const vm = toViewModel(
        makeSnapshot({ running: [makeRunning({ status: phase })] }),
        NOW,
        opts(),
      );
      expect(vm.running[0]?.status).toBe(status);
    }
  });
});

describe("toViewModel — retrying rows (NO countdown)", () => {
  it("shows identifier / attempt / error and never exposes due_at", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    const row = vm.retrying[0];
    expect(row?.identifier).toBe("ORC-2");
    expect(row?.attemptLabel).toBe("#2");
    expect(row?.error).toBe("rate limited");
    // Monotonic due_at_ms must not leak into a (false) countdown.
    expect(JSON.stringify(row)).not.toContain("due");
  });

  it("renders a null retry error as an em dash", () => {
    const vm = toViewModel(
      makeSnapshot({ retrying: [makeRetrying({ error: null })] }),
      NOW,
      opts(),
    );
    expect(vm.retrying[0]?.error).toBe("—");
  });
});

describe("toViewModel — completed (IDs only)", () => {
  it("returns the count plus a few most-recent IDs (newest first)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const vm = toViewModel(
      makeSnapshot({
        completed: many,
        counts: { running: 0, retrying: 0, completed: 12, claimed: 0 },
      }),
      NOW,
      opts(),
    );
    expect(vm.completed.count).toBe(12);
    expect(vm.completed.recentIds).toHaveLength(RECENT_COMPLETED);
    expect(vm.completed.recentIds[0]).toBe("c11");
    expect(vm.header.completedCount).toBe(12);
  });
});

describe("toViewModel — totals + rate-limits (defensive)", () => {
  it("formats token totals and a runtime label", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    expect(vm.totals).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      runtimeLabel: "1m 15s",
    });
  });

  it("reports rate_limits: null as unavailable", () => {
    const vm = toViewModel(makeSnapshot({ rate_limits: null }), NOW, opts());
    expect(vm.rateLimits).toEqual({ available: false, summary: "unavailable" });
  });

  it("summarizes an unknown-shaped rate_limits without assuming a schema", () => {
    const vm = toViewModel(
      makeSnapshot({ rate_limits: { remaining: 5, reset: 123, nested: [1, 2] } }),
      NOW,
      opts(),
    );
    expect(vm.rateLimits.available).toBe(true);
    expect(vm.rateLimits.summary).toContain("remaining");
  });
});

describe("toViewModel — connection banner", () => {
  it("flags a stale connection and surfaces the last poll error", () => {
    const vm = toViewModel(
      makeSnapshot(),
      NOW,
      opts({ connection: "stale", error: "connect ECONNREFUSED" }),
    );
    expect(vm.header.connectionLabel).toBe("stale");
    expect(vm.header.connectionColor).toBe("warn");
    expect(vm.header.error).toBe("connect ECONNREFUSED");
  });
});

describe("formatDuration", () => {
  it("formats seconds / minutes / hours and clamps invalid input", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(3_600_000 + 3 * 60_000 + 9_000)).toBe("1h 03m");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
