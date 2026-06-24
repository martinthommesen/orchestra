import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Sprint 6 / #67 — the cockpit SPA build (DD-8). The app lives in `src/cockpit/`; `vite build`
 * emits to `dist/cockpit/`, exactly where the daemon's static handler serves from (relative to
 * the bundled `dist/cli/main.js`). `pnpm build` runs `tsup && vite build`, so one command
 * produces both the daemon bundle and the SPA.
 *
 * `pnpm dev:cockpit` runs the Vite dev server with HMR and proxies `/api` to a locally running
 * daemon (`orchestra <WORKFLOW.md> --port <ORCHESTRA_PORT|4317>`). In dev the daemon's
 * token-injecting `index.html` is bypassed, so a `tokenDevInject` plugin re-creates the
 * `window.__ORCHESTRA_COCKPIT_TOKEN__` global from `ORCHESTRA_COCKPIT_TOKEN` (when exported)
 * so mutating calls work against the dev daemon.
 */

const TOKEN_GLOBAL = "__ORCHESTRA_COCKPIT_TOKEN__"; // gitleaks:allow — JS global name, not a secret
const devPort = Number(process.env.ORCHESTRA_PORT ?? 4317);

/** Inject the operator token into the dev-served index (parity with the daemon's injection). */
const tokenDevInject = () => ({
  name: "orchestra-token-dev-inject",
  transformIndexHtml(html: string) {
    const injected = process.env.ORCHESTRA_COCKPIT_TOKEN;
    if (injected === undefined || injected === "") {
      return html;
    }
    const escaped = JSON.stringify(injected).replace(/</g, "\\u003c");
    return html.replace("</head>", `<script>window.${TOKEN_GLOBAL}=${escaped};</script></head>`);
  },
});

export default defineConfig({
  root: "src/cockpit",
  // Absolute base ("/") — the daemon serves the SPA from the web root, so emitted asset URLs
  // (/assets/*) resolve against the static handler.
  base: "/",
  plugins: [react(), tokenDevInject()],
  build: {
    outDir: "../../dist/cockpit",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${devPort}`, changeOrigin: false },
    },
  },
});
