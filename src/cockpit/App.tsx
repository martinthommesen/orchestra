import { AppShell } from "./components/AppShell";
import { Panel } from "./components/Panel";
import type { Route } from "./router";
import { ROUTE_LABELS } from "./router";
import { useRoute } from "./useRoute";
import { EventsView } from "./views/EventsView";
import { FleetView } from "./views/FleetView";

/**
 * Sprint 6 — the cockpit app root. Owns route state (via `useRoute`) and renders the persistent
 * app shell around the active view. Fleet (#69, default) and Events (#69) are live; Kanban (#70)
 * and Settings (#71) are placeholders until their issues land.
 */

const Placeholder = ({ route }: { route: Route }) => (
  <Panel title={ROUTE_LABELS[route]}>
    <p className="view-placeholder">
      The {ROUTE_LABELS[route]} view lands in a later Phase-2 issue.
    </p>
  </Panel>
);

const viewFor = (route: Route) => {
  switch (route) {
    case "fleet":
      return <FleetView />;
    case "events":
      return <EventsView />;
    default:
      return <Placeholder route={route} />;
  }
};

export const App = () => {
  const { route, navigate } = useRoute();
  return (
    <AppShell route={route} onNavigate={navigate}>
      {viewFor(route)}
    </AppShell>
  );
};
