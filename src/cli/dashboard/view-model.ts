import type { ColorToken, Status } from "../../core/observability/glyphs";
import {
  PHASE_TO_STATUS,
  statusStyle,
  truncate,
  truncateOneLine,
} from "../../core/observability/glyphs";
import type { ConnectionState } from "./poller";
import type {
  Snapshot,
  SnapshotActivity,
  SnapshotBudget,
  SnapshotRestore,
  SnapshotRetrying,
} from "./snapshot-client";

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
  /** "TurnCompleted · 3s ago" when the worker has reported activity, else null (#38). */
  readonly lastActivityLabel: string | null;
}

export interface RetryingRowVM {
  readonly issueId: string;
  readonly identifier: string;
  readonly attemptLabel: string;
  readonly error: string;
  /** Honest wall-clock due time ("due 00:01:05Z") from scheduled_at+delay_ms; null if absent.
   *  NOT a countdown and NOT derived from the monotonic due_at_ms (#38). */
  readonly dueAtLabel: string | null;
}

/** One lifecycle event row in the feed (#38). */
export interface EventRowVM {
  readonly seq: number;
  readonly glyph: string;
  readonly ascii: string;
  readonly color: ColorToken;
  readonly kind: string;
  readonly message: string;
  /** Relative time ("3s ago"), or "—" when emitted_at is unparseable. */
  readonly relativeLabel: string;
  readonly identifier: string | null;
}

