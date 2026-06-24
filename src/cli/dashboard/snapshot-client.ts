/**
 * Read-only snapshot client for the dashboard (#31).
 *
 * Typed, injectable `fetchSnapshot(baseUrl, signal)` over the daemon's loopback
 * `GET /api/v1/state` endpoint. The wire shape is the JSON projection produced by
 * `toSnapshot` (Dates already serialized to ISO strings, `due_at_ms` a monotonic
 * number, rate-limits a vendor passthrough). We parse it **defensively** into a small
 * view type rather than trusting the bytes — a malformed body becomes a typed error the
 * poller can surface, never a render crash.
 *
 * Plain (non-Effect): the dashboard island validates synchronously with hand-rolled
 * guards so it carries no Effect runtime into Ink's lifecycle.
 */

/** A single running attempt as seen over the wire (`started_at` is an ISO string). */
export interface SnapshotRunning {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly attempt: number | null;
  readonly workspace_path: string;
  readonly started_at: string;
  /** A `RunAttemptPhase` string; mapped to an operator status in the view-model. */
  readonly status: string;
  readonly error?: string;
  /** Last agent activity for this session (#37); absent when none observed yet. */
  readonly last_activity?: SnapshotActivity;
}

/** Per-session last activity (#37). `at` is an ISO instant. */
export interface SnapshotActivity {
  readonly event_tag: string;
  readonly at: string;
  readonly message?: string;
}

/** A scheduled retry. `due_at_ms` is a MONOTONIC clock value — not wall-clock. */
export interface SnapshotRetrying {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly error: string | null;
  /** Wall-clock ISO instant the retry was scheduled (#37); absent on older daemons. */
  readonly scheduled_at?: string;
  /** Backoff delay in ms applied at schedule time (#37); absent on older daemons. */
  readonly delay_ms?: number;
}

/** A bounded, display-safe lifecycle event (#37). `emitted_at` is an ISO instant. */
export interface SnapshotEvent {
  readonly seq: number;
  readonly emitted_at: string;
  readonly level: "info" | "warn";
  readonly kind: string;
  readonly issue_id?: string;
  readonly identifier?: string;
  readonly message: string;
}

/** A rich completion record (#37). `finished_at` is an ISO instant. */
export interface SnapshotCompletion {
  readonly issue_id: string;
  readonly identifier: string;
  readonly finished_at: string;
  readonly outcome: string;
}

export interface SnapshotTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly runtime_seconds: number;
}

export interface SnapshotCounts {
  readonly running: number;
  readonly retrying: number;
  readonly completed: number;
  readonly claimed: number;
}

/**
 * Budget guardrail status (#53). Present ONLY when the daemon has a ceiling configured —
 * absent on older daemons and when no budget is set, so the dashboard simply omits the
 * panel. `remaining_tokens` is `max(limit - spent, 0)`; `paused` reflects whether NEW
 * dispatch is currently withheld.
 */
export interface SnapshotBudget {
  readonly limit_tokens: number;
  readonly spent_tokens: number;
  readonly remaining_tokens: number;
  readonly paused: boolean;
}

/**
 * Restore/durability status (#54). Present ONLY after a real boot-time restore — absent on
 * a cold start and on older daemons, so the dashboard simply omits the indicator. `at` is
 * the wall-clock ISO instant the restore happened; the three counts mirror #41's summary.
 */
export interface SnapshotRestore {
  readonly at: string;
  readonly orphaned_running_converted: number;
  readonly rearmed_retries: number;
  readonly restored_completed: number;
}

/** The parsed, view-ready snapshot. */
export interface Snapshot {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly counts: SnapshotCounts;
  readonly running: ReadonlyArray<SnapshotRunning>;
  readonly retrying: ReadonlyArray<SnapshotRetrying>;
  /** Completed *issue IDs only* (the authoritative list; rich data is in recent_completed). */
  readonly completed: ReadonlyArray<string>;
  /** Bounded lifecycle event feed (#37), newest-last; empty on older daemons. */
  readonly recent_events: ReadonlyArray<SnapshotEvent>;
  /** Rich completion history (#37), newest-last; empty on older daemons. */
  readonly recent_completed: ReadonlyArray<SnapshotCompletion>;
  readonly totals: SnapshotTotals;
  /** Vendor passthrough — rendered defensively; never assume a schema. */
  readonly rate_limits: unknown;
  /** Budget guardrail status (#53); absent on older daemons / when no ceiling is set. */
  readonly budget?: SnapshotBudget;
  /** Restore/durability status (#54); absent on a cold start / older daemons. */
  readonly restore?: SnapshotRestore;
}

/** The injectable fetcher signature (real impl + test fakes share this type). */
export type FetchSnapshot = (baseUrl: string, signal: AbortSignal) => Promise<Snapshot>;

