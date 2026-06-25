import { useState } from "react";
import { describeError } from "../api/errors";
import { client } from "../api/instance";
import type { ControlWire } from "../api/types";
import { derivePauseControl } from "../model/pause-control";

/**
 * Sprint 6 / #71 — the global dispatch Pause/Resume control. Surfaced on the Fleet default view
 * (operator safety: pausing the whole fleet must not be buried in Settings) and reused verbatim in
 * Settings. View-state is derived purely (`derivePauseControl`) from the polled `control` block;
 * this component owns only the in-flight busy/error of the mutating call, and the next poll the
 * parent view already runs reflects the new state. Only the OPERATOR latch is clearable here — a
 * budget pause hides the toggle and shows guidance instead of a dead, no-op button.
 */
export const DispatchControl = ({ control }: { control: ControlWire | null }) => {
  const pause = derivePauseControl(control);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await (pause.action === "resume" ? client.resume() : client.pause());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dispatch-control">
      <div className="dispatch-control__state">
        <span
          className={`dispatch-control__dot ${pause.dispatchPaused ? "is-paused" : "is-running"}`}
          aria-hidden="true"
        />
        <div>
          <strong>
            {pause.dispatchPaused
              ? `Dispatch paused${pause.pausedBy ? ` (by ${pause.pausedBy})` : ""}`
              : "Dispatch running"}
          </strong>
          <p className="dispatch-control__hint muted">
            {pause.pausedByBudget
              ? "Held by the budget gate — raise or clear the token ceiling in Settings to resume."
              : "Pausing withholds new sessions only — in-flight work keeps running."}
          </p>
        </div>
      </div>
      {pause.showToggle ? (
        <button
          type="button"
          className={pause.action === "pause" ? "btn btn--warn" : "btn"}
          disabled={busy}
          onClick={toggle}
          aria-pressed={pause.dispatchPaused}
        >
          {busy ? "…" : pause.buttonLabel}
        </button>
      ) : null}
      {error !== null ? (
        <p className="dispatch-control__error card__error" role="alert">
          Dispatch control failed: {error}
        </p>
      ) : null}
    </div>
  );
};
