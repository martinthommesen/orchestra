import { render } from "ink";
import { App } from "./app";
import { DASHBOARD_USAGE, parseDashboardArgs } from "./args";

/**
 * `orchestra dashboard` entry point — a plain React/Ink island (no Effect runtime).
 *
 * Parses its own flags (see {@link file://./args.ts}), then either prints help / a
 * usage error, or mounts the Ink {@link App} and waits until it unmounts (`q` / Ctrl-C).
 * Invoked by the top-level dispatcher in {@link file://../main.ts} and by the standalone
 * {@link file://../dashboard.tsx} entry.
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

  const instance = render(<App baseUrl={baseUrl} options={options} />);
  await instance.waitUntilExit();
};
