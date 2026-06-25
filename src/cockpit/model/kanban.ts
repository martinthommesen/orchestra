import { truncateOneLine } from "../../core/observability/glyphs";
import type { SnapshotWire } from "../api/types";
import type { Status } from "../design/tokens";
import { badgeForPhase, badgeOf, type StatusBadgeVM } from "./fleet";
import { attemptLabel, formatDueAt, formatElapsed, formatRelative } from "./format";

/**
 * Sprint 6 / #70 — the pure Kanban derivation. Projects a `SnapshotWire` into four ordered
 * columns (Claimed → Running → Retrying → Abandoned → Completed) of render-ready cards. Pure +
 * unit-tested so the React board stays presentational and never touches the snapshot shape directly.
 *
 * Wire reality: the snapshot does NOT carry the claimed issue IDs (only `counts.claimed`, which is
 * the reserved∪running∪retrying∪abandoned superset). So the Claimed column is count-only — the
 * *pending* (reserved-but-not-yet-running) count, clamped ≥ 0 — while the other columns carry real
 * per-issue cards. Only Running cards (Cancel) and Retrying cards (Retry-now) are actionable.
 */

const ERROR_MAX = 120;

export type CardAction = "cancel" | "retry";

export type ColumnId = "claimed" | "running" | "retrying" | "abandoned" | "completed";

export interface KanbanCard {
  readonly issueId: string;
  /**
   * A stable per-SESSION identity, distinct from `issueId`. Action state (pending/ok/error)
   * is keyed by this so that when an issue re-appears as a NEW session (cancelled then
   * re-dispatched, or a retry returns to running) its button is re-enabled rather than stuck
   * disabled from the prior session's `ok`. Running uses `started_at`, retrying uses `attempt`.
   */
  readonly instanceKey: string;
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
    instanceKey: `${r.issue_id}:${r.started_at}`,
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
      instanceKey: `${r.issue_id}:${r.attempt}`,
      identifier: r.identifier,
      badge: badgeOf("retrying"),
      detail,
      action: "retry",
    };
  });

  const abandoned: ReadonlyArray<KanbanCard> = s.abandoned.map((a) => ({
    issueId: a.issue_id,
    instanceKey: `${a.issue_id}:${a.abandoned_at}`,
    identifier: a.identifier,
    badge: badgeOf("blocked"),
    detail: [
      `#${a.attempts}`,
      `parked ${formatRelative(now, a.abandoned_at)}`,
      truncateOneLine(a.reason, ERROR_MAX),
    ]
      .filter((x) => x !== "")
      .join(" · "),
    action: null,
  }));

  // Rich completions ride newest-last on the wire — newest-first here. Falls back to the IDs-only
  // `completed` list when the daemon doesn't send the rich block.
  const completed: ReadonlyArray<KanbanCard> =
    s.recent_completed.length > 0
      ? [...s.recent_completed].reverse().map((c) => ({
          issueId: c.issue_id,
          instanceKey: `${c.issue_id}:${c.finished_at}`,
          identifier: c.identifier,
          badge: badgeOf(outcomeStatus(c.outcome)),
          detail: `${c.outcome} · ${formatRelative(now, c.finished_at)}`,
          action: null,
        }))
      : [...s.completed].reverse().map((id) => ({
          issueId: id,
          instanceKey: `${id}:completed`,
          identifier: id,
          badge: badgeOf("done"),
          detail: "completed",
          action: null,
        }));

  // Claimed superset = reserved ∪ running ∪ retrying ∪ abandoned; the pending
  // (not-yet-running) count is the remainder, clamped ≥ 0 against transient count drift.
  const pendingClaimed = Math.max(
    0,
    s.counts.claimed - s.counts.running - s.counts.retrying - s.counts.abandoned,
  );

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
      id: "abandoned",
      title: "Abandoned",
      count: abandoned.length,
      cards: abandoned,
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
