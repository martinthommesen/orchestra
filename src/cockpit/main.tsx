import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/**
 * Sprint 6 / #67 — the cockpit SPA entry. Mounts the React app into the `#root` the daemon
 * (or the Vite dev server) serves. The app shell + views arrive in #68/#69/#70/#71.
 */

const container = document.getElementById("root");
if (container === null) {
  throw new Error("cockpit: #root container missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
