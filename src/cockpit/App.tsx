import { createClient } from "./api/client";

/**
 * Sprint 6 / #67 — the cockpit app root. A minimal scaffold for now: it constructs the typed
 * API client and confirms the SPA boots and can reach the daemon. The design-system shell
 * (nav: Fleet · Kanban · Events · Settings) and the views land in #68–#71.
 */

const client = createClient();

export const App = () => {
  return (
    <main>
      <h1>Orchestra Cockpit</h1>
      <p>The control plane is online. The fleet, kanban, events, and settings views arrive next.</p>
      <button
        type="button"
        onClick={() => {
          // Smoke check: the scaffold can reach the read API. Replaced by the Fleet view (#69).
          void client.getState();
        }}
      >
        Ping state
      </button>
    </main>
  );
};
