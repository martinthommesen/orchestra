import { ApiError } from "../api/client";
import type { ControlWire } from "../api/types";

/**
 * Sprint 6 / #71 — the Dispatch-control panel's view-state, derived purely from the polled
 * `control` block so it is node-testable without a DOM render.
 *
 * Only the **operator** latch is clearable from the cockpit: `ResumeDispatch` clears ONLY the
 * operator pause, so offering "Resume" while dispatch is held by the BUDGET gate would be a
 * silent no-op. When budget-held we hide the toggle and render guidance instead.
 */
export interface PauseControlModel {
  readonly dispatchPaused: boolean;
  readonly pausedBy: "operator" | "budget" | null;
  /** The operator pause can be resumed from here; a budget pause cannot. */
  readonly canResume: boolean;
  /** Dispatch is held by the budget gate → render guidance, not a dead Resume button. */
  readonly pausedByBudget: boolean;
  /** Whether to render the toggle at all (hidden while budget-held). */
  readonly showToggle: boolean;
  /** What a click does: resume an operator pause, otherwise pause. */
  readonly action: "pause" | "resume";
  readonly buttonLabel: string;
}

export const derivePauseControl = (control: ControlWire | null): PauseControlModel => {
  const dispatchPaused = control?.dispatch_paused ?? false;
  const pausedBy = control?.paused_by ?? null;
  const canResume = dispatchPaused && pausedBy === "operator";
  const pausedByBudget = dispatchPaused && pausedBy === "budget";
  return {
    dispatchPaused,
    pausedBy,
    canResume,
    pausedByBudget,
    showToggle: !pausedByBudget,
    action: canResume ? "resume" : "pause",
    buttonLabel: canResume ? "Resume dispatch" : "Pause dispatch",
  };
};

/** Normalize any thrown value into a user-facing message (`ApiError`/`Error` → its message). */
export const messageOf = (err: unknown): string =>
  err instanceof ApiError || err instanceof Error ? err.message : String(err);
