import { describe, expect, it } from "vitest";
import type { ControlWire } from "../src/cockpit/api/types";
import { derivePauseControl } from "../src/cockpit/model/pause-control";

/**
 * Sprint 6 / PR #74 review — the Dispatch-control panel's pure view-state. Proves the
 * operator-vs-budget toggle policy; the error-normalization that surfaces a rejected pause/resume
 * now lives in `describeError` (see `cockpit-errors.test.ts`).
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
