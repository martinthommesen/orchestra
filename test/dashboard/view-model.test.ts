import { describe, expect, it } from "vitest";
import {
  EVENTS_RELATIVE_TIME_COLUMN_WIDTH,
  formatDuration,
  RECENT_COMPLETED,
  RELATIVE_LABEL_MAX_WIDTH,
  toViewModel,
  type ViewModelOptions,
} from "../../src/cli/dashboard/view-model";
import type { Status } from "../../src/core/observability/glyphs";
import { statusStyle } from "../../src/core/observability/glyphs";
import {
  makeCompletion,
  makeEvent,
  makeRetrying,
  makeRunning,
  makeSnapshot,
  STARTED_AT,
} from "./fixtures";

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
    expect(row?.badge.label).toBe("running"); // StreamingTurn → running
    expect(row?.badge.known).toBe(true);
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
    expect(vm.running[0]?.badge.label).toBe("failed");
    expect(vm.running[0]?.error).toBe("line1 line2");
  });

  it("rolls every known phase up to its design-system badge", () => {
    const cases: ReadonlyArray<readonly [string, Status]> = [
      ["PreparingWorkspace", "running"],
      ["Succeeded", "done"],
      ["Failed", "failed"],
      ["TimedOut", "retrying"],
      ["Stalled", "retrying"],
      ["CanceledByReconciliation", "blocked"],
    ];
    for (const [phase, status] of cases) {
      const vm = toViewModel(
        makeSnapshot({ running: [makeRunning({ status: phase })] }),
        NOW,
        opts(),
      );
      const style = statusStyle(status);
      expect(vm.running[0]?.badge.label).toBe(style.label);
      expect(vm.running[0]?.badge.color).toBe(style.color);
      expect(vm.running[0]?.badge.known).toBe(true);
    }
  });

  it("renders an unrecognized phase honestly — NOT as running (Fix 1)", () => {
    const vm = toViewModel(
      makeSnapshot({ running: [makeRunning({ status: "TotallyUnknownPhase" })] }),
      NOW,
      opts(),
    );
    const row = vm.running[0];
    expect(row?.badge.known).toBe(false);
    expect(row?.badge.label).toBe("unknown");
    expect(row?.badge.label).not.toBe("running");
    expect(row?.badge.color).toBe("muted");
    // The raw, drifted phase is still surfaced subtly for the operator.
    expect(row?.phase).toBe("TotallyUnknownPhase");
  });

  it("renders an unparseable started_at as an explicit em dash — NOT '0s' (Fix 2)", () => {
    for (const bad of ["not-a-date", "", "2024-13-99T99:99:99Z"]) {
      const vm = toViewModel(
        makeSnapshot({ running: [makeRunning({ started_at: bad })] }),
        NOW,
        opts(),
      );
      expect(vm.running[0]?.elapsedLabel).toBe("—");
      expect(vm.running[0]?.elapsedLabel).not.toBe("0s");
    }
  });
});

