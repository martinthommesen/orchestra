import { useEffect, useState } from "react";
import { describeError } from "../api/errors";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import type { EditableSettingsWire } from "../api/types";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { DispatchControl } from "../components/DispatchControl";
import { Panel } from "../components/Panel";
import {
  type FieldId,
  type SettingsFormModel,
  toFormModel,
  validateSettings,
} from "../model/settings";
import { usePolling } from "../usePolling";

/**
 * Sprint 6 / #71 — the Settings view + global Pause/Resume control.
 *
 * The form is built from `GET /api/v1/settings` (the whitelisted subset — never any secret/
 * `tracker` key), validated client-side against the same schema (`validateSettings`, pure), and
 * saved via `PUT /api/v1/settings`. The shared `DispatchControl` reflects the live
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
        if (alive) setLoadError(describeError(err));
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
      setSave({ phase: "error", message: describeError(err) });
    }
  };

  const patch = (next: Partial<SettingsFormModel>) =>
    setForm((f) => (f === null ? f : { ...f, ...next }));

  return (
    <>
      <ConnectionBanner connection={poll.connection} error={poll.error} updatedLabel={null} />

      <Panel title="Dispatch control">
        <DispatchControl control={control} />
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
              hint="How often the daemon scans for work and refreshes this view. Lower is more responsive but adds load."
              value={form.intervalMs}
              error={validation.errors.intervalMs}
              onChange={(v) => patch({ intervalMs: v })}
            />
            <NumberField
              id="maxConcurrentAgents"
              label="Max concurrent agents"
              hint="Hard ceiling on sessions running at once, across every issue state."
              value={form.maxConcurrentAgents}
              error={validation.errors.maxConcurrentAgents}
              onChange={(v) => patch({ maxConcurrentAgents: v })}
            />
            <NumberField
              id="maxTurns"
              label="Max turns"
              hint="A session is stopped after this many agent turns, even if it hasn't finished."
              value={form.maxTurns}
              error={validation.errors.maxTurns}
              onChange={(v) => patch({ maxTurns: v })}
            />
            <NumberField
              id="maxRetryBackoffMs"
              label="Max retry backoff (ms)"
              hint="Upper bound on the exponential wait between retries of a failed attempt."
              value={form.maxRetryBackoffMs}
              error={validation.errors.maxRetryBackoffMs}
              onChange={(v) => patch({ maxRetryBackoffMs: v })}
            />
            <NumberField
              id="maxTotalTokens"
              label="Max total tokens (blank = no ceiling)"
              hint="When set, dispatch auto-pauses once total token spend crosses this budget."
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
  hint,
  value,
  error,
  onChange,
  allowEmpty,
}: {
  id: FieldId;
  label: string;
  hint?: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}) => {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={allowEmpty ? undefined : 1}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== undefined ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
};
