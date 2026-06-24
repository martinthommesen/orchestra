import { AppShell } from "./components/AppShell";
import { Panel } from "./components/Panel";
import type { Route } from "./router";
import { ROUTE_LABELS } from "./router";
import { useRoute } from "./useRoute";

/**
 * Sprint 6 / #68 — the cockpit app root. Owns route state (via `useRoute`) and renders the
 * persistent app shell around the active view. The four views are placeholders for now; #69
 * (Fleet/Events), #70 (Kanban), and #71 (Settings) replace each in turn.
 */

const Placeholder = ({ route }: { route: Route }) => (
  <Panel title={ROUTE_LABELS[route]}>
    <p className="view-placeholder">
      The {ROUTE_LABELS[route]} view lands in a later Phase-2 issue.
    </p>
  </Panel>
);

export const App = () => {
  const { route, navigate } = useRoute();
  return (
    <AppShell route={route} onNavigate={navigate}>
      <Placeholder route={route} />
    </AppShell>
  );
};
