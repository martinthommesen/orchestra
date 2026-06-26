import {
  PHASE_TO_STATUS,
  type Status,
  statusStyle,
  truncate,
  truncateOneLine,
} from "../../core/observability/glyphs";
import type { BudgetWire, RestoreWire, RunAttemptWire, SnapshotWire } from "../api/types";
import { type Accent, COLOR_TOKEN_BG_VAR, COLOR_TOKEN_VAR } from "../design/tokens";
import { attemptLabel, formatDuration, formatElapsed, formatRelative } from "./format";

/**
 * Sprint 6 / #69 — the pure Fleet (session-overview) view-model. Turns a `SnapshotWire` + a
 * client `now` into a fully render-ready model so the React view stays presentational and the
 * whole derivation is unit-tested under Node. Reuses the one design-system source (`glyphs.ts`)
 * for status glyphs/colors. Every additive block (`budget`/`restore`/`last_activity`) maps to
 * `null`/absent when the daemon omits it — the view then omits the panel. The raw `control` block
 * is consumed directly by the `DispatchControl` component (live Pause/Resume), not mapped here.
 */

const WORKSPACE_MAX = 60;
const ERROR_MAX = 120;
const RATE_LIMIT_MAX = 200;

const cssVar = (status: Status): string => `var(${COLOR_TOKEN_VAR[statusStyle(status).color]})`;

/** A render-ready status badge; `known: false` is the honest "drifted phase" state. */
export interface StatusBadgeVM {
  readonly glyph: string;
  readonly label: string;
  readonly colorVar: string;
  /** Tint background CSS var (filled chips/bars) — derived from the same color token. */
  readonly bgVar: string;
  readonly known: boolean;
}

const UNKNOWN_BADGE: StatusBadgeVM = {
  glyph: "?",
  label: "unknown",
  colorVar: `var(${COLOR_TOKEN_VAR.muted})`,
  bgVar: `var(${COLOR_TOKEN_BG_VAR.muted})`,
  known: false,
};

/** Map a granular run phase to a badge; an unrecognized phase becomes the honest unknown badge. */
export const badgeForPhase = (phase: string): StatusBadgeVM => {
  const status = (PHASE_TO_STATUS as Record<string, Status | undefined>)[phase];
  if (status === undefined) return UNKNOWN_BADGE;
  return badgeOf(status);
};

/** Build a badge directly from a known design-system status. */
export const badgeOf = (status: Status): StatusBadgeVM => {
  const style = statusStyle(status);
  return {
    glyph: style.glyph,
    label: style.label,
    colorVar: cssVar(status),
    bgVar: `var(${COLOR_TOKEN_BG_VAR[style.color]})`,
    known: true,
  };
};

export interface RunningRowVM {
  readonly issueId: string;
  readonly identifier: string;
  readonly badge: StatusBadgeVM;
  readonly phase: string;
  readonly elapsedLabel: string;
  /** Elapsed in ms (for sorting); null when `started_at` is unparseable. */
  readonly elapsedMs: number | null;
  readonly attemptLabel: string;
  /** Attempt number (for sorting); null when unknown. */
  readonly attemptNumber: number | null;
  readonly workspace: string;
  readonly error: string | null;
  /** "TurnCompleted · 3s ago" when the worker reported activity, else null. */
  readonly lastActivityLabel: string | null;
}

/** Sortable fleet-table columns; `status` sorts by the design-system status label. */
export type SortKey = "issue" | "elapsed" | "attempt" | "status";
export type SortDir = "asc" | "desc";

/** Pure, stable sort over running rows. Unknown/null values sort last in either direction. */
export const sortRunning = (
  rows: ReadonlyArray<RunningRowVM>,
  key: SortKey,
  dir: SortDir,
): ReadonlyArray<RunningRowVM> => {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: RunningRowVM, b: RunningRowVM): number => {
    switch (key) {
      case "issue":
        return a.identifier.localeCompare(b.identifier);
      case "status":
        return a.badge.label.localeCompare(b.badge.label);
      case "attempt": {
        const av = a.attemptNumber;
        const bv = b.attemptNumber;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
      }
      case "elapsed": {
        const av = a.elapsedMs;
        const bv = b.elapsedMs;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
      }
    }
  };
  return rows.toSorted((a, b) => {
    const c = cmp(a, b);
    // Null/unknown always sinks regardless of direction; otherwise apply direction.
    const aNull =
      (key === "elapsed" && a.elapsedMs === null) ||
      (key === "attempt" && a.attemptNumber === null);
    const bNull =
      (key === "elapsed" && b.elapsedMs === null) ||
      (key === "attempt" && b.attemptNumber === null);
    if (aNull || bNull) return c;
    return c * sign;
  });
};

