import { runDaemon } from "./daemon";
import { runDashboard } from "./dashboard/run";

/**
 * Orchestra CLI entry point and **thin top-level dispatcher**.
 *
 *   orchestra dashboard [--port N] [--host H] [--interval-ms N] [--ascii]
 *       → the live read-only Ink dashboard (a plain React island; see
 *         {@link file://./dashboard/run.tsx}).
 *   orchestra <WORKFLOW.md> [--port N]
 *       → the orchestrator daemon (an Effect program; see {@link file://./daemon.ts}).
 *
 * The two paths keep entirely separate argument grammars — the daemon's `parseArgs`
 * is never overloaded with subcommand logic (Sprint 2 design-review constraint). The
 * `dashboard` token is peeled off here and the remaining flags are handed to the
 * dashboard's own parser.
 */

const argv = process.argv.slice(2);

if (argv[0] === "dashboard") {
  runDashboard(argv.slice(1)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`orchestra dashboard: ${message}\n`);
    process.exitCode = 1;
  });
} else {
  runDaemon(argv);
}
