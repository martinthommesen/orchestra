import { runDashboard } from "./dashboard/run";

/**
 * Standalone dashboard entry: `node dist/cli/dashboard.js [flags]`.
 *
 * The primary UX is the `orchestra dashboard` subcommand (dispatched from
 * {@link file://./main.ts}); this second `tsup` entry runs the very same island
 * directly, which keeps a clean standalone `dist/cli/dashboard.js` for tooling and
 * for running the dashboard without going through the `orchestra` dispatcher.
 */
runDashboard(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`orchestra dashboard: ${message}\n`);
  process.exitCode = 1;
});