export const SNAPSHOT_PATH = "/api/v1/state";

/** Raised when the snapshot body does not match the expected shape. */
export class SnapshotParseError extends Error {
  constructor(message: string) {
    super(`malformed snapshot: ${message}`);
    this.name = "SnapshotParseError";
  }
}

/** Raised when the snapshot endpoint answers with a non-2xx status. */
export class SnapshotHttpError extends Error {
  constructor(readonly status: number) {
    super(`snapshot API returned HTTP ${status}`);
    this.name = "SnapshotHttpError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const reqString = (obj: Record<string, unknown>, key: string): string => {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new SnapshotParseError(`expected string at "${key}"`);
  }
  return v;
};

const reqNumber = (obj: Record<string, unknown>, key: string): number => {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SnapshotParseError(`expected finite number at "${key}"`);
  }
  return v;
};

const reqInt = (obj: Record<string, unknown>, key: string): number => {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new SnapshotParseError(`expected integer at "${key}"`);
  }
  return v;
};

const nullableInt = (obj: Record<string, unknown>, key: string): number | null => {
  const v = obj[key];
  if (v === null) {
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new SnapshotParseError(`expected integer|null at "${key}"`);
  }
  return v;
};

const nullableString = (obj: Record<string, unknown>, key: string): string | null => {
  const v = obj[key];
  if (v === null) {
    return null;
  }
  if (typeof v !== "string") {
    throw new SnapshotParseError(`expected string|null at "${key}"`);
  }
  return v;
};

const optString = (obj: Record<string, unknown>, key: string): string | undefined => {
  const v = obj[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "string") {
    throw new SnapshotParseError(`expected string|undefined at "${key}"`);
  }
  return v;
};

const optInt = (obj: Record<string, unknown>, key: string): number | undefined => {
  const v = obj[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new SnapshotParseError(`expected integer|undefined at "${key}"`);
  }
  return v;
};

const asArray = (v: unknown, key: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(v)) {
    throw new SnapshotParseError(`expected array at "${key}"`);
  }
  return v;
};

/** An optional array: absent/undefined → `[]` (older daemons omit the new fields). */
const optArray = (v: unknown, key: string): ReadonlyArray<unknown> => {
  if (v === undefined) {
    return [];
  }
  return asArray(v, key);
};

const asStringArray = (v: unknown, key: string): ReadonlyArray<string> => {
  return asArray(v, key).map((item, i) => {
    if (typeof item !== "string") {
      throw new SnapshotParseError(`expected string at "${key}[${i}]"`);
    }
    return item;
  });
};

const asRecord = (v: unknown, key: string): Record<string, unknown> => {
  if (!isRecord(v)) {
    throw new SnapshotParseError(`expected object at "${key}"`);
  }
  return v;
};

const parseActivity = (raw: unknown): SnapshotActivity => {
  const obj = asRecord(raw, "running[].last_activity");
  const base = {
    event_tag: reqString(obj, "event_tag"),
    at: reqString(obj, "at"),
  };
  const message = optString(obj, "message");
  return message === undefined ? base : { ...base, message };
};

const parseRunning = (raw: unknown, i: number): SnapshotRunning => {
  const obj = asRecord(raw, `running[${i}]`);
  const base = {
    issue_id: reqString(obj, "issue_id"),
    issue_identifier: reqString(obj, "issue_identifier"),
    attempt: nullableInt(obj, "attempt"),
    workspace_path: reqString(obj, "workspace_path"),
    started_at: reqString(obj, "started_at"),
    status: reqString(obj, "status"),
  };
  const error = optString(obj, "error");
  const lastActivity =
    obj.last_activity === undefined ? undefined : parseActivity(obj.last_activity);
  // exactOptionalPropertyTypes: only attach optional keys when actually present.
  return {
    ...base,
    ...(error === undefined ? {} : { error }),
    ...(lastActivity === undefined ? {} : { last_activity: lastActivity }),
  };
};

const parseRetrying = (raw: unknown, i: number): SnapshotRetrying => {
  const obj = asRecord(raw, `retrying[${i}]`);
  const base = {
    issue_id: reqString(obj, "issue_id"),
    identifier: reqString(obj, "identifier"),
    attempt: reqInt(obj, "attempt"),
    due_at_ms: reqNumber(obj, "due_at_ms"),
    error: nullableString(obj, "error"),
  };
  const scheduledAt = optString(obj, "scheduled_at");
  const delayMs = optInt(obj, "delay_ms");
  return {
    ...base,
    ...(scheduledAt === undefined ? {} : { scheduled_at: scheduledAt }),
    ...(delayMs === undefined ? {} : { delay_ms: delayMs }),
  };
};

