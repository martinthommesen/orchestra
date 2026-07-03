import { useState } from "react";
import { SearchIcon } from "../components/icons";
import { Panel } from "../components/Panel";
import { SkeletonTable } from "../components/Skeleton";
import {
  EMPTY_FILTER,
  type EventFilter,
  eventKinds,
  filterEvents,
  toEventsView,
} from "../model/events";
import { useSnapshot } from "../snapshot";

/**
 * The Events view: the bounded `recent_events` lifecycle feed, newest-first (the pure `toEventsView`
 * reverses the append-only wire order) and filterable by level, kind, and free text (`filterEvents`,
 * also pure). Reads the shared snapshot poll. The filter bar lives in the panel header so it stays put
 * while scrolling a long feed.
 */
export const EventsView = () => {
  const poll = useSnapshot();
  const [filter, setFilter] = useState<EventFilter>(EMPTY_FILTER);
  const now = Date.now();

  const rows = poll.data === null ? [] : toEventsView(poll.data, now);
  const kinds = eventKinds(rows);
  const shown = filterEvents(rows, filter);

  return (
    <div className="view">
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
              <option value="all">All levels</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
            </select>
            <select
              aria-label="Filter by kind"
              value={filter.kind}
              onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="all">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <span className="filters__search">
              <SearchIcon />
              <input
                type="search"
                aria-label="Search events"
                placeholder="Search…"
                value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
              />
            </span>
          </div>
        }
      >
        {poll.data === null ? (
          <SkeletonTable rows={6} columns={5} />
        ) : shown.length === 0 ? (
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
    </div>
  );
};
