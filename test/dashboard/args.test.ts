import { describe, expect, it } from "vitest";
import { DASHBOARD_DEFAULTS, parseDashboardArgs } from "../../src/cli/dashboard/args";

/**
 * #30 — the dashboard owns a SEPARATE argument parser from the daemon's `parseArgs`,
 * so neither has to become a "sometimes a workflow path, sometimes a subcommand"
 * hybrid. These tests pin its grammar, defaults, and error reporting.
 */

describe("parseDashboardArgs", () => {
  it("applies defaults when no flags are given", () => {
    const result = parseDashboardArgs([]);
    expect(result).toEqual({ kind: "run", options: DASHBOARD_DEFAULTS });
  });

  it("parses --flag value and --flag=value forms", () => {
    for (const argv of [
      ["--port", "5000", "--host", "0.0.0.0", "--interval-ms", "250", "--ascii"],
      ["--port=5000", "--host=0.0.0.0", "--interval-ms=250", "--ascii"],
    ]) {
      const result = parseDashboardArgs(argv);
      expect(result).toEqual({
        kind: "run",
        options: { host: "0.0.0.0", port: 5000, intervalMs: 250, ascii: true },
      });
    }
  });

  it("returns help for --help / -h", () => {
    expect(parseDashboardArgs(["--help"]).kind).toBe("help");
    expect(parseDashboardArgs(["-h"]).kind).toBe("help");
  });

  it("rejects out-of-range or non-integer ports", () => {
    for (const bad of ["0", "70000", "abc", "-1", "1.5"]) {
      const result = parseDashboardArgs(["--port", bad]);
      expect(result.kind).toBe("error");
    }
  });

  it("rejects a non-positive interval", () => {
    for (const bad of ["0", "-5", "x"]) {
      expect(parseDashboardArgs(["--interval-ms", bad]).kind).toBe("error");
    }
  });

  it("rejects a missing --host value and unknown options", () => {
    expect(parseDashboardArgs(["--host"]).kind).toBe("error");
    const unknown = parseDashboardArgs(["--frobnicate"]);
    expect(unknown).toEqual({ kind: "error", message: "unknown option: --frobnicate" });
  });

  it("does not mutate the shared defaults object", () => {
    parseDashboardArgs(["--port", "9999", "--ascii"]);
    expect(DASHBOARD_DEFAULTS).toEqual({
      host: "127.0.0.1",
      port: 4317,
      intervalMs: 1000,
      ascii: false,
    });
  });
});
