import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RunAttemptPhase } from "../src/core/domain/run-attempt";
import {
  colorize,
  DEFAULT_MAX_LEN,
  ELLIPSIS,
  formatStatus,
  glyph,
  PHASE_TO_STATUS,
  phaseStatus,
  STATUS_STYLES,
  type Status,
  shouldUseColor,
  statusStyle,
  truncate,
  truncateOneLine,
} from "../src/core/observability/glyphs";

const ALL_STATUSES: ReadonlyArray<Status> = ["running", "retrying", "blocked", "done", "failed"];

const ALL_PHASES: ReadonlyArray<RunAttemptPhase> = [
  "PreparingWorkspace",
  "BuildingPrompt",
  "LaunchingAgentProcess",
  "InitializingSession",
  "StreamingTurn",
  "Finishing",
  "Succeeded",
  "Failed",
  "TimedOut",
  "Stalled",
  "CanceledByReconciliation",
];

describe("status glyphs (Sprint 0 Task 8)", () => {
  it("exposes the five planned glyphs", () => {
    expect(glyph("running")).toBe("▶");
    expect(glyph("retrying")).toBe("⏳");
    expect(glyph("blocked")).toBe("⏸");
    expect(glyph("done")).toBe("✓");
    expect(glyph("failed")).toBe("✗");
  });

  it("every status has a complete, self-consistent style", () => {
    for (const status of ALL_STATUSES) {
      const style = statusStyle(status);
      expect(style.status).toBe(status);
      expect(style.label).toBe(status);
      expect(style.glyph.length).toBeGreaterThan(0);
      expect(style.ascii.length).toBeGreaterThan(0);
      expect(STATUS_STYLES[status]).toBe(style);
    }
  });

  it("formats a status badge as '<glyph> <label>'", () => {
    expect(formatStatus("done")).toBe("✓ done");
    expect(formatStatus("running", { ascii: true })).toBe("> running");
  });

  it("emits ASCII fallbacks on request", () => {
    expect(glyph("failed", true)).toBe("x");
  });
});

describe("colorize / shouldUseColor", () => {
  it("wraps text in SGR codes only when enabled", () => {
    const plain = colorize("hi", "danger", false);
    const colored = colorize("hi", "danger", true);
    expect(plain).toBe("hi");
    expect(colored).toContain("hi");
    expect(colored.startsWith("\x1b[")).toBe(true);
    expect(colored.endsWith("\x1b[0m")).toBe(true);
  });

  it("colorized formatStatus still contains the readable label (color is never the only signal)", () => {
    expect(formatStatus("failed", { color: true })).toContain("✗ failed");
  });

  it("honors NO_COLOR, FORCE_COLOR, and the TTY bit", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "1" }, isTTY: true })).toBe(false);
    expect(shouldUseColor({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
    expect(shouldUseColor({ env: {}, isTTY: true })).toBe(true);
    expect(shouldUseColor({ env: {}, isTTY: false })).toBe(false);
    expect(shouldUseColor()).toBe(false);
  });
});

describe("truncate / truncateOneLine", () => {
  it("leaves short strings untouched and appends ellipsis when cutting", () => {
    expect(truncate("short", 120)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcdefghij", 5).length).toBe(5);
  });

  it("defaults to DEFAULT_MAX_LEN", () => {
    const long = "a".repeat(DEFAULT_MAX_LEN + 50);
    expect(truncate(long).length).toBe(DEFAULT_MAX_LEN);
    expect(truncate(long).endsWith(ELLIPSIS)).toBe(true);
  });

  it("collapses whitespace/newlines to a single line", () => {
    expect(truncateOneLine("line one\nline\ttwo   three")).toBe("line one line two three");
    expect(truncateOneLine("  padded \n\n out  ")).toBe("padded out");
  });

  it("property: truncate output never exceeds max", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 200 }), (text, max) => {
        expect(truncate(text, max).length).toBeLessThanOrEqual(max);
      }),
    );
  });

  it("property: truncateOneLine output has no newline or tab characters", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const out = truncateOneLine(text, 1000);
        expect(/[\n\r\t]/.test(out)).toBe(false);
      }),
    );
  });
});

describe("phase → status rollup", () => {
  it("maps every RunAttemptPhase to a valid status (exhaustive, total)", () => {
    for (const phase of ALL_PHASES) {
      const status = phaseStatus(phase);
      expect(ALL_STATUSES).toContain(status);
      expect(PHASE_TO_STATUS[phase]).toBe(status);
    }
  });

  it("rolls the documented phases to the right statuses", () => {
    expect(phaseStatus("StreamingTurn")).toBe("running");
    expect(phaseStatus("Succeeded")).toBe("done");
    expect(phaseStatus("Failed")).toBe("failed");
    expect(phaseStatus("TimedOut")).toBe("retrying");
    expect(phaseStatus("Stalled")).toBe("retrying");
    expect(phaseStatus("CanceledByReconciliation")).toBe("blocked");
  });
});
