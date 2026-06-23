import { Data, Effect } from "effect";

/**
 * CLI argument parsing, kept separate from {@link file://./main.ts} so it can be
 * unit-tested without triggering the top-level `runMain` side effect.
 */

/** Raised when the CLI is invoked without a WORKFLOW.md path argument. */
export class CliUsageError extends Data.TaggedError("CliUsageError")<{
  readonly message: string;
}> {}

export interface CliArgs {
  readonly workflowPath: string;
  /** When set, expose the loopback JSON snapshot API on this port (SPEC §13.7). */
  readonly port: number | null;
}

/** Parse positional + flag CLI arguments into a typed, validated shape. */
export const parseArgs = (argv: ReadonlyArray<string>): Effect.Effect<CliArgs, CliUsageError> =>
  Effect.gen(function* () {
    const positionals: string[] = [];
    let port: number | null = null;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === undefined) {
        continue;
      }
      if (arg === "--port") {
        const raw = argv[++i];
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          return yield* Effect.fail(
            new CliUsageError({ message: "--port must be an integer in 1..65535" }),
          );
        }
        port = parsed;
      } else if (arg.startsWith("--port=")) {
        const parsed = Number(arg.slice("--port=".length));
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          return yield* Effect.fail(
            new CliUsageError({ message: "--port must be an integer in 1..65535" }),
          );
        }
        port = parsed;
      } else {
        positionals.push(arg);
      }
    }

    const workflowPath = positionals[0];
    if (workflowPath === undefined || workflowPath.length === 0) {
      return yield* Effect.fail(
        new CliUsageError({ message: "usage: orchestra <path-to-WORKFLOW.md> [--port N]" }),
      );
    }
    return { workflowPath, port };
  });
