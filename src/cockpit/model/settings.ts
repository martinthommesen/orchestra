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
  readonly maxFailureRetries: string;
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
  | "maxFailureRetries"
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
  maxFailureRetries: String(s.agent.max_failure_retries),
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

/** Parse a string as a non-negative integer; returns null when invalid. */
const parseNonNegativeInt = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Shallow value-equality for the by-state concurrency map (keys are fixed by the schema). */
const sameByState = (
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
};

/**
 * Validate the form against the whitelist schema and, when valid, build a **sparse** patch
 * containing ONLY the fields that actually changed vs. `baseline` (the originally-loaded
 * settings). The backend treats field *presence* as "set this key", so an over-broad patch
 * (e.g. always including the structural `max_concurrent_agents_by_state`) forces the YAML
 * structural-edit path and reformats untouched front matter — defeating the #73 byte-verbatim
 * scalar-edit guarantee. A sparse patch keeps a scalar-only edit on the byte-verbatim path.
 *
 * Every field is still fully validated (any input may be edited); only the emitted patch is
 * trimmed to the diff. A no-op save yields an empty patch.
 */
export const validateSettings = (
  form: SettingsFormModel,
  baseline: EditableSettingsWire,
): ValidationResult => {
  const errors: Record<string, string> = {};

  const interval = parsePositiveInt(form.intervalMs);
  if (interval === null) errors.intervalMs = POSITIVE_INT_MSG;

  const maxAgents = parsePositiveInt(form.maxConcurrentAgents);
  if (maxAgents === null) errors.maxConcurrentAgents = POSITIVE_INT_MSG;

  const maxTurns = parsePositiveInt(form.maxTurns);
  if (maxTurns === null) errors.maxTurns = POSITIVE_INT_MSG;

  const maxFailureRetries = parseNonNegativeInt(form.maxFailureRetries);
  if (maxFailureRetries === null) errors.maxFailureRetries = "must be a whole number 0 or greater";

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

  // All parsed — non-null assertions are safe here. Emit only the changed keys.
  const agentPatch: {
    max_concurrent_agents?: number;
    max_turns?: number;
    max_failure_retries?: number;
    max_retry_backoff_ms?: number;
    max_concurrent_agents_by_state?: Record<string, number>;
  } = {};
  if ((maxAgents as number) !== baseline.agent.max_concurrent_agents) {
    agentPatch.max_concurrent_agents = maxAgents as number;
  }
  if ((maxTurns as number) !== baseline.agent.max_turns) {
    agentPatch.max_turns = maxTurns as number;
  }
  if ((maxFailureRetries as number) !== baseline.agent.max_failure_retries) {
    agentPatch.max_failure_retries = maxFailureRetries as number;
  }
  if ((backoff as number) !== baseline.agent.max_retry_backoff_ms) {
    agentPatch.max_retry_backoff_ms = backoff as number;
  }
  if (!sameByState(byState, baseline.agent.max_concurrent_agents_by_state)) {
    agentPatch.max_concurrent_agents_by_state = byState;
  }

  const patch: {
    polling?: { interval_ms: number };
    agent?: typeof agentPatch;
    budget?: { max_total_tokens: number | null };
  } = {};
  if ((interval as number) !== baseline.polling.interval_ms) {
    patch.polling = { interval_ms: interval as number };
  }
  if (Object.keys(agentPatch).length > 0) {
    patch.agent = agentPatch;
  }
  if (ceiling !== baseline.budget.max_total_tokens) {
    patch.budget = { max_total_tokens: ceiling };
  }

  return { ok: true, errors: {}, patch };
};

/**
 * Whether the form differs from the loaded baseline — drives the unsaved-changes indicator and
 * gates the Save button independently of validation (you can have dirty-but-invalid input). Pure
 * so it is unit-tested alongside `validateSettings`. Mirrors the diff keys above without re-running
 * the parse, so a half-typed (invalid) value still registers as dirty.
 */
export const isDirty = (form: SettingsFormModel, baseline: EditableSettingsWire): boolean => {
  if (form.intervalMs.trim() !== String(baseline.polling.interval_ms)) return true;
  if (form.maxConcurrentAgents.trim() !== String(baseline.agent.max_concurrent_agents)) return true;
  if (form.maxTurns.trim() !== String(baseline.agent.max_turns)) return true;
  if (form.maxFailureRetries.trim() !== String(baseline.agent.max_failure_retries)) return true;
  if (form.maxRetryBackoffMs.trim() !== String(baseline.agent.max_retry_backoff_ms)) return true;
  const baseCeiling = baseline.budget.max_total_tokens;
  if (form.maxTotalTokens.trim() !== (baseCeiling === null ? "" : String(baseCeiling))) return true;

  const baseByState = baseline.agent.max_concurrent_agents_by_state;
  const baseKeys = Object.keys(baseByState);
  const formKeys = form.byState.map((r) => r.state);
  if (baseKeys.length !== formKeys.length) return true;
  for (const row of form.byState) {
    if (row.value.trim() !== String(baseByState[row.state] ?? "")) return true;
  }
  return false;
};
