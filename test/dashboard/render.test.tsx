import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../src/cli/dashboard/components";
import { toViewModel, type ViewModelOptions } from "../../src/cli/dashboard/view-model";
import { makeSnapshot } from "./fixtures";

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
});
