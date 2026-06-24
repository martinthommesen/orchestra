import type { ColorToken, Status } from "../../core/observability/glyphs";
import {
  PHASE_TO_STATUS,
  statusStyle,
  truncate,
  truncateOneLine,
} from "../../core/observability/glyphs";
import type { ConnectionState } from "./poller";
import type { Snapshot } from "./snapshot-client";

/**
 * Pure presentation logic for the dashboard (#32). `toViewModel` turns a (possibly
 * null) {@link Snapshot} plus the current wall-clock `now` and connection metadata into
 * a fully render-ready {@link DashboardViewModel}. All the rendering decisions live here
 * so the Ink components stay dumb and the matrix of states is unit-testable without a
 * terminal.
 *
 * Honesty rules (Sprint 2 design review):
 *   - running rows are rich, with **client-calculated** elapsed from `started_at`; an
 *     unparseable `started_at` renders as an explicit `—`, never a plausible "0s";
 *   - an unrecognized/contract-drifted run phase renders as an explicit muted "unknown"
 *     badge, never masquerading as active "running" work (the raw phase is still shown);
 *   - retrying rows carry NO countdown — `due_at_ms` is a monotonic value the client
 *     cannot turn into wall-clock "retry in Ns";
 *   - completed is **issue IDs only** (count + a few recent), not a rich table;
 *   - rate-limits are rendered defensively ("unavailable" when null; never assume a
 *     schema for a non-null value).
 */

export interface HeaderVM {
  readonly baseUrl: string;
  readonly connection: ConnectionState;
  readonly connectionLabel: string;
  readonly connectionColor: ColorToken;
  readonly pollIntervalMs: number | null;
  readonly maxConcurrentAgents: number | null;
  readonly runningCount: number;
  readonly retryingCount: number;
  readonly completedCount: number;
  /** "updated 3s ago" once a snapshot has ever arrived, else null. */
  readonly updatedLabel: string | null;
  /** Last poll error, surfaced under the banner when present. */
  readonly error: string | null;
}

/**
 * A render-ready status badge. Known phases mirror the `glyphs.ts` design system
 * exactly; an unrecognized/contract-drifted phase becomes an explicit muted "unknown"
 * badge (`known: false`) rather than masquerading as active "running" work. Both glyph
 * variants are precomputed so the Ink component stays dumb and just picks one by `ascii`.
 */
export interface StatusBadgeVM {
  readonly glyph: string;
  readonly ascii: string;
  readonly label: string;
  readonly color: ColorToken;
  /** False when the wire phase was not recognized (honest "indeterminate" state). */
  readonly known: boolean;
}

export interface RunningRowVM {
  readonly issueId: string;
  readonly identifier: string;
  readonly badge: StatusBadgeVM;
  /** Granular run-attempt phase (e.g. "StreamingTurn"), shown subtly. */
  readonly phase: string;
  readonly elapsedLabel: string;
  readonly attemptLabel: string;
  readonly workspace: string;
  readonly error: string | null;
}

export interface RetryingRowVM {
  readonly issueId: string;
  readonly identifier: string;
  readonly attemptLabel: string;
  readonly error: string;
}

export interface CompletedVM {
  readonly count: number;
  readonly recentIds: ReadonlyArray<string>;
}

export interface TotalsVM {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly runtimeLabel: string;
}

export interface RateLimitsVM {
  readonly available: boolean;
  readonly summary: string;
}

export interface DashboardViewModel {
  readonly header: HeaderVM;
  readonly running: ReadonlyArray<RunningRowVM>;
  readonly retrying: ReadonlyArray<RetryingRowVM>;
  readonly completed: CompletedVM;
  readonly totals: TotalsVM | null;
  readonly rateLimits: RateLimitsVM;
}

export interface ViewModelOptions {
  readonly connection: ConnectionState;
  readonly error: string | null;
  readonly lastUpdatedAtMs: number | null;
  readonly baseUrl: string;
}

/** How many recent completed IDs to surface (it is IDs-only, so keep it small). */
export const RECENT_COMPLETED = 8;
const WORKSPACE_MAX = 44;
const ERROR_MAX = 80;
const RATE_LIMIT_MAX = 100;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Compact, human duration: `8s`, `1m 04s`, `2h 09m`. */
export const formatDuration = (ms: number): string => {
  const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(clamped / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) {
    return `${h}h ${pad2(m)}m`;
  }
  if (m > 0) {
    return `${m}m ${pad2(s)}s`;
  }
  return `${s}s`;
};

/** The honest badge for a phase the orchestrator contract no longer recognizes. */
const UNKNOWN_BADGE: StatusBadgeVM = {
  glyph: "?",
  ascii: "?",
  label: "unknown",
  color: "muted",
  known: false,
};

/** The elapsed sentinel shown when `started_at` cannot be parsed (never a fake "0s"). */
const UNKNOWN_ELAPSED = "—";

