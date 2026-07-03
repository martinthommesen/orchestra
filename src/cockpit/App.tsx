import { useEffect, useState } from "react";
import { COCKPIT_POLL_MS, client } from "./api/instance";
import { AppShell } from "./components/AppShell";
import { CommandPalette } from "./components/CommandPalette";
import type { Route } from "./router";
import { SnapshotProvider } from "./snapshot";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { usePolling } from "./usePolling";
import { useRoute } from "./useRoute";
import { useTheme } from "./useTheme";
import { EventsView } from "./views/EventsView";
import { FleetView } from "./views/FleetView";
import { KanbanView } from "./views/KanbanView";
import { SettingsView } from "./views/SettingsView";

/**
 * The cockpit app root. Owns route state (`useRoute`), the active theme (`useTheme`), the `g`-prefixed
 * keyboard navigation, the ⌘K command palette, and the single shared snapshot poll — provided via
 * `SnapshotProvider` so every view, the sidebar fleet-status footer, and the palette read one
 * non-overlapping poll of `GET /api/v1/state` (last-good-on-error) rather than each mounting its own.
 * The persistent app shell renders around the active view.
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
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeyboardShortcuts(navigate);

  // ⌘K / Ctrl-K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SnapshotProvider value={poll}>
      <AppShell
        route={route}
        theme={theme}
        onToggleTheme={toggle}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        {viewFor(route)}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
        theme={theme}
        onToggleTheme={toggle}
      />
    </SnapshotProvider>
  );
};
