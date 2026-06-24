import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../src/cli/dashboard/components";
import { toViewModel, type ViewModelOptions } from "../../src/cli/dashboard/view-model";
import { makeCompletion, makeEvent, makeRunning, makeSnapshot, STARTED_AT } from "./fixtures";

/**
 * #33 — light ink-testing-library render asserts. The view-model carries the logic and
 * is tested exhaustively elsewhere, so these only confirm each major state reaches the
 * frame and that `--ascii` swaps the glyph set. We deliberately avoid brittle full-frame
 * string snapshots.
 */

const NOW = Date.parse("2024-01-01T00:01:00.000Z");
const opts = (over: Partial<ViewModelOptions> = {}): ViewModelOptions => ({
  connection: "live",
  error: null,
  lastUpdatedAtMs: NOW,
  baseUrl: "http://127.0.0.1:4317",
  ...over,
});

const frameOf = (
  snapshot: Parameters<typeof toViewModel>[0],
  o: ViewModelOptions,
  ascii = false,
) => {
  const vm = toViewModel(snapshot, NOW, o);
  // color off keeps the frame ANSI-free and stable to assert against.
  const { lastFrame } = render(<DashboardView vm={vm} ascii={ascii} color={false} />);
  return lastFrame() ?? "";
};

describe("DashboardView", () => {
  it("renders the populated fleet view (running / retrying / completed / totals / limits)", () => {
    const frame = frameOf(makeSnapshot(), opts());
    expect(frame).toContain("orchestra dashboard");
    expect(frame).toContain("http://127.0.0.1:4317");
    expect(frame).toContain("live");
    expect(frame).toContain("ORC-1");
    expect(frame).toContain("running");
    expect(frame).toContain("1m 00s");
    expect(frame).toContain("RETRYING");
    expect(frame).toContain("ORC-2");
    expect(frame).toContain("rate limited");
    expect(frame).toContain("COMPLETED");
    expect(frame).toContain("total 140");
    expect(frame).toContain("unavailable"); // rate_limits null
    expect(frame).toContain("press q to quit");
  });

  it("renders an empty / connecting state without crashing", () => {
    const frame = frameOf(null, opts({ connection: "connecting", lastUpdatedAtMs: null }));
    expect(frame).toContain("connecting");
    expect(frame).toContain("none");
  });

  it("uses Unicode glyphs by default and ASCII fallbacks with --ascii", () => {
    const unicode = frameOf(makeSnapshot(), opts());
    expect(unicode).toContain("▶ running");

    const ascii = frameOf(makeSnapshot(), opts(), true);
    expect(ascii).toContain("> running");
    expect(ascii).not.toContain("▶");
  });

  it("surfaces a stale banner and the last error", () => {
    const frame = frameOf(
      makeSnapshot(),
      opts({ connection: "stale", error: "connect ECONNREFUSED" }),
    );
    expect(frame).toContain("stale");
    expect(frame).toContain("connect ECONNREFUSED");
  });

  it("renders an unrecognized phase as 'unknown', not the running badge (Fix 1)", () => {
    const frame = frameOf(
      makeSnapshot({ running: [makeRunning({ status: "DriftedPhase" })] }),
      opts(),
    );
    expect(frame).toContain("? unknown");
    // The running status badge must not appear (header "running 1" is a count, not a badge).
    expect(frame).not.toContain("▶ running");
    // The raw drifted phase is still surfaced subtly so the operator can diagnose it.
    expect(frame).toContain("phase=DriftedPhase");
  });

  it("renders the event feed, last-activity line, and rich completed panels (#38)", () => {
    const frame = frameOf(
      makeSnapshot({
        running: [makeRunning({ last_activity: { event_tag: "TurnCompleted", at: STARTED_AT } })],
        recent_events: [makeEvent({ kind: "completed", message: "completed ORC-1" })],
        recent_completed: [makeCompletion({ identifier: "ORC-9", outcome: "completed" })],
      }),
      opts(),
    );
    expect(frame).toContain("EVENTS");
    expect(frame).toContain("completed ORC-1");
    expect(frame).toContain("TurnCompleted · 1m 00s ago");
    expect(frame).toContain("RECENTLY FINISHED");
    expect(frame).toContain("ORC-9");
  });

  it("omits the new panels for an older-daemon snapshot — identical Sprint 2 view (#38)", () => {
    const frame = frameOf(makeSnapshot(), opts());
    expect(frame).not.toContain("EVENTS");
    expect(frame).not.toContain("RECENTLY FINISHED");
    expect(frame).not.toContain("↳");
  });

  it("keeps an aged event's relative time and message on one row (no wrap, #45)", () => {
    // 2m 05s before NOW → "2m 05s ago" (10 chars): the case the old width=9 box wrapped.
    const emittedAt = new Date(NOW - (2 * 60 + 5) * 1_000).toISOString();
    const frame = frameOf(
      makeSnapshot({
        recent_events: [
          makeEvent({ kind: "completed", emitted_at: emittedAt, message: "aged ORC-1" }),
        ],
      }),
      opts(),
    );
    const lines = frame.split("\n").map((l) => l.trimEnd());
    // The label and its message must share one line; "ago" must never be stranded alone.
    expect(lines.some((l) => l.includes("2m 05s ago") && l.includes("aged ORC-1"))).toBe(true);
    expect(lines.some((l) => l.trimStart() === "ago")).toBe(false);
  });

  it("swaps event-feed glyphs for ASCII with --ascii (#38)", () => {
    const snap = makeSnapshot({
      recent_events: [makeEvent({ kind: "completed", message: "completed ORC-1" })],
    });
    expect(frameOf(snap, opts())).toContain("✓");
    const ascii = frameOf(snap, opts(), true);
    expect(ascii).toContain("+ ");
    expect(ascii).not.toContain("✓");
  });
});