describe("toViewModel — retrying rows (NO countdown)", () => {
  it("shows identifier / attempt / error and never exposes the monotonic due_at", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    const row = vm.retrying[0];
    expect(row?.identifier).toBe("ORC-2");
    expect(row?.attemptLabel).toBe("#2");
    expect(row?.error).toBe("rate limited");
    // Older daemon (no scheduled_at/delay_ms) → no honest due time, and the monotonic
    // due_at_ms (99999) must never leak into any field.
    expect(row?.dueAtLabel).toBeNull();
    expect(JSON.stringify(row)).not.toContain("99999");
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

describe("toViewModel — last-activity line (#38)", () => {
  it("formats event_tag + relative time from last_activity", () => {
    const vm = toViewModel(
      makeSnapshot({
        running: [makeRunning({ last_activity: { event_tag: "TurnCompleted", at: STARTED_AT } })],
      }),
      NOW,
      opts(),
    );
    // STARTED_AT is 60s before NOW.
    expect(vm.running[0]?.lastActivityLabel).toBe("TurnCompleted · 1m 00s ago");
  });

  it("is null when no activity has been observed (older daemon)", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    expect(vm.running[0]?.lastActivityLabel).toBeNull();
  });

  it("is null (never a fake 0s) when the activity timestamp is unparseable", () => {
    const vm = toViewModel(
      makeSnapshot({
        running: [makeRunning({ last_activity: { event_tag: "TurnCompleted", at: "not-a-date" } })],
      }),
      NOW,
      opts(),
    );
    expect(vm.running[0]?.lastActivityLabel).toBeNull();
  });
});

describe("toViewModel — retry due time (honest wall-clock, #38)", () => {
  it("derives 'due HH:MM:SSZ' from scheduled_at + delay_ms", () => {
    const vm = toViewModel(
      makeSnapshot({
        retrying: [makeRetrying({ scheduled_at: "2024-01-01T00:01:00.000Z", delay_ms: 65_000 })],
      }),
      NOW,
      opts(),
    );
    // 00:01:00Z + 65s → 00:02:05Z (UTC, not a countdown, not from due_at_ms).
    expect(vm.retrying[0]?.dueAtLabel).toBe("due 00:02:05Z");
  });

  it("is null when either scheduled_at or delay_ms is absent", () => {
    const onlySched = toViewModel(
      makeSnapshot({ retrying: [makeRetrying({ scheduled_at: "2024-01-01T00:01:00.000Z" })] }),
      NOW,
      opts(),
    );
    const onlyDelay = toViewModel(
      makeSnapshot({ retrying: [makeRetrying({ delay_ms: 5000 })] }),
      NOW,
      opts(),
    );
    expect(onlySched.retrying[0]?.dueAtLabel).toBeNull();
    expect(onlyDelay.retrying[0]?.dueAtLabel).toBeNull();
  });

  it("is null when scheduled_at is unparseable", () => {
    const vm = toViewModel(
      makeSnapshot({ retrying: [makeRetrying({ scheduled_at: "nope", delay_ms: 5000 })] }),
      NOW,
      opts(),
    );
    expect(vm.retrying[0]?.dueAtLabel).toBeNull();
  });
});

describe("toViewModel — event feed (#38)", () => {
  it("maps recent_events newest-first with a relative time and truncated message", () => {
    const vm = toViewModel(
      makeSnapshot({
        recent_events: [
          makeEvent({ seq: 1, kind: "started" }),
          makeEvent({ seq: 2, kind: "dispatched" }),
          makeEvent({ seq: 3, kind: "completed" }),
        ],
      }),
      NOW,
      opts(),
    );
    // Wire order is newest-last; the view is newest-first.
    expect(vm.events.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(vm.events[0]?.relativeLabel).toBe("1m 00s ago");
  });

  it("renders '—' for an unparseable emitted_at (never a fake 0s)", () => {
    const vm = toViewModel(
      makeSnapshot({ recent_events: [makeEvent({ emitted_at: "not-a-date" })] }),
      NOW,
      opts(),
    );
    expect(vm.events[0]?.relativeLabel).toBe("—");
  });

  it("picks glyph + color by kind, reusing the design system", () => {
    const cases: ReadonlyArray<readonly [string, "info" | "warn", string, string, string]> = [
      // kind, level, color, glyph, ascii
      ["dispatched", "info", "info", "▶", ">"],
      ["completed", "info", "success", "✓", "+"],
      ["failed", "warn", "danger", "✗", "x"],
      ["killed", "warn", "danger", "✗", "x"],
      ["retry_scheduled", "info", "warn", "⏳", "~"],
    ];
    for (const [kind, level, color, glyph, ascii] of cases) {
      const vm = toViewModel(
        makeSnapshot({ recent_events: [makeEvent({ kind, level })] }),
        NOW,
        opts(),
      );
      expect(vm.events[0]?.color).toBe(color);
      expect(vm.events[0]?.glyph).toBe(glyph);
      expect(vm.events[0]?.ascii).toBe(ascii);
    }
  });

  it("falls back on level for an unknown kind (warn → warn, info → muted)", () => {
    const warn = toViewModel(
      makeSnapshot({ recent_events: [makeEvent({ kind: "mystery", level: "warn" })] }),
      NOW,
      opts(),
    );
    const info = toViewModel(
      makeSnapshot({ recent_events: [makeEvent({ kind: "mystery", level: "info" })] }),
      NOW,
      opts(),
    );
    expect(warn.events[0]?.color).toBe("warn");
    expect(info.events[0]?.color).toBe("muted");
  });
});

describe("toViewModel — rich recent-completed (#38)", () => {
  it("maps recent_completed newest-first with relative time and outcome color", () => {
    const vm = toViewModel(
      makeSnapshot({
        recent_completed: [
          makeCompletion({ issue_id: "a", identifier: "ORC-A", outcome: "completed" }),
          makeCompletion({ issue_id: "b", identifier: "ORC-B", outcome: "killed" }),
        ],
      }),
      NOW,
      opts(),
    );
    expect(vm.recentCompleted.map((c) => c.identifier)).toEqual(["ORC-B", "ORC-A"]);
    expect(vm.recentCompleted[0]?.outcomeColor).toBe("danger"); // killed
    expect(vm.recentCompleted[1]?.outcomeColor).toBe("success"); // completed
    expect(vm.recentCompleted[0]?.relativeLabel).toBe("1m 00s ago");
  });

  it("maps an unknown outcome to a muted tone", () => {
    const vm = toViewModel(
      makeSnapshot({ recent_completed: [makeCompletion({ outcome: "weird" })] }),
      NOW,
      opts(),
    );
    expect(vm.recentCompleted[0]?.outcomeColor).toBe("muted");
  });
});

describe("toViewModel — backward-safe omission (#38)", () => {
  it("an older-daemon snapshot yields empty feeds and null per-row labels", () => {
    const vm = toViewModel(makeSnapshot(), NOW, opts());
    expect(vm.events).toEqual([]);
    expect(vm.recentCompleted).toEqual([]);
    expect(vm.running[0]?.lastActivityLabel).toBeNull();
    expect(vm.retrying[0]?.dueAtLabel).toBeNull();
  });

  it("the empty/connecting state also carries empty feeds", () => {
    const vm = toViewModel(null, NOW, opts({ connection: "connecting", lastUpdatedAtMs: null }));
    expect(vm.events).toEqual([]);
    expect(vm.recentCompleted).toEqual([]);
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

  it("clamps the hour tier to a bounded ceiling so no column can overflow (#45)", () => {
    // The hour tier is otherwise unbounded ("1000h 00m" …). Anything past the ceiling
    // saturates to "99h 59m" — 7 chars — instead of widening without limit.
    expect(formatDuration((99 * 3600 + 59 * 60 + 59) * 1_000)).toBe("99h 59m");
    expect(formatDuration(1_000 * 3_600 * 1_000)).toBe("99h 59m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("relative-time column width contract (#45)", () => {
  // The EVENTS box is a fixed Ink width; a label one char wider wraps "ago" onto its own
  // line. Sweep every tier (incl. the clamped worst case) and a NOW that yields "Xm YYs".
  it("never emits a relative label wider than the column, across the full range", () => {
    const ages = [
      3_000, // "3s ago"
      45_000, // "45s ago"
      64_000, // "1m 04s ago"
      (59 * 60 + 59) * 1_000, // "59m 59s ago" — 11, the bounded worst case
      (99 * 3600 + 59 * 60 + 59) * 1_000, // "99h 59m ago" — 11, clamp ceiling
      1_000 * 3_600 * 1_000, // absurd: still clamped, still fits
    ];
    let widest = 0;
    for (const ageMs of ages) {
      const emittedAt = new Date(NOW - ageMs).toISOString();
      const vm = toViewModel(
        makeSnapshot({ recent_events: [makeEvent({ emitted_at: emittedAt })] }),
        NOW,
        opts(),
      );
      const label = vm.events[0]?.relativeLabel ?? "";
      expect(label.length).toBeLessThan(EVENTS_RELATIVE_TIME_COLUMN_WIDTH);
      widest = Math.max(widest, label.length);
    }
    // The unparseable sentinel must also fit.
    const sentinel = toViewModel(
      makeSnapshot({ recent_events: [makeEvent({ emitted_at: "not-a-date" })] }),
      NOW,
      opts(),
    ).events[0]?.relativeLabel;
    expect(sentinel).toBe("—");
    // The declared max is real (a true worst case exists) and the gutter is exactly 1.
    expect(widest).toBe(RELATIVE_LABEL_MAX_WIDTH);
    expect(EVENTS_RELATIVE_TIME_COLUMN_WIDTH).toBe(RELATIVE_LABEL_MAX_WIDTH + 1);
  });
});
