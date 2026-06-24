import { AppShell } from "./components/AppShell";
import type { Route } from "./router";
import { useRoute } from "./useRoute";
import { EventsView } from "./views/EventsView";
import { FleetView } from "./views/FleetView";
import { KanbanView } from "./views/KanbanView";
import { SettingsView } from "./views/SettingsView";

/**
 * Sprint 6 — the cockpit app root. Owns route state (via `useRoute`) and renders the persistent
 * app shell around the active view. All four views are live: Fleet (#69, default), Events (#69),
 * Kanban (#70) and Settings (#71).
 */

const viewFor = (route: Route) => {
  switch (route) {
    case "fleet":
      return <FleetView />;
    case "events":
      return <EventsView />;
    case "kanban":
      return <KanbanView />;
    case "settings":
      return <SettingsView />;
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
