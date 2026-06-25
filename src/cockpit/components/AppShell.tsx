import type { ReactNode } from "react";
import { ROUTE_KEY, ROUTE_LABELS, ROUTES, type Route } from "../router";

/**
 * App shell (#68) — the persistent nav frame around every view. Renders the four nav targets
 * (Fleet · Kanban · Events · Settings) as buttons, marks the active one, exposes each button's
 * `g`-prefixed keyboard shortcut (`aria-keyshortcuts` + `title`), and slots the active view into
 * `<main>`. Presentational only: route state is owned above (in `App` via `useRoute`).
 */
export const AppShell = ({
  route,
  onNavigate,
  children,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  children: ReactNode;
}) => (
  <div className="app-shell">
    <header className="app-shell__bar">
      <div className="app-shell__brand">
        <span className="app-shell__glyph" aria-hidden="true">
          ▶
        </span>
        <span className="app-shell__name">Orchestra</span>
        <span className="app-shell__sub">cockpit</span>
      </div>
      <nav className="app-shell__nav" aria-label="Primary">
        {ROUTES.map((r) => (
          <button
            key={r}
            type="button"
            className={r === route ? "nav-link nav-link--active" : "nav-link"}
            aria-current={r === route ? "page" : undefined}
            aria-keyshortcuts={`g ${ROUTE_KEY[r]}`}
            title={`${ROUTE_LABELS[r]} — press g then ${ROUTE_KEY[r]}`}
            onClick={() => onNavigate(r)}
          >
            {ROUTE_LABELS[r]}
          </button>
        ))}
      </nav>
    </header>
    <main className="app-shell__main">{children}</main>
  </div>
);
