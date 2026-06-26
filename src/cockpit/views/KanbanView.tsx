import { type CSSProperties, useEffect, useState } from "react";
import { describeError } from "../api/errors";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { SkeletonCards } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { ToastRegion, useToast } from "../components/Toast";
import { type CardAction, type ColumnId, type KanbanCard, toKanban } from "../model/kanban";
import { usePolling } from "../usePolling";

/**
 * The Kanban board. Columns are derived by the pure, unit-tested `toKanban` over the polled
 * snapshot (no drag). Running cards expose a Cancel button and Retrying cards a Retry-now button;
 * both call the authorized POSTs and reflect the returned `CommandResult` (`AckWire`), reverting
 * (re-enabling) the button on a rejected/failed call. A successful action surfaces a transient
 * toast.
 *
 * Action state is keyed by each card's per-session `instanceKey` (not `issueId`): a previously
 * actioned issue that re-appears as a NEW session gets a fresh, enabled button. Stale entries are
 * pruned each poll so the map can't grow unbounded.
 */

type ActionPhase = "pending" | "ok" | "error";
interface ActionState {
  readonly phase: ActionPhase;
  readonly message: string;
}

const runAction = (action: CardAction, issueId: string) =>
  action === "cancel" ? client.cancel(issueId) : client.retry(issueId);

/** Per-column accent color (the design-system status each column represents). */
const COLUMN_ACCENT: Record<ColumnId, string> = {
  claimed: "var(--accent)",
  running: "var(--status-info)",
  retrying: "var(--status-warn)",
  abandoned: "var(--status-muted)",
  completed: "var(--status-success)",
};

export const KanbanView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const toast = useToast();
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const now = Date.now();

  const columns = poll.data === null ? [] : toKanban(poll.data, now);

  // Prune action state for sessions no longer in the snapshot so the map can't grow unbounded
  // (and a recycled issueId can't inherit a prior session's state — keys are per-session).
  const liveKeys = columns
    .flatMap((col) => col.cards.map((card) => card.instanceKey))
    .join("\u0000");
  useEffect(() => {
    if (poll.data === null) return;
    const present = new Set(liveKeys === "" ? [] : liveKeys.split("\u0000"));
    setActions((a) => {
      const next: Record<string, ActionState> = {};
      let changed = false;
      for (const [key, state] of Object.entries(a)) {
        if (present.has(key)) next[key] = state;
        else changed = true;
      }
      return changed ? next : a;
    });
  }, [liveKeys, poll.data]);

  const dispatch = async (action: CardAction, card: KanbanCard) => {
    setActions((a) => ({ ...a, [card.instanceKey]: { phase: "pending", message: "" } }));
    try {
      const ack = await runAction(action, card.issueId);
      if (ack.accepted) {
        setActions((a) => ({ ...a, [card.instanceKey]: { phase: "ok", message: "requested" } }));
        toast.notify(
          "success",
          `${action === "cancel" ? "Cancel" : "Retry"} requested for ${card.identifier}`,
        );
      } else {
        const reason = ack.reason ?? "not accepted";
        setActions((a) => ({ ...a, [card.instanceKey]: { phase: "error", message: reason } }));
        toast.notify("danger", `${card.identifier}: ${reason}`);
      }
    } catch (err) {
      // Revert on error: surface the reason and re-enable the button for another attempt.
      const msg = describeError(err);
      setActions((a) => ({ ...a, [card.instanceKey]: { phase: "error", message: msg } }));
      toast.notify("danger", `${card.identifier}: ${msg}`);
    }
  };

  return (
    <>
      <ConnectionBanner
        connection={poll.connection}
        error={poll.error}
        updatedLabel={null}
        intervalMs={COCKPIT_POLL_MS}
        lastUpdatedAtMs={poll.lastUpdatedAtMs}
      />
      {poll.data === null ? (
        <div className="kanban">
          {["claimed", "running", "retrying", "abandoned", "completed"].map((id) => (
            <section
              className="kanban__col"
              key={id}
              style={{ "--col-accent": COLUMN_ACCENT[id as ColumnId] } as CSSProperties}
            >
              <header className="kanban__col-head">
                <span className="kanban__col-title">{id}</span>
                <span className="kanban__col-count">·</span>
              </header>
              <div className="kanban__cards">
                <SkeletonCards count={id === "claimed" ? 0 : 2} />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="kanban">
          {columns.map((col) => (
            <section
              className="kanban__col"
              key={col.id}
              aria-label={col.title}
              style={{ "--col-accent": COLUMN_ACCENT[col.id] } as CSSProperties}
            >
              <header className="kanban__col-head">
                <span className="kanban__col-title">{col.title}</span>
                <span className="kanban__col-count">{col.count}</span>
              </header>
              <div className="kanban__cards">
                {col.countOnly ? (
                  <p className="kanban__count-only muted">
                    {col.count} reserved, awaiting dispatch.
                    <span className="kanban__hint">
                      The daemon doesn't expose claimed issues individually yet, so they show as a
                      count rather than cards.
                    </span>
                  </p>
                ) : col.cards.length === 0 ? (
                  <p className="kanban__empty">
                    <span className="kanban__empty-glyph" aria-hidden="true">
                      —
                    </span>
                    <span>empty</span>
                  </p>
                ) : (
                  col.cards.map((card) => (
                    <Card
                      key={card.instanceKey}
                      card={card}
                      action={actions[card.instanceKey]}
                      onAct={dispatch}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  );
};

const ACTION_LABEL: Record<CardAction, string> = { cancel: "Cancel", retry: "Retry now" };

/** Cancel kills a live session, so it arms a one-shot inline confirm before firing (no modal). */
const CONFIRM_WINDOW_MS = 4000;

const Card = ({
  card,
  action,
  onAct,
}: {
  card: KanbanCard;
  action: ActionState | undefined;
  onAct: (action: CardAction, card: KanbanCard) => void;
}) => {
  const pending = action?.phase === "pending";
  const done = action?.phase === "ok";
  const [armed, setArmed] = useState(false);

  // Auto-disarm so a half-clicked Cancel can't linger and fire long after the operator moved on.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const act = card.action;
  const confirmable = act === "cancel";

  const onClick = () => {
    if (act === null) return;
    if (confirmable && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onAct(act, card);
  };

  const baseLabel = act === null ? "" : ACTION_LABEL[act];
  const label = pending ? "…" : done ? "requested ✓" : armed ? "Confirm cancel" : baseLabel;

  return (
    <article className="card" style={{ "--card-accent": card.badge.colorVar } as CSSProperties}>
      <div className="card__head">
        <span className="card__id mono">{card.identifier}</span>
        <StatusChip badge={card.badge} size="sm" />
      </div>
      <p className="card__detail muted">{card.detail}</p>
      {act ? (
        <div className="card__actions">
          <button
            type="button"
            className={armed ? "btn btn--sm btn--danger" : "btn btn--sm"}
            disabled={pending || done}
            onClick={onClick}
            title={armed ? "Click again to confirm — this stops the running session" : undefined}
          >
            {label}
          </button>
          {action?.phase === "error" ? (
            <span className="card__error" role="alert">
              {action.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
};
