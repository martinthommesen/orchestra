/**
 * Sprint 6 / #68 — the cockpit's tiny hash router. Pure and DOM-free so it unit-tests under Node
 * and keeps the dependency budget honest (no react-router). The four nav targets map 1:1 to the
 * four top-level views (#69 Fleet/Events, #70 Kanban, #71 Settings). The DOM binding (listening to
 * `hashchange`) lives in `useRoute.ts`; this module only parses/serializes.
 */

export type Route = "fleet" | "kanban" | "events" | "settings";

/** All routes in nav order. Fleet is the default (the session overview). */
export const ROUTES: readonly Route[] = ["fleet", "kanban", "events", "settings"];

/** Human label for the nav. */
export const ROUTE_LABELS: Record<Route, string> = {
  fleet: "Fleet",
  kanban: "Kanban",
  events: "Events",
  settings: "Settings",
};

const isRoute = (value: string): value is Route => (ROUTES as readonly string[]).includes(value);

/** Parse a `location.hash` (e.g. `"#/kanban"`) → a Route, defaulting to Fleet for anything else. */
export const parseRoute = (hash: string): Route => {
  const slug = hash.replace(/^#\/?/, "").trim().toLowerCase();
  return isRoute(slug) ? slug : "fleet";
};

/** Serialize a Route → an href for a nav link. */
export const routeHref = (route: Route): string => `#/${route}`;
