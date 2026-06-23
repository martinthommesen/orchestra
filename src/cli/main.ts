import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { parseArgs } from "./args";

/**
 * Orchestra CLI / daemon entry point.
 *
 * Sprint 0 scope: prove the Effect wiring end-to-end — parse the WORKFLOW.md path
 * argument, build the (currently minimal) application `Layer` graph, emit a
 * structured "started" line, and exit cleanly. No orchestration yet; Sprint 1
 * grows {@link AppLive} with the IssueTracker / AgentRunner / WorkspaceManager /
 * Clock layers and the poll loop. The shape here is intentionally the one the
 * orchestrator slots into: a single program effect, all dependencies provided as
 * Layers, run by `NodeRuntime.runMain`.
 */

const VERSION = process.env.npm_package_version ?? "0.0.0";

/**
 * The application Layer graph. Empty in Sprint 0 beyond logging; this is the seam
 * where Sprint 1 provides the orchestrator's service implementations.
 */
export const AppLive = Layer.empty;

/** The top-level program: wire dependencies, announce startup, hand off to the loop. */
const program = Effect.gen(function* () {
  const { workflowPath } = yield* parseArgs(process.argv.slice(2));

  yield* Effect.logInfo("orchestra started").pipe(
    Effect.annotateLogs({
      event: "started",
      version: VERSION,
      workflow_path: workflowPath,
      pid: String(process.pid),
    }),
  );

  // Sprint 1 replaces this with the orchestrator poll loop. For now, a clean exit
  // after announcing startup proves the boot path and Layer wiring.
  yield* Effect.logDebug("no orchestration configured yet (Sprint 0 scaffold)");
}).pipe(Effect.provide(AppLive));

/** logfmt logger → stable `key=value` lines per PROJECT_BRIEF §13.1. */
const LoggerLive = Logger.logFmt;

NodeRuntime.runMain(program.pipe(Effect.provide(LoggerLive)), {
  // We install our own logfmt logger; suppress runMain's built-in pretty logger so
  // there is a single, stable structured line per event.
  disablePrettyLogger: true,
});
