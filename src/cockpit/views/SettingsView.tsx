import { useEffect, useState } from "react";
import { describeError } from "../api/errors";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import type { EditableSettingsWire } from "../api/types";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { DispatchControl } from "../components/DispatchControl";
import { Panel } from "../components/Panel";
import { SkeletonForm } from "../components/Skeleton";
import { ToastRegion, useToast, useToastAutoDismiss } from "../components/Toast";
import {
  type FieldId,
  isDirty,
  type SettingsFormModel,
  toFormModel,
  validateSettings,
} from "../model/settings";
import { usePolling } from "../usePolling";

/**
 * The Settings view + global Pause/Resume control.
 *
 * The form is built from `GET /api/v1/settings` (the whitelisted subset — never any secret/
 * `tracker` key), validated client-side against the same schema (`validateSettings`, pure), and
 * saved via `PUT /api/v1/settings`. The shared `DispatchControl` reflects the live
 * `control.dispatch_paused`/`paused_by` from the polled snapshot and calls the control endpoints.
 * Fields are grouped into Polling / Agent / Budget sections; an unsaved-changes indicator gates the
 * Save button and a Reset restores the loaded baseline. Save success/failure surfaces a toast.
 */

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; message: string };

export const SettingsView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const control = poll.data?.control ?? null;
  const toast = useToast();
  useToastAutoDismiss(toast.toasts, toast.dismiss);

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
  const dirty = form !== null && baseline !== null && isDirty(form, baseline);
  const canSave =
    form !== null && validation !== null && validation.ok && dirty && save.phase !== "saving";

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
      toast.notify("success", "Settings saved");
    } catch (err) {
      const msg = describeError(err);
      setSave({ phase: "error", message: msg });
      toast.notify("danger", `Save failed: ${msg}`);
    }
  };

  const patch = (next: Partial<SettingsFormModel>) =>
    setForm((f) => (f === null ? f : { ...f, ...next }));

  const reset = () => {
    if (baseline !== null) {
      setForm(toFormModel(baseline));
      setSave({ phase: "idle" });
    }
  };

  return (
    <>
      <ConnectionBanner
        connection={poll.connection}
        error={poll.error}
        updatedLabel={null}
        intervalMs={COCKPIT_POLL_MS}
        lastUpdatedAtMs={poll.lastUpdatedAtMs}
      />

      <Panel title="Dispatch control">
        <DispatchControl control={control} onNotify={toast.notify} />
      </Panel>

      <Panel
        title="Settings"
        actions={
          <div className="panel__actions">
            {dirty ? <span className="settings-dirty">Unsaved changes</span> : null}
            <button
              type="button"
              className="btn btn--sm"
              disabled={!dirty || save.phase === "saving"}
              onClick={reset}
              title="Revert to the loaded values"
            >
              Reset
            </button>
            <button type="button" className="btn btn--primary" disabled={!canSave} onClick={onSave}>
              {dirty ? <span className="btn__dot" aria-hidden="true" /> : null}
              {save.phase === "saving" ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        {loadError !== null ? (
          <p className="card__error" role="alert">
            Failed to load settings: {loadError}
          </p>
        ) : form === null || validation === null ? (
          <SkeletonForm fields={5} />
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
            <section className="settings-section">
              <h3 className="settings-section__head">Polling</h3>
              <NumberField
                id="intervalMs"
                label="Poll interval (ms)"
                hint="How often the daemon scans for work and refreshes this view. Lower is more responsive but adds load."
                value={form.intervalMs}
                error={validation.errors.intervalMs}
                onChange={(v) => patch({ intervalMs: v })}
              />
            </section>

            <section className="settings-section">
              <h3 className="settings-section__head">Agent</h3>
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
                id="maxFailureRetries"
                label="Max failure retries"
                hint="Failed attempts are parked after this many retries; set 0 to fail fast."
                value={form.maxFailureRetries}
                error={validation.errors.maxFailureRetries}
                onChange={(v) => patch({ maxFailureRetries: v })}
              />
              <NumberField
                id="maxRetryBackoffMs"
                label="Max retry backoff (ms)"
                hint="Upper bound on the exponential wait between retries of a failed attempt."
                value={form.maxRetryBackoffMs}
                error={validation.errors.maxRetryBackoffMs}
                onChange={(v) => patch({ maxRetryBackoffMs: v })}
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
            </section>

            <section className="settings-section">
              <h3 className="settings-section__head">Budget</h3>
              <NumberField
                id="maxTotalTokens"
                label="Max total tokens (blank = no ceiling)"
                hint="When set, dispatch auto-pauses once total token spend crosses this budget."
                value={form.maxTotalTokens}
                error={validation.errors.maxTotalTokens}
                onChange={(v) => patch({ maxTotalTokens: v })}
                allowEmpty
              />
            </section>

            {save.phase === "saved" ? <p className="settings-ok">Settings saved.</p> : null}
            {save.phase === "error" ? (
              <p className="card__error" role="alert">
                Save failed: {save.message}
              </p>
            ) : null}
          </form>
        )}
      </Panel>
      <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
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
