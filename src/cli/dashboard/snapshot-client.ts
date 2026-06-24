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
}

/** A scheduled retry. `due_at_ms` is a MONOTONIC clock value — not wall-clock. */
export interface SnapshotRetrying {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly error: string | null;
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

/** The parsed, view-ready snapshot. */
export interface Snapshot {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly counts: SnapshotCounts;
  readonly running: ReadonlyArray<SnapshotRunning>;
  readonly retrying: ReadonlyArray<SnapshotRetrying>;
  /** Completed *issue IDs only* (the API does not carry rich completion data). */
  readonly completed: ReadonlyArray<string>;
  readonly totals: SnapshotTotals;
  /** Vendor passthrough — rendered defensively; never assume a schema. */
  readonly rate_limits: unknown;
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

const asArray = (v: unknown, key: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(v)) {
    throw new SnapshotParseError(`expected array at "${key}"`);
  }
  return v;
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
  // exactOptionalPropertyTypes: only attach `error` when actually present.
  return error === undefined ? base : { ...base, error };
};

const parseRetrying = (raw: unknown, i: number): SnapshotRetrying => {
  const obj = asRecord(raw, `retrying[${i}]`);
  return {
    issue_id: reqString(obj, "issue_id"),
    identifier: reqString(obj, "identifier"),
    attempt: reqInt(obj, "attempt"),
    due_at_ms: reqNumber(obj, "due_at_ms"),
    error: nullableString(obj, "error"),
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

/** Validate an unknown JSON body into a typed {@link Snapshot} (throws on mismatch). */
export const parseSnapshot = (raw: unknown): Snapshot => {
  const obj = asRecord(raw, "<root>");
  return {
    poll_interval_ms: reqInt(obj, "poll_interval_ms"),
    max_concurrent_agents: reqInt(obj, "max_concurrent_agents"),
    counts: parseCounts(obj.counts),
    running: asArray(obj.running, "running").map(parseRunning),
    retrying: asArray(obj.retrying, "retrying").map(parseRetrying),
    completed: asStringArray(obj.completed, "completed"),
    totals: parseTotals(obj.totals),
    // Keep rate_limits opaque: null when absent, otherwise the raw vendor value.
    rate_limits: obj.rate_limits ?? null,
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
