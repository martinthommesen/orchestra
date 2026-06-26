import type { ReactNode } from "react";
import { ROUTE_KEY, ROUTE_LABELS, ROUTES, type Route, routeHref } from "../router";
import type { Theme } from "../useTheme";
import { ColumnsIcon, FleetIcon, GearIcon, ListIcon, MoonIcon, SunIcon } from "./icons";

/**
 * App shell — the persistent nav frame around every view. Renders the four nav targets (Fleet ·
 * Kanban · Events · Settings) as real `<a href="#/route">` hash links, so navigation, copy-link,
 * open-in-new-tab and middle-click all behave natively: a click updates `location.hash`, which
 * `useRoute`'s `hashchange` listener turns into the new route (no JS click handler needed). Each
 * link carries its route glyph + a visible `g`-key shortcut badge (`aria-keyshortcuts` + `title`
 * for AT). The trailing theme toggle (sun/moon) flips `data-theme` via `useTheme`. Presentational
 * only: route + theme state are owned above (in `App`).
 */

const ROUTE_ICON: Record<Route, typeof FleetIcon> = {
  fleet: FleetIcon,
  kanban: ColumnsIcon,
  events: ListIcon,
  settings: GearIcon,
};

export const AppShell = ({
  route,
  theme,
  onToggleTheme,
  children,
}: {
  route: Route;
  theme: Theme;
  onToggleTheme: () => void;
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
        {ROUTES.map((r) => {
          const Icon = ROUTE_ICON[r];
          return (
            <a
              key={r}
              href={routeHref(r)}
              className={r === route ? "nav-link nav-link--active" : "nav-link"}
              aria-current={r === route ? "page" : undefined}
              aria-keyshortcuts={`g ${ROUTE_KEY[r]}`}
              title={`${ROUTE_LABELS[r]} — press g then ${ROUTE_KEY[r]}`}
            >
              <span className="nav-link__icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-link__label">{ROUTE_LABELS[r]}</span>
              <kbd className="nav-link__kbd">g{ROUTE_KEY[r]}</kbd>
            </a>
          );
        })}
      </nav>
      <button
        type="button"
        className="theme-toggle"
        onClick={onToggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      >
        <span className="theme-toggle__icon" aria-hidden="true">
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </span>
      </button>
    </header>
    <main className="app-shell__main">{children}</main>
  </div>
);