/**
 * Build the render-ready badge for a wire phase. A recognized phase reuses the
 * `glyphs.ts` design system verbatim; anything else becomes {@link UNKNOWN_BADGE} so a
 * drifted/unknown phase can never display as active "running" work.
 */
const statusBadgeForPhase = (phase: string): StatusBadgeVM => {
  const status: Status | undefined = (PHASE_TO_STATUS as Record<string, Status>)[phase];
  if (status === undefined) {
    return UNKNOWN_BADGE;
  }
  const style = statusStyle(status);
  return {
    glyph: style.glyph,
    ascii: style.ascii,
    label: style.label,
    color: style.color,
    known: true,
  };
};

/** Client-side elapsed from an ISO `started_at`; `—` when the timestamp is unparseable. */
const formatElapsed = (now: number, startedAt: string): string => {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? formatDuration(now - started) : UNKNOWN_ELAPSED;
};

const attemptLabel = (attempt: number | null): string => (attempt === null ? "—" : `#${attempt}`);

const connectionStyle = (
  connection: ConnectionState,
): { readonly label: string; readonly color: ColorToken } => {
  switch (connection) {
    case "live":
      return { label: "live", color: "success" };
    case "stale":
      return { label: "stale", color: "warn" };
    case "connecting":
      return { label: "connecting", color: "info" };
  }
};

/** Defensive rate-limit summary: opaque, never assumes a vendor schema. */
const summarizeRateLimits = (rateLimits: unknown): RateLimitsVM => {
  if (rateLimits === null || rateLimits === undefined) {
    return { available: false, summary: "unavailable" };
  }
  try {
    return {
      available: true,
      summary: truncateOneLine(JSON.stringify(rateLimits), RATE_LIMIT_MAX),
    };
  } catch {
    return { available: true, summary: "present (unserializable)" };
  }
};

const toRunningRow = (now: number, r: Snapshot["running"][number]): RunningRowVM => ({
  issueId: r.issue_id,
  identifier: r.issue_identifier,
  badge: statusBadgeForPhase(r.status),
  // Raw wire phase, kept for the subtle "phase=…" annotation on unknown rows
  // (truncated defensively in case a drifted value is large).
  phase: truncateOneLine(r.status, 40),
  elapsedLabel: formatElapsed(now, r.started_at),
  attemptLabel: attemptLabel(r.attempt),
  workspace: truncate(r.workspace_path, WORKSPACE_MAX),
  error: r.error === undefined ? null : truncateOneLine(r.error, ERROR_MAX),
});

const toRetryingRow = (r: Snapshot["retrying"][number]): RetryingRowVM => ({
  issueId: r.issue_id,
  identifier: r.identifier,
  attemptLabel: `#${r.attempt}`,
  error: r.error === null ? "—" : truncateOneLine(r.error, ERROR_MAX),
});

/** Build the full render-ready view model. `snapshot` is null until the first poll. */
export const toViewModel = (
  snapshot: Snapshot | null,
  now: number,
  opts: ViewModelOptions,
): DashboardViewModel => {
  const conn = connectionStyle(opts.connection);
  const updatedLabel =
    opts.lastUpdatedAtMs === null
      ? null
      : `updated ${formatDuration(now - opts.lastUpdatedAtMs)} ago`;

  if (snapshot === null) {
    return {
      header: {
        baseUrl: opts.baseUrl,
        connection: opts.connection,
        connectionLabel: conn.label,
        connectionColor: conn.color,
        pollIntervalMs: null,
        maxConcurrentAgents: null,
        runningCount: 0,
        retryingCount: 0,
        completedCount: 0,
        updatedLabel,
        error: opts.error,
      },
      running: [],
      retrying: [],
      completed: { count: 0, recentIds: [] },
      totals: null,
      rateLimits: summarizeRateLimits(null),
    };
  }

  return {
    header: {
      baseUrl: opts.baseUrl,
      connection: opts.connection,
      connectionLabel: conn.label,
      connectionColor: conn.color,
      pollIntervalMs: snapshot.poll_interval_ms,
      maxConcurrentAgents: snapshot.max_concurrent_agents,
      runningCount: snapshot.counts.running,
      retryingCount: snapshot.counts.retrying,
      completedCount: snapshot.counts.completed,
      updatedLabel,
      error: opts.error,
    },
    running: snapshot.running.map((r) => toRunningRow(now, r)),
    retrying: snapshot.retrying.map(toRetryingRow),
    completed: {
      count: snapshot.completed.length,
      // IDs-only: a few most-recent, newest first.
      recentIds: snapshot.completed.slice(-RECENT_COMPLETED).reverse(),
    },
    totals: {
      inputTokens: snapshot.totals.input_tokens,
      outputTokens: snapshot.totals.output_tokens,
      totalTokens: snapshot.totals.total_tokens,
      runtimeLabel: formatDuration(snapshot.totals.runtime_seconds * 1000),
    },
    rateLimits: summarizeRateLimits(snapshot.rate_limits),
  };
};
