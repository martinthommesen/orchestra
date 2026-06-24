import { createClient } from "./client";

/**
 * Sprint 6 / #69 — the single cockpit API client instance shared by every view. `createClient`
 * reads the bearer token once from the injected `window.__ORCHESTRA_COCKPIT_TOKEN__` (set by the
 * daemon's static handler, or the Vite dev plugin), so all reads/mutations go through one
 * configured client. Pure model code never imports this — only the React views do.
 */
export const client = createClient();

/** Cockpit UI poll cadence (ms). Independent of the daemon's orchestration loop interval. */
export const COCKPIT_POLL_MS = 2000;
