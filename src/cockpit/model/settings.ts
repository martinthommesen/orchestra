import type { EditableSettingsWire, SettingsPatchWire } from "../api/types";

/**
 * Sprint 6 / #71 — the pure settings form-model + validation. Mirrors the daemon's whitelist
 * schema (`workflow-file.ts`: every numeric knob is a `PositiveInt` — an integer > 0 — and
 * `budget.max_total_tokens` is null-or-PositiveInt where null clears the ceiling). Kept pure so
 * the React form stays a thin controlled-input layer and the rules are unit-tested under Node.
 *
 * Secret-safety: the model is built ONLY from `EditableSettingsWire` (the whitelisted subset that
 * never includes `tracker`/secrets) and emits ONLY a `SettingsPatchWire` over the same whitelist —
 * so no secret is ever read into, rendered by, or sent from the form.
 */

/** A by-state concurrency override row (key fixed, value editable as a string). */
export interface ByStateRow {
  readonly state: string;
  readonly value: string;
}

/** The controlled-input form model: numbers as strings so partial typing is representable. */
export interface SettingsFormModel {
  readonly intervalMs: string;
  readonly maxConcurrentAgents: string;
  readonly maxTurns: string;
  readonly maxRetryBackoffMs: string;
  /** Empty string means "no ceiling" (→ null on the wire). */
  readonly maxTotalTokens: string;
  readonly byState: ReadonlyArray<ByStateRow>;
}

/** Stable field ids for error mapping (by-state rows use `byState:<state>`). */
export type FieldId =
  | "intervalMs"
  | "maxConcurrentAgents"
  | "maxTurns"
  | "maxRetryBackoffMs"
  | "maxTotalTokens"
  | `byState:${string}`;

export type FieldErrors = Partial<Record<FieldId, string>>;

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: FieldErrors;
  /** The whitelisted patch — present only when `ok`. */
  readonly patch?: SettingsPatchWire;
}

/** Build the editable form model from the wire settings. */
export const toFormModel = (s: EditableSettingsWire): SettingsFormModel => ({
  intervalMs: String(s.polling.interval_ms),
  maxConcurrentAgents: String(s.agent.max_concurrent_agents),
  maxTurns: String(s.agent.max_turns),
  maxRetryBackoffMs: String(s.agent.max_retry_backoff_ms),
  maxTotalTokens: s.budget.max_total_tokens === null ? "" : String(s.budget.max_total_tokens),
  byState: Object.entries(s.agent.max_concurrent_agents_by_state)
    .map(([state, value]) => ({ state, value: String(value) }))
    .sort((a, b) => a.state.localeCompare(b.state)),
});

const POSITIVE_INT_MSG = "must be a whole number greater than 0";

/** Parse a string as a PositiveInt (integer > 0); returns null when invalid. */
const parsePositiveInt = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Validate the form against the whitelist schema and, when valid, build the patch. */
export const validateSettings = (form: SettingsFormModel): ValidationResult => {
  const errors: Record<string, string> = {};

  const interval = parsePositiveInt(form.intervalMs);
  if (interval === null) errors.intervalMs = POSITIVE_INT_MSG;

  const maxAgents = parsePositiveInt(form.maxConcurrentAgents);
  if (maxAgents === null) errors.maxConcurrentAgents = POSITIVE_INT_MSG;

  const maxTurns = parsePositiveInt(form.maxTurns);
  if (maxTurns === null) errors.maxTurns = POSITIVE_INT_MSG;

  const backoff = parsePositiveInt(form.maxRetryBackoffMs);
  if (backoff === null) errors.maxRetryBackoffMs = POSITIVE_INT_MSG;

  // Empty → null (clears the ceiling); otherwise a PositiveInt.
  const rawCeiling = form.maxTotalTokens.trim();
  let ceiling: number | null = null;
  if (rawCeiling !== "") {
    const parsed = parsePositiveInt(rawCeiling);
    const ceilingMsg = `${POSITIVE_INT_MSG} (or blank for no ceiling)`;
    if (parsed === null) errors.maxTotalTokens = ceilingMsg;
    else ceiling = parsed;
  }

  const byState: Record<string, number> = {};
  for (const row of form.byState) {
    const v = parsePositiveInt(row.value);
    if (v === null) errors[`byState:${row.state}`] = POSITIVE_INT_MSG;
    else byState[row.state] = v;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors: errors as FieldErrors };
  }

  // All parsed — non-null assertions are safe here.
  const patch: SettingsPatchWire = {
    polling: { interval_ms: interval as number },
    agent: {
      max_concurrent_agents: maxAgents as number,
      max_turns: maxTurns as number,
      max_retry_backoff_ms: backoff as number,
      max_concurrent_agents_by_state: byState,
    },
    budget: { max_total_tokens: ceiling },
  };
  return { ok: true, errors: {}, patch };
};
