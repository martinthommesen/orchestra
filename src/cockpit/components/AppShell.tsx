import type { ReactNode } from "react";
import { ROUTE_KEY, ROUTE_LABELS, ROUTES, type Route, routeHref } from "../router";

/**
 * App shell (#68) — the persistent nav frame around every view. Renders the four nav targets
 * (Fleet · Kanban · Events · Settings) as real `<a href="#/route">` hash links, so navigation,
 * copy-link, open-in-new-tab and middle-click all behave natively: a click updates `location.hash`,
 * which `useRoute`'s `hashchange` listener turns into the new route (no JS click handler needed).
 * Marks the active link and exposes each one's `g`-prefixed keyboard shortcut (`aria-keyshortcuts` +
 * `title`), then slots the active view into `<main>`. Presentational only: route state is owned
 * above (in `App` via `useRoute`).
 */
export const AppShell = ({ route, children }: { route: Route; children: ReactNode }) => (
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
          <a
            key={r}
            href={routeHref(r)}
            className={r === route ? "nav-link nav-link--active" : "nav-link"}
            aria-current={r === route ? "page" : undefined}
            aria-keyshortcuts={`g ${ROUTE_KEY[r]}`}
            title={`${ROUTE_LABELS[r]} — press g then ${ROUTE_KEY[r]}`}
          >
            {ROUTE_LABELS[r]}
          </a>
        ))}
      </nav>
    </header>
    <main className="app-shell__main">{children}</main>
  </div>
);
