import { useState } from "react";
import { describeError } from "../api/errors";
import { client } from "../api/instance";
import type { ControlWire } from "../api/types";
import { derivePauseControl } from "../model/pause-control";
import type { ToastTone } from "./Toast";

/**
 * The global dispatch Pause/Resume control. Surfaced on the Fleet default view (operator safety:
 * pausing the whole fleet must not be buried in Settings) and reused verbatim in Settings. View
 * state is derived purely (`derivePauseControl`) from the polled `control` block; this component
 * owns only the in-flight busy/error of the mutating call, and the next poll the parent view
 * already runs reflects the new state. Only the OPERATOR latch is clearable here — a budget pause
 * hides the toggle and shows guidance instead of a dead, no-op button. A successful toggle surfaces
 * a transient toast via `onNotify` (when provided); errors still render inline too.
 */
export const DispatchControl = ({
  control,
  onNotify,
}: {
  control: ControlWire | null;
  onNotify?: (tone: ToastTone, message: string) => void;
}) => {
  const pause = derivePauseControl(control);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await (pause.action === "resume" ? client.resume() : client.pause());
      onNotify?.("success", pause.action === "resume" ? "Dispatch resumed" : "Dispatch paused");
    } catch (err) {
      const msg = describeError(err);
      setError(msg);
      onNotify?.("danger", `Dispatch control failed: ${msg}`);
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
          className={pause.action === "pause" ? "btn btn--warn" : "btn btn--primary"}
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
