/// <reference types="vite/client" />

/**
 * The bearer token the daemon injects into the served `index.html` (DD-5/#65). Same-origin
 * pages read it from this global and attach it to mutating calls; a cross-origin tab cannot,
 * by the same-origin policy — that is the CSRF defense. Absent in dev unless
 * `ORCHESTRA_COCKPIT_TOKEN` is exported (see `vite.config.ts`).
 */
interface Window {
  readonly __ORCHESTRA_COCKPIT_TOKEN__?: string;
}
