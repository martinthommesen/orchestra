import type { RunAttemptPhase } from "../domain/run-attempt";

/**
 * Orchestra status design system (Sprint 0, Task 8 — see `docs/design-system.md`).
 *
 * A tiny, dependency-free presentation layer shared by v1 structured logs and the
 * post-v1 TUI. It defines the five canonical worker statuses, their glyphs, a
 * semantic color palette (ANSI), and the truncation rules that keep one event on
 * one line and keep secrets/noise out of logs (PROJECT_BRIEF §9.2).
 *
 * Design rules:
 *   - Pure functions, no Effect, no IO — safe to call from any layer.
 *   - Color is OPT-IN and honors `NO_COLOR` (https://no-color.org) + non-TTY.
 *   - Glyphs are single-width where possible; every glyph has an ASCII fallback.
 */

/** The five canonical, operator-facing worker/issue statuses. */
export type Status = "running" | "retrying" | "blocked" | "done" | "failed";

/** Semantic color tokens (decoupled from concrete ANSI codes). */
export type ColorToken = "info" | "warn" | "muted" | "success" | "danger";

/** Everything needed to render one status in a log line or TUI cell. */
export interface StatusStyle {
  readonly status: Status;
  /** Unicode status glyph (e.g. `▶`). */
  readonly glyph: string;
  /** ASCII fallback for non-UTF terminals / log sinks (e.g. `>`). */
  readonly ascii: string;
  /** Lowercase human label (e.g. `running`). */
  readonly label: string;
  /** Semantic color token used for {@link colorize}. */
  readonly color: ColorToken;
}

/**
 * The canonical status table. Glyphs match the Sprint 0 plan:
 * `▶ running`, `⏳ retrying`, `⏸ blocked`, `✓ done`, `✗ failed`.
 */
export const STATUS_STYLES: Record<Status, StatusStyle> = {
  running: { status: "running", glyph: "▶", ascii: ">", label: "running", color: "info" },
  retrying: { status: "retrying", glyph: "⏳", ascii: "~", label: "retrying", color: "warn" },
  blocked: { status: "blocked", glyph: "⏸", ascii: "=", label: "blocked", color: "muted" },
  done: { status: "done", glyph: "✓", ascii: "+", label: "done", color: "success" },
  failed: { status: "failed", glyph: "✗", ascii: "x", label: "failed", color: "danger" },
};

/** SGR (Select Graphic Rendition) codes for each semantic token. */
const ANSI: Record<ColorToken, string> = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  muted: "\x1b[90m", // bright-black / gray
  success: "\x1b[32m", // green
  danger: "\x1b[31m", // red
};
const ANSI_RESET = "\x1b[0m";

/** Look up the full {@link StatusStyle} for a status. */
export const statusStyle = (status: Status): StatusStyle => STATUS_STYLES[status];

/** The glyph for a status (Unicode by default, ASCII when `ascii` is true). */
export const glyph = (status: Status, ascii = false): string =>
  ascii ? STATUS_STYLES[status].ascii : STATUS_STYLES[status].glyph;

/**
 * Decide whether ANSI color should be emitted. Honors the `NO_COLOR` convention and
 * a non-TTY sink. Pure: callers pass the relevant bits of their environment.
 */
export const shouldUseColor = (
  opts: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly isTTY?: boolean;
  } = {},
): boolean => {
  const env = opts.env ?? {};
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") {
    return true;
  }
  return opts.isTTY ?? false;
};

/** Wrap `text` in the SGR codes for `token`, unless `color` is false. */
export const colorize = (text: string, token: ColorToken, color = true): string =>
  color ? `${ANSI[token]}${text}${ANSI_RESET}` : text;

/**
 * Render a status as `"<glyph> <label>"`, e.g. `"▶ running"`. With `color: true`
 * the whole badge is wrapped in the status' semantic color.
 */
export const formatStatus = (
  status: Status,
  opts: { readonly color?: boolean; readonly ascii?: boolean } = {},
): string => {
  const style = STATUS_STYLES[status];
  const badge = `${opts.ascii ? style.ascii : style.glyph} ${style.label}`;
  return colorize(badge, style.color, opts.color ?? false);
};

/** Default single-line truncation budget for log fields (chars). */
export const DEFAULT_MAX_LEN = 120;

/** The single-character ellipsis appended by {@link truncate}. */
export const ELLIPSIS = "…";

/**
 * Truncate `text` to at most `max` characters, appending {@link ELLIPSIS} when cut.
 * The ellipsis counts toward the budget so the result never exceeds `max`.
 */
export const truncate = (text: string, max: number = DEFAULT_MAX_LEN): string => {
  if (max <= 0) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  if (max <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, max);
  }
  return text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
};

/**
 * Collapse all runs of whitespace (including newlines) to single spaces, trim, then
 * {@link truncate}. Use for agent messages and **hook output** in logs so multi-line
 * or secret-bearing output can never span lines or blow up a log record
 * (PROJECT_BRIEF §9.2/§9.4).
 */
export const truncateOneLine = (text: string, max: number = DEFAULT_MAX_LEN): string =>
  truncate(text.replace(/\s+/g, " ").trim(), max);

/**
 * Roll a granular {@link RunAttemptPhase} (SPEC §7.2) up to one of the five
 * operator-facing {@link Status}es. The mapping is total (exhaustive over the phase
 * union) so a new phase forces a compile error here — the design system can never
 * silently drop a state.
 *
 * Notes on the non-obvious mappings:
 *   - `TimedOut`/`Stalled` → `retrying`: these are the *retryable* faults; the
 *     orchestrator backs off and tries again, so the operator sees "retrying".
 *   - `CanceledByReconciliation` → `blocked`: the worker was withdrawn (issue left
 *     an active state or lost a required label), not failed.
 */
export const PHASE_TO_STATUS: Record<RunAttemptPhase, Status> = {
  PreparingWorkspace: "running",
  BuildingPrompt: "running",
  LaunchingAgentProcess: "running",
  InitializingSession: "running",
  StreamingTurn: "running",
  Finishing: "running",
  Succeeded: "done",
  Failed: "failed",
  TimedOut: "retrying",
  Stalled: "retrying",
  CanceledByReconciliation: "blocked",
};

/** Convenience: map a run-attempt phase straight to its operator-facing status. */
export const phaseStatus = (phase: RunAttemptPhase): Status => PHASE_TO_STATUS[phase];
