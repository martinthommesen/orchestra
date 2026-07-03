import type { ReactNode } from "react";
import { formatDuration } from "../model/format";
import type { ConnectionState } from "../model/poller";
import { ROUTE_KEY, ROUTE_LABELS, ROUTES, type Route, routeHref } from "../router";
import { useSnapshot } from "../snapshot";
import type { Theme } from "../useTheme";
import { PALETTE_HINT } from "./CommandPalette";
import {
  ColumnsIcon,
  CommandIcon,
  FleetIcon,
  GearIcon,
  ListIcon,
  MoonIcon,
  OrchestraMark,
  SunIcon,
} from "./icons";

/**
 * App shell — the persistent IDE-style frame around every view. A left sidebar carries the brand, the
 * four nav targets (Fleet · Kanban · Events · Settings) as real `<a href="#/route">` hash links (so
 * click, copy-link, open-in-new-tab and middle-click all behave natively), and a live fleet-status
 * footer fed by the shared snapshot poll (`useSnapshot`) — the connection state and dispatch gate are
 * shown once here, globally, instead of a banner per view. A slim topbar names the active view; the
 * theme toggle sits top-right. Presentational only: route + theme state are owned above (in `App`).
 */

const ROUTE_ICON: Record<Route, typeof FleetIcon> = {
  fleet: FleetIcon,
  kanban: ColumnsIcon,
  events: ListIcon,
  settings: GearIcon,
};

const CONNECTION: Record<ConnectionState, { label: string; cls: string }> = {
  live: { label: "Live", cls: "is-live" },
  stale: { label: "Reconnecting", cls: "is-stale" },
  connecting: { label: "Connecting", cls: "is-connecting" },
};

export const AppShell = ({
  route,
  theme,
  onToggleTheme,
  onOpenPalette,
  children,
}: {
  route: Route;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  children: ReactNode;
}) => {
  const poll = useSnapshot();
  const conn = CONNECTION[poll.connection];
  const paused = poll.data?.control?.dispatch_paused ?? false;
  const pausedBy = poll.data?.control?.paused_by ?? null;
  const running = poll.data?.counts.running ?? null;
  const updatedLabel =
    poll.lastUpdatedAtMs === null
      ? null
      : `${formatDuration(Date.now() - poll.lastUpdatedAtMs)} ago`;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="brand__mark" aria-hidden="true">
            <OrchestraMark />
          </span>
          <span className="brand__word">Orchestra</span>
        </div>

        <nav className="sidebar__nav" aria-label="Primary">
          {ROUTES.map((r) => {
            const Icon = ROUTE_ICON[r];
            return (
              <a
                key={r}
                href={routeHref(r)}
                className={r === route ? "navitem navitem--active" : "navitem"}
                aria-current={r === route ? "page" : undefined}
                aria-keyshortcuts={`g ${ROUTE_KEY[r]}`}
                title={`${ROUTE_LABELS[r]} — press g then ${ROUTE_KEY[r]}`}
              >
                <span className="navitem__icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="navitem__label">{ROUTE_LABELS[r]}</span>
                <kbd className="navitem__kbd">g {ROUTE_KEY[r]}</kbd>
              </a>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          <div className="fleetstatus">
            <span className="fleetstatus__row">
              <span className={`statusdot ${conn.cls}`} aria-hidden="true" />
              <span className="fleetstatus__label">
                {poll.connection === "stale" && poll.error
                  ? "Reconnecting…"
                  : poll.connection === "connecting" && poll.error
                    ? "Connection failed"
                    : conn.label}
              </span>
              {updatedLabel ? <span className="fleetstatus__meta">{updatedLabel}</span> : null}
            </span>
            {poll.error && poll.connection !== "live" ? (
              <span className="fleetstatus__row fleetstatus__error">{poll.error}</span>
            ) : (
              <span className="fleetstatus__row">
                <span
                  className={`statusdot ${paused ? "is-paused" : "is-running"}`}
                  aria-hidden="true"
                />
                <span className="fleetstatus__label">
                  {paused ? `Paused${pausedBy ? ` · ${pausedBy}` : ""}` : "Dispatching"}
                </span>
                {running !== null ? (
                  <span className="fleetstatus__meta">{running} active</span>
                ) : null}
              </span>
            )}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1 className="topbar__title">{ROUTE_LABELS[route]}</h1>
          <div className="topbar__actions">
            <button
              type="button"
              className="cmdk-trigger"
              onClick={onOpenPalette}
              aria-label="Open command palette"
            >
              <CommandIcon />
              <span className="cmdk-trigger__label">Commands</span>
              <kbd className="cmdk-trigger__kbd">{PALETTE_HINT}</kbd>
            </button>
            <button
              type="button"
              className="iconbtn"
              onClick={onToggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true">{theme === "dark" ? <SunIcon /> : <MoonIcon />}</span>
            </button>
          </div>
        </header>
        <main className="canvas">{children}</main>
      </div>
    </div>
  );
};
