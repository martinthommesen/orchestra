import { useState } from "react";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Panel } from "../components/Panel";
import {
  EMPTY_FILTER,
  type EventFilter,
  eventKinds,
  filterEvents,
  toEventsView,
} from "../model/events";
import { usePolling } from "../usePolling";

/**
 * Sprint 6 / #69 — the Events view: the bounded `recent_events` lifecycle feed, newest-first
 * (the pure `toEventsView` reverses the append-only wire order) and filterable by level, kind,
 * and free text (`filterEvents`, also pure). Same non-overlapping poll + last-good-on-error as
 * Fleet.
 */
export const EventsView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const [filter, setFilter] = useState<EventFilter>(EMPTY_FILTER);
  const now = Date.now();

  // The feed is bounded, so deriving on each render is cheap; relative labels then refresh on the
  // next poll without an effect or memo dance.
  const rows = poll.data === null ? [] : toEventsView(poll.data, now);
  const kinds = eventKinds(rows);
  const shown = filterEvents(rows, filter);

  return (
    <>
      <ConnectionBanner connection={poll.connection} error={poll.error} updatedLabel={null} />
      <Panel
        title={`Events (${shown.length})`}
        actions={
          <div className="filters">
            <select
              aria-label="Filter by level"
              value={filter.level}
              onChange={(e) =>
                setFilter((f) => ({ ...f, level: e.target.value as EventFilter["level"] }))
              }
            >
              <option value="all">all levels</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
            </select>
            <select
              aria-label="Filter by kind"
              value={filter.kind}
              onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="all">all kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Search events"
              placeholder="search…"
              value={filter.query}
              onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            />
          </div>
        }
      >
        {shown.length === 0 ? (
          <p className="view-placeholder">No events match the current filter.</p>
        ) : (
          <ul className="event-feed">
            {shown.map((e) => (
              <li key={e.seq} className="event-row">
                <span className="event-row__glyph" style={{ color: e.colorVar }} aria-hidden="true">
                  {e.glyph}
                </span>
                <span className="event-row__time">{e.relativeLabel}</span>
                <span className="event-row__kind mono">{e.kind}</span>
                {e.identifier ? <span className="event-row__id mono">{e.identifier}</span> : null}
                <span className="event-row__msg">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
};
