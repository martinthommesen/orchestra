import { AppShell } from "./components/AppShell";
import type { Route } from "./router";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useRoute } from "./useRoute";
import { useTheme } from "./useTheme";
import { EventsView } from "./views/EventsView";
import { FleetView } from "./views/FleetView";
import { KanbanView } from "./views/KanbanView";
import { SettingsView } from "./views/SettingsView";

/**
 * The cockpit app root. Owns route state (via `useRoute`), the active theme (`useTheme`), and binds
 * the `g`-prefixed keyboard navigation, then renders the persistent app shell around the active
 * view. All four views are live: Fleet (default), Kanban, Events and Settings. Each view owns its
 * own toast queue (`useToast`) so a transient confirmation surfaces where the action happened.
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
  const { theme, toggle } = useTheme();
  useKeyboardShortcuts(navigate);
  return (
    <AppShell route={route} theme={theme} onToggleTheme={toggle}>
      {viewFor(route)}
    </AppShell>
  );
};
