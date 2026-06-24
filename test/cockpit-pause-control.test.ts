import { describe, expect, it } from "vitest";
import { ApiError } from "../src/cockpit/api/client";
import type { ControlWire } from "../src/cockpit/api/types";
import { derivePauseControl, messageOf } from "../src/cockpit/model/pause-control";

/**
 * Sprint 6 / PR #74 review — the Dispatch-control panel's pure view-state. Proves the
 * operator-vs-budget toggle policy and the error-normalization that surfaces a rejected
 * pause/resume (instead of swallowing it into an unhandled rejection).
 */
describe("derivePauseControl", () => {
  it("running: offers Pause, no error guidance", () => {
    const m = derivePauseControl(null);
    expect(m.dispatchPaused).toBe(false);
    expect(m.showToggle).toBe(true);
    expect(m.action).toBe("pause");
    expect(m.buttonLabel).toBe("Pause dispatch");
    expect(m.pausedByBudget).toBe(false);
  });

  it("operator-paused: offers Resume (the operator latch is clearable here)", () => {
    const control: ControlWire = { dispatch_paused: true, paused_by: "operator" };
    const m = derivePauseControl(control);
    expect(m.canResume).toBe(true);
    expect(m.showToggle).toBe(true);
    expect(m.action).toBe("resume");
    expect(m.buttonLabel).toBe("Resume dispatch");
  });

  it("budget-paused: hides the toggle (Resume would be a silent no-op)", () => {
    const control: ControlWire = { dispatch_paused: true, paused_by: "budget" };
    const m = derivePauseControl(control);
    expect(m.pausedByBudget).toBe(true);
    expect(m.showToggle).toBe(false);
    expect(m.canResume).toBe(false);
  });
});

describe("messageOf", () => {
  it("surfaces an ApiError's message (e.g. a 503/401 from a rejected pause)", () => {
    expect(messageOf(new ApiError(503, "service_unavailable", "owner busy"))).toBe("owner busy");
  });

  it("surfaces a plain Error's message (e.g. a network failure)", () => {
    expect(messageOf(new Error("network down"))).toBe("network down");
  });

  it("stringifies any other thrown value", () => {
    expect(messageOf("boom")).toBe("boom");
  });
});
