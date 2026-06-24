import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { layerCopilotRunner } from "../adapters/agent-copilot";
import { layerGitHubTracker } from "../adapters/tracker-github";
import { layerWorkspaceManager } from "../adapters/workspace";
import { ClockLive } from "../core/clock/live";
import { runCockpit } from "../core/cockpit/server";
import type { ServiceConfig } from "../core/domain/workflow";
import { ControlStatusLive } from "../core/observability/control-status";
import { ObservabilityLive } from "../core/observability/observer-tee";
import { RecentCompletionsLive } from "../core/observability/recent-completions";
import { RestoreStatusLive } from "../core/observability/restore-status";
import { CommandBusLive } from "../core/orchestrator/command";
import { runOrchestrator } from "../core/orchestrator/loop";
import { layerDurableOrchestratorStore } from "../core/persistence";
import { loadWorkflow } from "../core/workflow/loader";
import { parseArgs } from "./args";

/**
 * Orchestra daemon (the default subcommand).
 *
 * Boots the control loop: parse the WORKFLOW.md path (+ optional `--port`), load and
 * validate the workflow into a typed {@link ServiceConfig}, build the application
 * `Layer` graph (store + GitHub tracker + Copilot runner + workspace manager + clock +
 * live observer over the Node platform), announce startup, and hand off to the single
 * state-owning orchestrator fiber via {@link runOrchestrator}. Everything stays inside
 * Effect — `NodeRuntime.runMain` installs SIGINT/SIGTERM handlers that interrupt the
 * root fiber, tearing down the orchestrator scope (and with it every worker, retry
 * timer, and the optional snapshot server).
 *
 * The top-level dispatcher in {@link file://./main.ts} routes everything that is *not*
 * the `dashboard` subcommand here, so the daemon's argument grammar (and its tests)
 * stay exactly as they were.
 */

const VERSION = process.env.npm_package_version ?? "0.0.0";

/**
 * Build the application Layer graph from a loaded workflow's {@link ServiceConfig}. The
 * platform-dependent layers (workspace manager, Copilot runner) take their
 * `FileSystem`/`CommandExecutor` from the ambient {@link NodeContext.layer}, provided
 * once at the program root.
 */
export const appLayer = (config: ServiceConfig) =>
  Layer.mergeAll(
    // Durable store (#40): loads the checkpoint, seeds bookkeeping, and persists every
    // mutation via an atomic, debounced, scope-flushed writer. Drop-in for the in-memory
    // `layerOrchestratorStore` — `loop.ts`/`snapshot-server.ts` are unchanged. Its
    // `FileSystem` comes from the ambient `NodeContext.layer` provided at the program root.
    layerDurableOrchestratorStore(config),
    layerGitHubTracker(config),
    layerCopilotRunner(config),
    layerWorkspaceManager(config),
    ClockLive,
    // Tee observer + recent-events ring + live-activity map (one shared instance each,
    // read by the snapshot server). #36/#37.
    ObservabilityLive,
    // Rich completion history (loop-fed; read by the snapshot server). #37.
    RecentCompletionsLive,
    // Boot-time restore fact (loop-written once; read by the snapshot server). #54.
    RestoreStatusLive,
    // Operator-pause latch mirror (loop-written; read by the snapshot server) + the
    // command bus the cockpit's mutating endpoints offer onto. #64.
    ControlStatusLive,
    CommandBusLive,
  );

/** logfmt logger → stable `key=value` lines per PROJECT_BRIEF §13.1. */
const LoggerLive = Logger.logFmt;

/**
 * Run the daemon for the given CLI arguments (everything after `orchestra`, with the
 * `dashboard` subcommand already peeled off by the dispatcher — here that means the
 * full argv, since the daemon path is the default).
 */
export const runDaemon = (argv: ReadonlyArray<string>): void => {
  const program = Effect.gen(function* () {
    const { workflowPath, port } = yield* parseArgs(argv);
    const def = yield* loadWorkflow(workflowPath);

    yield* Effect.logInfo("orchestra started").pipe(
      Effect.annotateLogs({
        event: "started",
        version: VERSION,
        workflow_path: workflowPath,
        pid: String(process.pid),
        ...(port === null ? {} : { snapshot_port: String(port) }),
      }),
    );

    const run = Effect.scoped(
      Effect.gen(function* () {
        if (port !== null) {
          yield* Effect.forkScoped(runCockpit({ port, budgetConfig: def.config.budget }));
        }
        yield* runOrchestrator(def);
      }),
    );

    yield* run.pipe(Effect.provide(appLayer(def.config)));
  }).pipe(Effect.provide(NodeContext.layer));

  NodeRuntime.runMain(program.pipe(Effect.provide(LoggerLive)), {
    // We install our own logfmt logger; suppress runMain's built-in pretty logger so
    // there is a single, stable structured line per event.
    disablePrettyLogger: true,
  });
};
