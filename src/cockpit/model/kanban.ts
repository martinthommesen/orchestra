import { truncateOneLine } from "../../core/observability/glyphs";
import type { SnapshotWire } from "../api/types";
import type { Status } from "../design/tokens";
import { badgeForPhase, badgeOf, type StatusBadgeVM } from "./fleet";
import { attemptLabel, formatDueAt, formatElapsed, formatRelative } from "./format";

/**
 * Sprint 6 / #70 — the pure Kanban derivation. Projects a `SnapshotWire` into four ordered
 * columns (Claimed → Running → Retrying → Completed) of render-ready cards. Pure + unit-tested so
 * the React board stays presentational and never touches the snapshot shape directly.
 *
 * Wire reality: the snapshot does NOT carry the claimed issue IDs (only `counts.claimed`, which is
 * the reserved∪running∪retrying superset). So the Claimed column is count-only — the *pending*
 * (reserved-but-not-yet-running) count, clamped ≥ 0 — while Running/Retrying/Completed carry real
 * per-issue cards. Only Running cards (Cancel) and Retrying cards (Retry-now) are actionable.
 */

const ERROR_MAX = 120;

export type CardAction = "cancel" | "retry";

export type ColumnId = "claimed" | "running" | "retrying" | "completed";

export interface KanbanCard {
  readonly issueId: string;
  readonly identifier: string;
  readonly badge: StatusBadgeVM;
  /** A short secondary line (elapsed / due / outcome). */
  readonly detail: string;
  /** The actionable button this card exposes, or null when none applies. */
  readonly action: CardAction | null;
}

export interface KanbanColumn {
  readonly id: ColumnId;
  readonly title: string;
  readonly count: number;
  readonly cards: ReadonlyArray<KanbanCard>;
  /** True when the column shows a count without per-issue cards (no IDs on the wire). */
  readonly countOnly: boolean;
}

/** Outcome → the design-system status used for a completed card's badge. */
const outcomeStatus = (outcome: string): Status => {
  switch (outcome) {
    case "completed":
      return "done";
    case "killed":
    case "failed":
      return "failed";
    default:
      return "blocked";
  }
};

export const toKanban = (s: SnapshotWire, now: number): ReadonlyArray<KanbanColumn> => {
  const running: ReadonlyArray<KanbanCard> = s.running.map((r) => ({
    issueId: r.issue_id,
    identifier: r.issue_identifier,
    badge: badgeForPhase(r.status),
    detail: `${attemptLabel(r.attempt)} · ${formatElapsed(now, r.started_at)}`,
    action: "cancel",
  }));

  const retrying: ReadonlyArray<KanbanCard> = s.retrying.map((r) => {
    const due = formatDueAt(r.scheduled_at, r.delay_ms);
    const reason = r.error === null ? null : truncateOneLine(r.error, ERROR_MAX);
    const detail = [`#${r.attempt}`, due, reason]
      .filter((x): x is string => x !== null)
      .join(" · ");
    return {
      issueId: r.issue_id,
      identifier: r.identifier,
      badge: badgeOf("retrying"),
      detail,
      action: "retry",
    };
  });

  // Rich completions ride newest-last on the wire — newest-first here. Falls back to the IDs-only
  // `completed` list when the daemon doesn't send the rich block.
  const completed: ReadonlyArray<KanbanCard> =
    s.recent_completed.length > 0
      ? [...s.recent_completed].reverse().map((c) => ({
          issueId: c.issue_id,
          identifier: c.identifier,
          badge: badgeOf(outcomeStatus(c.outcome)),
          detail: `${c.outcome} · ${formatRelative(now, c.finished_at)}`,
          action: null,
        }))
      : [...s.completed].reverse().map((id) => ({
          issueId: id,
          identifier: id,
          badge: badgeOf("done"),
          detail: "completed",
          action: null,
        }));

  // Claimed superset = reserved ∪ running ∪ retrying; the pending (not-yet-running) count is the
  // remainder, clamped ≥ 0 against any transient count drift.
  const pendingClaimed = Math.max(0, s.counts.claimed - s.counts.running - s.counts.retrying);

  return [
    { id: "claimed", title: "Claimed", count: pendingClaimed, cards: [], countOnly: true },
    { id: "running", title: "Running", count: running.length, cards: running, countOnly: false },
    {
      id: "retrying",
      title: "Retrying",
      count: retrying.length,
      cards: retrying,
      countOnly: false,
    },
    {
      id: "completed",
      title: "Completed",
      count: s.counts.completed,
      cards: completed,
      countOnly: false,
    },
  ];
};
