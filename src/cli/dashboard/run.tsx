import { render } from "ink";
import { shouldUseColor } from "../../core/observability/glyphs";
import { App } from "./app";
import { DASHBOARD_USAGE, parseDashboardArgs } from "./args";
import { makeFetchSnapshot } from "./snapshot-client";

/**
 * `orchestra dashboard` entry point — a plain React/Ink island (no Effect runtime).
 *
 * Parses its own flags (see {@link file://./args.ts}), then either prints help / a
 * usage error, or mounts the Ink {@link App} and waits until it unmounts (`q` / Ctrl-C).
 * Invoked by the top-level dispatcher in {@link file://../main.ts} and by the standalone
 * {@link file://../dashboard.tsx} entry.
 *
 * The per-request fetch timeout is the larger of the poll interval and 2s, so a slow
 * daemon never stalls a poll past the budget but a generous interval still gets room.
 */
export const runDashboard = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseDashboardArgs(argv);

  if (parsed.kind === "help") {
    process.stdout.write(`${DASHBOARD_USAGE}\n`);
    return;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`orchestra dashboard: ${parsed.message}\n\n${DASHBOARD_USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const { options } = parsed;
  const baseUrl = `http://${options.host}:${options.port}`;
  const color = shouldUseColor({ env: process.env, isTTY: Boolean(process.stdout.isTTY) });
  const fetchSnapshot = makeFetchSnapshot(Math.max(options.intervalMs, 2000));

  const instance = render(
    <App baseUrl={baseUrl} options={options} fetchSnapshot={fetchSnapshot} color={color} />,
  );
  await instance.waitUntilExit();
};
