import { useState } from "react";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { type CardAction, type KanbanCard, toKanban } from "../model/kanban";
import { usePolling } from "../usePolling";

/**
 * Sprint 6 / #70 — the Kanban board. Columns are derived by the pure, unit-tested `toKanban` over
 * the polled snapshot (no drag). Running cards expose a Cancel button and Retrying cards a
 * Retry-now button; both call the authorized POSTs and reflect the returned `CommandResult`
 * (`AckWire`), reverting (re-enabling) the button on a rejected/failed call.
 */

type ActionPhase = "pending" | "ok" | "error";
interface ActionState {
  readonly phase: ActionPhase;
  readonly message: string;
}

const runAction = (action: CardAction, issueId: string) =>
  action === "cancel" ? client.cancel(issueId) : client.retry(issueId);

export const KanbanView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const now = Date.now();

  const dispatch = async (action: CardAction, issueId: string) => {
    setActions((a) => ({ ...a, [issueId]: { phase: "pending", message: "" } }));
    try {
      const ack = await runAction(action, issueId);
      setActions((a) => ({
        ...a,
        [issueId]: ack.accepted
          ? { phase: "ok", message: "requested" }
          : { phase: "error", message: ack.reason ?? "not accepted" },
      }));
    } catch (err) {
      // Revert on error: surface the reason and re-enable the button for another attempt.
      setActions((a) => ({
        ...a,
        [issueId]: { phase: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const columns = poll.data === null ? [] : toKanban(poll.data, now);

  return (
    <>
      <ConnectionBanner connection={poll.connection} error={poll.error} updatedLabel={null} />
      {poll.data === null ? (
        <p className="view-placeholder">Waiting for the first snapshot…</p>
      ) : (
        <div className="kanban">
          {columns.map((col) => (
            <section className="kanban__col" key={col.id} aria-label={col.title}>
              <header className="kanban__col-head">
                <span className="kanban__col-title">{col.title}</span>
                <span className="kanban__col-count">{col.count}</span>
              </header>
              <div className="kanban__cards">
                {col.countOnly ? (
                  <p className="kanban__count-only muted">
                    {col.count} reserved, awaiting dispatch
                  </p>
                ) : col.cards.length === 0 ? (
                  <p className="kanban__empty muted">—</p>
                ) : (
                  col.cards.map((card) => (
                    <Card
                      key={card.issueId}
                      card={card}
                      action={actions[card.issueId]}
                      onAct={dispatch}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
};

const ACTION_LABEL: Record<CardAction, string> = { cancel: "Cancel", retry: "Retry now" };

const Card = ({
  card,
  action,
  onAct,
}: {
  card: KanbanCard;
  action: ActionState | undefined;
  onAct: (action: CardAction, issueId: string) => void;
}) => {
  const pending = action?.phase === "pending";
  const done = action?.phase === "ok";
  return (
    <article className="card">
      <div className="card__head">
        <span className="card__id mono">{card.identifier}</span>
        <span
          className="status-chip"
          role="img"
          aria-label={`status: ${card.badge.label}`}
          style={{ color: card.badge.colorVar, borderColor: card.badge.colorVar }}
        >
          <span aria-hidden="true">{card.badge.glyph}</span>
          <span>{card.badge.label}</span>
        </span>
      </div>
      <p className="card__detail muted">{card.detail}</p>
      {card.action ? (
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={pending || done}
            onClick={() => card.action && onAct(card.action, card.issueId)}
          >
            {pending ? "…" : done ? "requested ✓" : ACTION_LABEL[card.action]}
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
