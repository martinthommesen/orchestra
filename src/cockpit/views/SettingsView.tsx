import { useEffect, useState } from "react";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import type { EditableSettingsWire } from "../api/types";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Panel } from "../components/Panel";
import { derivePauseControl, messageOf } from "../model/pause-control";
import {
  type FieldId,
  type SettingsFormModel,
  toFormModel,
  validateSettings,
} from "../model/settings";
import { usePolling } from "../usePolling";

/**
 * Sprint 6 / #71 — the Settings view + global Pause/Resume toggle.
 *
 * The form is built from `GET /api/v1/settings` (the whitelisted subset — never any secret/
 * `tracker` key), validated client-side against the same schema (`validateSettings`, pure), and
 * saved via `PUT /api/v1/settings`. The Pause/Resume toggle reflects the live
 * `control.dispatch_paused`/`paused_by` from the polled snapshot and calls the control endpoints.
 */

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; message: string };

export const SettingsView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const control = poll.data?.control ?? null;

  const [form, setForm] = useState<SettingsFormModel | null>(null);
  // The originally-loaded settings, retained so a save can send a SPARSE patch (only the
  // fields that actually changed) — a scalar-only edit then stays on the backend's
  // byte-verbatim front-matter path (#73) instead of forcing a structural reformat.
  const [baseline, setBaseline] = useState<EditableSettingsWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [pauseBusy, setPauseBusy] = useState(false);
  // A pause/resume failure (401 missing dev token, 503 command timeout, network) must SURFACE —
  // mirrors the Save/Kanban error pattern instead of becoming a silent unhandled rejection.
  const [pauseError, setPauseError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .getSettings()
      .then((s) => {
        if (alive) {
          setForm(toFormModel(s));
          setBaseline(s);
        }
      })
      .catch((err) => {
        if (alive) setLoadError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const validation = form === null || baseline === null ? null : validateSettings(form, baseline);

  const onSave = async () => {
    if (form === null || validation === null || !validation.ok || validation.patch === undefined) {
      return;
    }
    setSave({ phase: "saving" });
    try {
      const updated = await client.putSettings(validation.patch);
      setForm(toFormModel(updated));
      setBaseline(updated);
      setSave({ phase: "saved" });
    } catch (err) {
      setSave({ phase: "error", message: messageOf(err) });
    }
  };

  // Only the operator latch is clearable from here: `ResumeDispatch` clears ONLY the operator
  // pause, so offering "Resume" while dispatch is held by the BUDGET gate would be a no-op
  // (confusing UX). When paused by budget we render guidance instead of a dead button.
  const pause = derivePauseControl(control);

  const togglePause = async () => {
    setPauseBusy(true);
    setPauseError(null);
    try {
      await (pause.action === "resume" ? client.resume() : client.pause());
    } catch (err) {
      setPauseError(messageOf(err));
    } finally {
      setPauseBusy(false);
    }
  };

  const patch = (next: Partial<SettingsFormModel>) =>
    setForm((f) => (f === null ? f : { ...f, ...next }));

  return (
    <>
      <ConnectionBanner connection={poll.connection} error={poll.error} updatedLabel={null} />

      <Panel title="Dispatch control">
        <div className="pause-toggle">
          <div>
            <strong>
              {pause.dispatchPaused
                ? `Dispatch is paused${pause.pausedBy ? ` (by ${pause.pausedBy})` : ""}`
                : "Dispatch is running"}
            </strong>
            <p className="muted">
              {pause.pausedByBudget
                ? "Paused by the budget gate — raise or clear the token ceiling below to resume."
                : "Pausing withholds new sessions only — in-flight work keeps running."}
            </p>
          </div>
          {pause.showToggle ? (
            <button
              type="button"
              className="btn"
              disabled={pauseBusy}
              onClick={togglePause}
              aria-pressed={pause.dispatchPaused}
            >
              {pauseBusy ? "…" : pause.buttonLabel}
            </button>
          ) : null}
        </div>
        {pauseError !== null ? (
          <p className="card__error" role="alert">
            Dispatch control failed: {pauseError}
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Settings"
        actions={
          <button
            type="button"
            className="btn"
            disabled={form === null || save.phase === "saving" || validation?.ok === false}
            onClick={onSave}
          >
            {save.phase === "saving" ? "Saving…" : "Save"}
          </button>
        }
      >
        {loadError !== null ? (
          <p className="card__error" role="alert">
            Failed to load settings: {loadError}
          </p>
        ) : form === null || validation === null ? (
          <p className="view-placeholder">Loading settings…</p>
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
            <NumberField
              id="intervalMs"
              label="Poll interval (ms)"
              value={form.intervalMs}
              error={validation.errors.intervalMs}
              onChange={(v) => patch({ intervalMs: v })}
            />
            <NumberField
              id="maxConcurrentAgents"
              label="Max concurrent agents"
              value={form.maxConcurrentAgents}
              error={validation.errors.maxConcurrentAgents}
              onChange={(v) => patch({ maxConcurrentAgents: v })}
            />
            <NumberField
              id="maxTurns"
              label="Max turns"
              value={form.maxTurns}
              error={validation.errors.maxTurns}
              onChange={(v) => patch({ maxTurns: v })}
            />
            <NumberField
              id="maxRetryBackoffMs"
              label="Max retry backoff (ms)"
              value={form.maxRetryBackoffMs}
              error={validation.errors.maxRetryBackoffMs}
              onChange={(v) => patch({ maxRetryBackoffMs: v })}
            />
            <NumberField
              id="maxTotalTokens"
              label="Max total tokens (blank = no ceiling)"
              value={form.maxTotalTokens}
              error={validation.errors.maxTotalTokens}
              onChange={(v) => patch({ maxTotalTokens: v })}
              allowEmpty
            />

            {form.byState.length > 0 ? (
              <fieldset className="settings-fieldset">
                <legend>Per-state concurrency</legend>
                {form.byState.map((row) => (
                  <NumberField
                    key={row.state}
                    id={`byState:${row.state}` as FieldId}
                    label={row.state}
                    value={row.value}
                    error={validation.errors[`byState:${row.state}`]}
                    onChange={(v) =>
                      patch({
                        byState: form.byState.map((r) =>
                          r.state === row.state ? { ...r, value: v } : r,
                        ),
                      })
                    }
                  />
                ))}
              </fieldset>
            ) : null}

            {save.phase === "saved" ? <p className="settings-ok">Settings saved.</p> : null}
            {save.phase === "error" ? (
              <p className="card__error" role="alert">
                Save failed: {save.message}
              </p>
            ) : null}
          </form>
        )}
      </Panel>
    </>
  );
};

const NumberField = ({
  id,
  label,
  value,
  error,
  onChange,
  allowEmpty,
}: {
  id: FieldId;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={allowEmpty ? undefined : 1}
      value={value}
      aria-invalid={error !== undefined}
      onChange={(e) => onChange(e.target.value)}
    />
    {error !== undefined ? (
      <span className="field__error" role="alert">
        {error}
      </span>
    ) : null}
  </div>
);