export interface TotalsVM {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly runtimeLabel: string;
}

export interface BudgetVM {
  readonly paused: boolean;
  readonly stateLabel: string;
  readonly colorVar: string;
  readonly summary: string;
  /** Spent/limit clamped to [0, 1] — drives the progress bar. 0 when the limit is non-positive. */
  readonly fraction: number;
  /** "25%" — whole-percent of the budget spent. */
  readonly percentLabel: string;
}

export interface RestoreVM {
  readonly summary: string;
}

export interface RateLimitsVM {
  readonly available: boolean;
  readonly summary: string;
}

export interface MetricVM {
  readonly label: string;
  readonly value: number;
  /** Design-system accent driving the card's colored top rule. */
  readonly accent: Accent;
}

export interface FleetViewModel {
  readonly pollIntervalMs: number;
  readonly maxConcurrentAgents: number;
  /** Render-ready metric cards (counts) with semantic accents. */
  readonly metrics: ReadonlyArray<MetricVM>;
  readonly running: ReadonlyArray<RunningRowVM>;
  readonly totals: TotalsVM;
  readonly budget: BudgetVM | null;
  readonly restore: RestoreVM | null;
  readonly rateLimits: RateLimitsVM;
}

const formatLastActivity = (now: number, r: RunAttemptWire): string | null => {
  const act = r.last_activity;
  if (act === undefined) return null;
  const t = Date.parse(act.at);
  if (!Number.isFinite(t)) return null;
  const label = act.message ?? act.event_tag;
  return `${label} · ${formatDuration(now - t)} ago`;
};

const toRunningRow = (now: number, r: RunAttemptWire): RunningRowVM => {
  const started = Date.parse(r.started_at);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : null;
  return {
    issueId: r.issue_id,
    identifier: r.issue_identifier,
    badge: badgeForPhase(r.status),
    phase: truncateOneLine(r.status, 40),
    elapsedLabel: formatElapsed(now, r.started_at),
    elapsedMs,
    attemptLabel: attemptLabel(r.attempt),
    attemptNumber: r.attempt,
    workspace: truncate(r.workspace_path, WORKSPACE_MAX),
    error: r.error === undefined ? null : truncateOneLine(r.error, ERROR_MAX),
    lastActivityLabel: formatLastActivity(now, r),
  };
};

const toBudgetVM = (b: BudgetWire): BudgetVM => {
  const fraction =
    b.limit_tokens > 0 ? Math.min(1, Math.max(0, b.spent_tokens / b.limit_tokens)) : 0;
  return {
    paused: b.paused,
    stateLabel: b.paused ? "paused" : "active",
    colorVar: b.paused ? `var(${COLOR_TOKEN_VAR.warn})` : cssVar("running"),
    summary: `${b.spent_tokens} / ${b.limit_tokens} tokens · ${b.remaining_tokens} left`,
    fraction,
    percentLabel: `${Math.round(fraction * 100)}%`,
  };
};

const toRestoreVM = (now: number, r: RestoreWire): RestoreVM => ({
  summary:
    `${r.orphaned_running_converted} running · ${r.rearmed_retries} retrying · ` +
    `${r.restored_completed} completed · restored ${formatRelative(now, r.at)}`,
});

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

export const toFleetView = (s: SnapshotWire, now: number): FleetViewModel => ({
  pollIntervalMs: s.poll_interval_ms,
  maxConcurrentAgents: s.max_concurrent_agents,
  metrics: [
    { label: "Running", value: s.counts.running, accent: "info" },
    { label: "Retrying", value: s.counts.retrying, accent: "warn" },
    { label: "Abandoned", value: s.counts.abandoned, accent: "muted" },
    { label: "Completed", value: s.counts.completed, accent: "success" },
    { label: "Claimed", value: s.counts.claimed, accent: "neutral" },
    { label: "Max agents", value: s.max_concurrent_agents, accent: "neutral" },
  ],
  running: s.running.map((r) => toRunningRow(now, r)),
  totals: {
    inputTokens: s.totals.input_tokens,
    outputTokens: s.totals.output_tokens,
    totalTokens: s.totals.total_tokens,
    runtimeLabel: formatDuration(s.totals.runtime_seconds * 1000),
  },
  budget: s.budget === undefined ? null : toBudgetVM(s.budget),
  restore: s.restore === undefined ? null : toRestoreVM(now, s.restore),
  rateLimits: summarizeRateLimits(s.rate_limits),
});
