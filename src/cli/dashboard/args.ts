/**
 * Dashboard CLI argument parsing — deliberately SEPARATE from the daemon's
 * {@link file://../args.ts} `parseArgs`, so neither parser becomes a "sometimes a
 * workflow path, sometimes a subcommand" hybrid (a constraint from the Sprint 2 design
 * review). The top-level dispatcher in {@link file://../main.ts} routes
 * `orchestra dashboard …` here; everything else stays on the daemon.
 *
 * Plain (non-Effect) on purpose: the dashboard is a small React/Ink island that does
 * not run inside the Effect runtime, so it parses its own flags synchronously.
 */

/** Validated dashboard options with all defaults applied. */
export interface DashboardOptions {
  readonly host: string;
  readonly port: number;
  readonly intervalMs: number;
  readonly ascii: boolean;
}

export const DASHBOARD_DEFAULTS: DashboardOptions = {
  host: "127.0.0.1",
  port: 4317,
  intervalMs: 1000,
  ascii: false,
};

export const DASHBOARD_USAGE = `usage: orchestra dashboard [options]

Live, read-only fleet view of a running orchestra daemon. Start the daemon with a
snapshot port (orchestra <WORKFLOW.md> --port ${DASHBOARD_DEFAULTS.port}), then run this in a
second terminal.

Options:
  --port <n>         snapshot API port to poll (default ${DASHBOARD_DEFAULTS.port})
  --host <host>      snapshot API host (default ${DASHBOARD_DEFAULTS.host})
  --interval-ms <n>  poll interval in milliseconds (default ${DASHBOARD_DEFAULTS.intervalMs})
  --ascii            use ASCII status glyphs instead of Unicode
  --help             show this help and exit

Press q or Ctrl-C to quit.`;

/** Discriminated parse outcome — never throws; the caller decides how to surface each. */
export type DashboardArgsResult =
  | { readonly kind: "run"; readonly options: DashboardOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

const parsePort = (raw: string | undefined): number | null => {
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : null;
};

const parsePositiveInt = (raw: string | undefined): number | null => {
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/** Split `--flag=value` into `["--flag", "value"]`; leave bare flags untouched. */
const splitInline = (arg: string): readonly [string, string | undefined] => {
  if (!arg.startsWith("--")) {
    return [arg, undefined];
  }
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
};

/** Parse `orchestra dashboard` flags into validated {@link DashboardOptions}. */
export const parseDashboardArgs = (argv: ReadonlyArray<string>): DashboardArgsResult => {
  let { host, port, intervalMs, ascii } = DASHBOARD_DEFAULTS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const [flag, inlineVal] = splitInline(arg);
    // Pull the value from `--flag=value` first, else consume the next positional token.
    const takeValue = (): string | undefined => (inlineVal !== undefined ? inlineVal : argv[++i]);

    switch (flag) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--ascii":
        ascii = true;
        break;
      case "--port": {
        const parsed = parsePort(takeValue());
        if (parsed === null) {
          return { kind: "error", message: "--port must be an integer in 1..65535" };
        }
        port = parsed;
        break;
      }
      case "--host": {
        const value = takeValue();
        if (value === undefined || value.length === 0) {
          return { kind: "error", message: "--host requires a value" };
        }
        host = value;
        break;
      }
      case "--interval-ms": {
        const parsed = parsePositiveInt(takeValue());
        if (parsed === null) {
          return { kind: "error", message: "--interval-ms must be a positive integer" };
        }
        intervalMs = parsed;
        break;
      }
      default:
        return { kind: "error", message: `unknown option: ${arg}` };
    }
  }

  return { kind: "run", options: { host, port, intervalMs, ascii } };
};
