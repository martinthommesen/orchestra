/**
 * Sprint 6 / #69 — pure, DOM-free formatting helpers shared by the cockpit view-models. These
 * mirror the Ink dashboard's honesty rules (Sprint 2 review): client-side elapsed from
 * `started_at`, an explicit `—` sentinel for unparseable timestamps (never a fake "0s"), and a
 * clamped duration so fixed-width labels stay honest. Kept separate + pure so the Fleet/Events
 * mappers stay unit-testable under Node.
 */

/** The sentinel shown when a timestamp cannot be parsed — never a plausible "0s". */
export const UNKNOWN_TIME = "—";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Upper bound on rendered seconds (`99h 59m 59s`) so durations never overflow a column. */
const DURATION_MAX_SEC = 99 * 3600 + 59 * 60 + 59;

/** Compact, human duration: `8s`, `1m 04s`, `2h 09m` (clamped to `99h 59m`). */
export const formatDuration = (ms: number): string => {
  const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.min(Math.floor(clamped / 1000), DURATION_MAX_SEC);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
};

/** Client-side elapsed from an ISO `started_at`; `—` when unparseable. */
export const formatElapsed = (now: number, startedAt: string): string => {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? formatDuration(now - started) : UNKNOWN_TIME;
};

/** Relative wall-clock label ("3s ago"); `—` when the ISO instant is unparseable. */
export const formatRelative = (now: number, iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${formatDuration(now - t)} ago` : UNKNOWN_TIME;
};

/** Attempt label: `#3`, or `—` when the attempt is unknown. */
export const attemptLabel = (attempt: number | null): string =>
  attempt === null ? UNKNOWN_TIME : `#${attempt}`;
