import { runDaemon } from "./daemon";

/**
 * Orchestra CLI entry point.
 *
 *   orchestra <WORKFLOW.md> [--port N]
 *       → the orchestrator daemon (an Effect program; see {@link file://./daemon.ts}).
 *         Pass `--port N` to serve the web cockpit (read views + operator controls)
 *         on loopback; see the README "Web cockpit" section.
 *
 * The read-only Ink TUI dashboard was removed in Sprint 6 — the web cockpit the daemon
 * serves via `--port` supersedes it. There is a single CLI surface: the daemon.
 */

runDaemon(process.argv.slice(2));