/** One rich completed row (#38): identifier + relative finished-at + outcome. */
export interface CompletedRowVM {
  readonly issueId: string;
  readonly identifier: string;
  readonly outcome: string;
  readonly outcomeColor: ColorToken;
  readonly relativeLabel: string;
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

/**
 * Budget guardrail panel (#53). `null` when the daemon sends no budget block (older
 * daemon or no ceiling configured) — the panel is then omitted entirely. The glyph/color
 * reuse the `glyphs.ts` design system: paused → `⏸ blocked` (warn), active → `▶`/info.
 */
export interface BudgetVM {
  readonly glyph: string;
  readonly ascii: string;
  readonly color: ColorToken;
  /** "paused" / "active". */
  readonly stateLabel: string;
  /** "1200 / 1000 tokens · 0 left" — already display-ready. */
  readonly summary: string;
  readonly paused: boolean;
}

export interface RateLimitsVM {
  readonly available: boolean;
  readonly summary: string;
}

/**
 * Restore/durability indicator (#54). `null` when the daemon sends no restore block (cold
 * start or older daemon) — the panel is then omitted entirely. Display-only: it reflects
 * a fact captured ONCE at boot. Glyph honors `--ascii` (Unicode `⟳` / ASCII `*`); color
 * reuses the design-system `info` token, gated by `NO_COLOR`/non-TTY downstream.
 */
export interface RestoreVM {
  readonly glyph: string;
  readonly ascii: string;
  readonly color: ColorToken;
  /** "restored after restart". */
  readonly stateLabel: string;
  /** "1 running · 0 retrying · 3 completed · restored 12s ago" — already display-ready. */
  readonly summary: string;
}

export interface DashboardViewModel {
  readonly header: HeaderVM;
  readonly running: ReadonlyArray<RunningRowVM>;
  readonly retrying: ReadonlyArray<RetryingRowVM>;
  readonly completed: CompletedVM;
  /** Rich recent completions (newest-first), or empty when the daemon doesn't send them. */
  readonly recentCompleted: ReadonlyArray<CompletedRowVM>;
  /** Lifecycle event feed (newest-first), or empty when the daemon doesn't send it. */
  readonly events: ReadonlyArray<EventRowVM>;
  readonly totals: TotalsVM | null;
  readonly rateLimits: RateLimitsVM;
  /** Budget guardrail panel (#53); null when the daemon sends no budget block. */
  readonly budget: BudgetVM | null;
  /** Restore/durability indicator (#54); null when the daemon sends no restore block. */
  readonly restore: RestoreVM | null;
}

export interface ViewModelOptions {
  readonly connection: ConnectionState;
  readonly error: string | null;
  readonly lastUpdatedAtMs: number | null;
  readonly baseUrl: string;
}

/** How many recent completed IDs to surface (it is IDs-only, so keep it small). */
export const RECENT_COMPLETED = 8;
/** How many lifecycle events to surface in the feed (newest-first; the ring holds more). */
export const RECENT_EVENTS = 12;
/**
 * Widest relative-time label {@link formatRelative} can emit, `"99h 59m ago"` /
 * `"59m 59s ago"` = 11 chars, given {@link formatDuration} is clamped (see
 * `DURATION_MAX_SEC`). The `"—"` sentinel is shorter, so this is the true max.
 */
export const RELATIVE_LABEL_MAX_WIDTH = 11;
/**
 * Fixed width of the EVENTS feed relative-time column: the widest label plus a 1-char
 * gutter so it never wraps (#45 — `width=9` clipped `"Xm YYs ago"` onto a second line).
 */
export const EVENTS_RELATIVE_TIME_COLUMN_WIDTH = RELATIVE_LABEL_MAX_WIDTH + 1;
const WORKSPACE_MAX = 44;
const ERROR_MAX = 80;
const RATE_LIMIT_MAX = 100;
const EVENT_MESSAGE_MAX = 80;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Upper bound on the seconds {@link formatDuration} will render, `99h 59m 59s`. The hour
 * tier is otherwise unbounded (`1000h 00m` …), which would silently overflow every
 * fixed-width column it feeds (EVENTS relative-time, running `elapsed`). Clamping here
 * keeps the widest token at 7 chars (`99h 59m`) so the UI's column contract stays honest
 * for the absurd-but-possible long-lived case (#45). Realistic feeds never approach it.
 */
const DURATION_MAX_SEC = 99 * 3600 + 59 * 60 + 59;

/** Compact, human duration: `8s`, `1m 04s`, `2h 09m` (clamped to `99h 59m`). */
export const formatDuration = (ms: number): string => {
  const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.min(Math.floor(clamped / 1000), DURATION_MAX_SEC);
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

/** Relative wall-clock label ("3s ago"); `—` when the ISO instant is unparseable. */
const formatRelative = (now: number, iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${formatDuration(now - t)} ago` : UNKNOWN_ELAPSED;
};

/**
 * Honest per-session activity line ("started session · 3s ago"). Prefers the humanized
 * `message` (#55) and falls back to the raw `event_tag` when absent (older daemon). `null`
 * when no activity has been observed or `at` is unparseable — we never invent a plausible
 * "0s ago".
 */
const formatLastActivity = (now: number, activity: SnapshotActivity | undefined): string | null => {
  if (activity === undefined) {
    return null;
  }
  const t = Date.parse(activity.at);
  if (!Number.isFinite(t)) {
    return null;
  }
  const label = activity.message ?? activity.event_tag;
  return `${label} · ${formatDuration(now - t)} ago`;
};

/**
 * Honest wall-clock retry due time ("due 00:01:05Z") from `scheduled_at` + `delay_ms`,
 * formatted in UTC. `null` when either field is absent (older daemon) or `scheduled_at`
 * is unparseable. NEVER a live countdown and NEVER derived from the monotonic `due_at_ms`.
 */
const formatDueAt = (r: SnapshotRetrying): string | null => {
  if (r.scheduled_at === undefined || r.delay_ms === undefined) {
    return null;
  }
  const base = Date.parse(r.scheduled_at);
  if (!Number.isFinite(base)) {
    return null;
  }
  const due = new Date(base + r.delay_ms);
  return `due ${pad2(due.getUTCHours())}:${pad2(due.getUTCMinutes())}:${pad2(due.getUTCSeconds())}Z`;
};

/** A precomputed feed glyph (both variants) so the Ink component stays dumb. */
interface FeedGlyph {
  readonly color: ColorToken;
  readonly glyph: string;
  readonly ascii: string;
}

/**
 * Glyph + color for a lifecycle event, keyed by `kind` and reusing the `glyphs.ts`
 * status design system (▶ dispatched, ⏳ retry, ✓ completed, ✗ failed). Unknown kinds
 * fall back on `level`: `warn` → warn tone, anything else → muted info.
 */
const EVENT_KIND_STYLE: Record<string, FeedGlyph> = {
  started: { color: "info", glyph: "▶", ascii: ">" },
  dispatched: { color: "info", glyph: "▶", ascii: ">" },
  retry_scheduled: { color: "warn", glyph: "⏳", ascii: "~" },
  retry_fired: { color: "warn", glyph: "⏳", ascii: "~" },
  completed: { color: "success", glyph: "✓", ascii: "+" },
  workspace_cleaned: { color: "muted", glyph: "✓", ascii: "+" },
  startup_cleanup: { color: "muted", glyph: "✓", ascii: "+" },
  failed: { color: "danger", glyph: "✗", ascii: "x" },
  killed: { color: "danger", glyph: "✗", ascii: "x" },
  preflight_failed: { color: "danger", glyph: "✗", ascii: "x" },
};

const WARN_GLYPH: FeedGlyph = { color: "warn", glyph: "⚠", ascii: "!" };
const INFO_GLYPH: FeedGlyph = { color: "muted", glyph: "·", ascii: "-" };

const eventGlyph = (level: "info" | "warn", kind: string): FeedGlyph =>
  EVENT_KIND_STYLE[kind] ?? (level === "warn" ? WARN_GLYPH : INFO_GLYPH);

/** Outcome → color for the rich completed feed (completed→success, killed→danger). */
const outcomeColor = (outcome: string): ColorToken => {
  switch (outcome) {
    case "completed":
      return "success";
    case "killed":
      return "danger";
    default:
      return "muted";
  }
};

const attemptLabel = (attempt: number | null): string => (attempt === null ? "—" : `#${attempt}`);

/**
 * Build the budget panel VM from the additive wire block (#53). Reuses the `glyphs.ts`
 * status design system: paused → `⏸ blocked` (warn tone); active → `▶ running` (info).
 * `null` in is mapped by the caller (absent block → no panel).
 */
const toBudgetVM = (b: SnapshotBudget): BudgetVM => {
  const style = statusStyle(b.paused ? "blocked" : "running");
  return {
    glyph: style.glyph,
    ascii: style.ascii,
    color: b.paused ? "warn" : style.color,
    stateLabel: b.paused ? "paused" : "active",
    summary: `${b.spent_tokens} / ${b.limit_tokens} tokens · ${b.remaining_tokens} left`,
    paused: b.paused,
  };
};

/**
 * Build the restore indicator VM from the additive wire block (#54). Display-only: it
 * surfaces the boot-time recovery fact long after the one-shot event scrolled away. The
 * `⟳` glyph (ASCII `*`) reads as "cycled/restarted"; `info` tone matches the header's
 * informational chrome. The relative "restored Xs ago" reuses {@link formatRelative}, so
 * an unparseable `at` degrades to `—` rather than inventing a plausible "0s".
 */
const toRestoreVM = (now: number, r: SnapshotRestore): RestoreVM => ({
  glyph: "⟳",
  ascii: "*",
  color: "info",
  stateLabel: "restored after restart",
  summary:
    `${r.orphaned_running_converted} running · ${r.rearmed_retries} retrying · ` +
    `${r.restored_completed} completed · restored ${formatRelative(now, r.at)}`,
});

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
  lastActivityLabel: formatLastActivity(now, r.last_activity),
});

const toRetryingRow = (r: Snapshot["retrying"][number]): RetryingRowVM => ({
  issueId: r.issue_id,
  identifier: r.identifier,
  attemptLabel: `#${r.attempt}`,
  error: r.error === null ? "—" : truncateOneLine(r.error, ERROR_MAX),
  dueAtLabel: formatDueAt(r),
});

const toEventRow = (now: number, e: Snapshot["recent_events"][number]): EventRowVM => {
  const style = eventGlyph(e.level, e.kind);
  return {
    seq: e.seq,
    glyph: style.glyph,
    ascii: style.ascii,
    color: style.color,
    kind: e.kind,
    message: truncateOneLine(e.message, EVENT_MESSAGE_MAX),
    relativeLabel: formatRelative(now, e.emitted_at),
    identifier: e.identifier ?? null,
  };
};

const toCompletedRow = (now: number, c: Snapshot["recent_completed"][number]): CompletedRowVM => ({
  issueId: c.issue_id,
  identifier: c.identifier,
  outcome: c.outcome,
  outcomeColor: outcomeColor(c.outcome),
  relativeLabel: formatRelative(now, c.finished_at),
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
      recentCompleted: [],
      events: [],
      totals: null,
      rateLimits: summarizeRateLimits(null),
      budget: null,
      restore: null,
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
    // Rich completions ride a sibling ring (newest-last on the wire) — newest-first here.
    recentCompleted: [...snapshot.recent_completed]
      .reverse()
      .slice(0, RECENT_COMPLETED)
      .map((c) => toCompletedRow(now, c)),
    // Lifecycle feed (newest-last on the wire) — newest-first, bounded for the panel.
    events: [...snapshot.recent_events]
      .reverse()
      .slice(0, RECENT_EVENTS)
      .map((e) => toEventRow(now, e)),
    totals: {
      inputTokens: snapshot.totals.input_tokens,
      outputTokens: snapshot.totals.output_tokens,
      totalTokens: snapshot.totals.total_tokens,
      runtimeLabel: formatDuration(snapshot.totals.runtime_seconds * 1000),
    },
    rateLimits: summarizeRateLimits(snapshot.rate_limits),
    budget: snapshot.budget === undefined ? null : toBudgetVM(snapshot.budget),
    restore: snapshot.restore === undefined ? null : toRestoreVM(now, snapshot.restore),
  };
};
