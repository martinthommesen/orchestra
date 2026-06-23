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
}

/** Parse positional CLI arguments into a typed, validated shape. */
export const parseArgs = (argv: ReadonlyArray<string>): Effect.Effect<CliArgs, CliUsageError> =>
  Effect.gen(function* () {
    const workflowPath = argv[0];
    if (workflowPath === undefined || workflowPath.length === 0) {
      return yield* Effect.fail(
        new CliUsageError({ message: "usage: orchestra <path-to-WORKFLOW.md>" }),
      );
    }
    return { workflowPath };
  });