const parseEvent = (raw: unknown, i: number): SnapshotEvent => {
  const obj = asRecord(raw, `recent_events[${i}]`);
  const base = {
    seq: reqInt(obj, "seq"),
    emitted_at: reqString(obj, "emitted_at"),
    // Defensive: only `warn` escalates; anything else renders as `info`.
    level: (reqString(obj, "level") === "warn" ? "warn" : "info") as "info" | "warn",
    kind: reqString(obj, "kind"),
    message: reqString(obj, "message"),
  };
  const issueId = optString(obj, "issue_id");
  const identifier = optString(obj, "identifier");
  return {
    ...base,
    ...(issueId === undefined ? {} : { issue_id: issueId }),
    ...(identifier === undefined ? {} : { identifier }),
  };
};

const parseCompletion = (raw: unknown, i: number): SnapshotCompletion => {
  const obj = asRecord(raw, `recent_completed[${i}]`);
  return {
    issue_id: reqString(obj, "issue_id"),
    identifier: reqString(obj, "identifier"),
    finished_at: reqString(obj, "finished_at"),
    outcome: reqString(obj, "outcome"),
  };
};

const parseCounts = (raw: unknown): SnapshotCounts => {
  const obj = asRecord(raw, "counts");
  return {
    running: reqInt(obj, "running"),
    retrying: reqInt(obj, "retrying"),
    completed: reqInt(obj, "completed"),
    claimed: reqInt(obj, "claimed"),
  };
};

const parseTotals = (raw: unknown): SnapshotTotals => {
  const obj = asRecord(raw, "totals");
  return {
    input_tokens: reqInt(obj, "input_tokens"),
    output_tokens: reqInt(obj, "output_tokens"),
    total_tokens: reqInt(obj, "total_tokens"),
    runtime_seconds: reqNumber(obj, "runtime_seconds"),
  };
};

/** Parse the additive budget block (#53). Absent → undefined (older daemon / no ceiling). */
const parseBudget = (raw: unknown): SnapshotBudget | undefined => {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const obj = asRecord(raw, "budget");
  const paused = obj.paused;
  if (typeof paused !== "boolean") {
    throw new SnapshotParseError(`expected boolean at "budget.paused"`);
  }
  return {
    limit_tokens: reqInt(obj, "limit_tokens"),
    spent_tokens: reqInt(obj, "spent_tokens"),
    remaining_tokens: reqInt(obj, "remaining_tokens"),
    paused,
  };
};

/** Parse the additive restore block (#54). Absent → undefined (cold start / older daemon). */
const parseRestore = (raw: unknown): SnapshotRestore | undefined => {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const obj = asRecord(raw, "restore");
  return {
    at: reqString(obj, "at"),
    orphaned_running_converted: reqInt(obj, "orphaned_running_converted"),
    rearmed_retries: reqInt(obj, "rearmed_retries"),
    restored_completed: reqInt(obj, "restored_completed"),
  };
};

/** Validate an unknown JSON body into a typed {@link Snapshot} (throws on mismatch). */
export const parseSnapshot = (raw: unknown): Snapshot => {
  const obj = asRecord(raw, "<root>");
  const budget = parseBudget(obj.budget);
  const restore = parseRestore(obj.restore);
  return {
    poll_interval_ms: reqInt(obj, "poll_interval_ms"),
    max_concurrent_agents: reqInt(obj, "max_concurrent_agents"),
    counts: parseCounts(obj.counts),
    running: asArray(obj.running, "running").map(parseRunning),
    retrying: asArray(obj.retrying, "retrying").map(parseRetrying),
    completed: asStringArray(obj.completed, "completed"),
    recent_events: optArray(obj.recent_events, "recent_events").map(parseEvent),
    recent_completed: optArray(obj.recent_completed, "recent_completed").map(parseCompletion),
    totals: parseTotals(obj.totals),
    // Keep rate_limits opaque: null when absent, otherwise the raw vendor value.
    rate_limits: obj.rate_limits ?? null,
    // Additive: only attach the budget block when the daemon sent one (#53).
    ...(budget === undefined ? {} : { budget }),
    // Additive: only attach the restore block when the daemon sent one (#54).
    ...(restore === undefined ? {} : { restore }),
  };
};

/**
 * Build the real fetcher. Each request combines the caller's abort signal (unmount /
 * stop) with a per-request `AbortSignal.timeout(timeoutMs)`, so a hung daemon can never
 * stall a poll past the budget.
 */
export const makeFetchSnapshot =
  (timeoutMs: number): FetchSnapshot =>
  async (baseUrl, signal) => {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const res = await fetch(`${baseUrl}${SNAPSHOT_PATH}`, {
      signal: combined,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      // Drain the unconsumed body so undici can release the socket immediately
      // instead of holding it until GC. Cleanup must never throw.
      await res.body?.cancel().catch(() => undefined);
      throw new SnapshotHttpError(res.status);
    }
    const body: unknown = await res.json();
    return parseSnapshot(body);
  };
