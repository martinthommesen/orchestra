import { randomUUID } from "node:crypto";
import { Command, CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Duration, Effect, Layer, Ref, Stream } from "effect";
import type { AgentEvent } from "../../core/domain/agent-event";
import type { ServiceConfig } from "../../core/domain/workflow";
import {
  type AgentError,
  AgentNotFound,
  AgentProcessExit,
  ResponseError,
  TurnTimeout,
} from "../../core/errors";
import { AgentRunner, type AgentRunParams } from "../../core/ports/agent-runner";
import { mapCopilotLine } from "./map";

/**
 * Copilot subprocess AgentRunner (Task 9, SPEC §10). Implements the {@link AgentRunner}
 * port with the transport pinned by the Sprint 0 spike (`docs/sprint-0/spike-copilot.md`):
 * spawn `copilot -p … --output-format json` headlessly, stream its stdout JSONL through
 * the pure {@link mapCopilotLine} mapper into normalized {@link AgentEvent}s, and let any
 * failure fail the stream so the orchestrator retries the attempt.
 *
 * ## Guarantees
 * - **Safety Invariant 1 (§9.5):** the child is spawned with both `cwd === workspacePath`
 *   and `-C workspacePath` — it can only touch its own workspace.
 * - **Isolation / teardown:** spawned inside a `Scope` (via `Command.start`), so when the
 *   orchestrator interrupts the worker (stall kill, reconciliation, shutdown) the scope
 *   finalizer SIGTERM's the PID. A `turn_timeout_ms` guard fails the stream if the turn
 *   outlives the deadline.
 * - **Secrets:** the child gets a scrubbed environment: runtime + connectivity basics are
 *   preserved, inherited non-runtime variables are blanked, and only the resolved GitHub
 *   token is intentionally handed over via `GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`.
 *   Non-secret network settings (proxy + custom-CA trust) pass through so the CLI can still
 *   reach GitHub in proxied / private-CA deployments.
 * - **Continuation:** first turn pins a generated `--session-id`; a resumed turn passes
 *   `--resume <sessionId>`. Either way a `SessionStarted` carrying that id is emitted
 *   first so the orchestrator can resume the thread.
 * - **Robustness:** unrecognized/garbage lines never crash the run (`Malformed`); the
 *   terminal `result` (or process exit) is the success/failure signal — exit 0 with a
 *   `result` ⇒ `TurnCompleted`, otherwise `AgentProcessExit`.
 */
const CHILD_ENV_PASSTHROUGH = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Non-secret connectivity settings: blanking these breaks the CLI's GitHub access in
  // proxied / private-CA deployments. Both casings — *nix tooling reads either.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * The GitHub-credential env keys the Copilot CLI reads for *its own* auth. Never inherited from
 * the daemon's environment: either injected from `copilot.github_token` (headless servers) or
 * left **unset** so the CLI uses its ambient `/login`. The executor merges
 * `{ ...process.env, ...command.env }`, so the daemon's own `GITHUB_TOKEN` (the operator's
 * tracker credential) would otherwise leak into the child — F1. Setting these to `undefined`
 * (vs `""`) is what *removes* the inherited value: Node's spawn skips undefined-valued keys,
 * yielding a truly unset var, whereas `""` would present an empty, invalid token.
 */
const AGENT_TOKEN_KEYS = ["GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN"] as const;

const childEnv = (
  base: NodeJS.ProcessEnv,
  agentToken: string | undefined,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) {
      continue;
    }
    env[key] = CHILD_ENV_PASSTHROUGH.has(key) ? value : "";
  }
  env.COPILOT_AUTO_UPDATE = "false";
  // Inject the agent credential, or unset the keys entirely (overriding any blank from the loop
  // above and any inherited parent value). Sourced ONLY from `copilot.github_token` — never
  // `tracker.api_key`, whose conflation was F1.
  const token = agentToken !== undefined && agentToken !== "" ? agentToken : undefined;
  for (const key of AGENT_TOKEN_KEYS) {
    env[key] = token;
  }
  return env;
};

const makeCopilotRunner = (
  config: ServiceConfig,
): Effect.Effect<typeof AgentRunner.Service, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const agentToken = config.copilot.github_token;
    const turnTimeoutMs = config.copilot.turn_timeout_ms;

    const run = (params: AgentRunParams): Stream.Stream<AgentEvent, AgentError> => {
      const sessionId = params.resume?.sessionId ?? randomUUID();
      const turnId = String(params.attempt ?? 0);

      const command = Command.make(
        config.copilot.command,
        "-p",
        params.prompt,
        "--output-format",
        "json",
        "-C",
        params.workspacePath,
        "--allow-all-tools",
        "--no-color",
        "--log-level",
        "none",
        ...(params.resume ? ["--resume", params.resume.sessionId] : ["--session-id", sessionId]),
        ...(config.copilot.model ? ["--model", config.copilot.model] : []),
      ).pipe(
        // Safety Invariant 1: the OS-level cwd is the workspace, not just `-C`.
        Command.workingDirectory(params.workspacePath),
        Command.env(childEnv(process.env, agentToken)),
        Command.stdout("pipe"),
        Command.stderr("inherit"),
      );

      const stream = Stream.unwrapScoped(
        Effect.gen(function* () {
          const proc = yield* Command.start(command).pipe(
            Effect.mapError(
              (cause) => new AgentNotFound({ command: config.copilot.command, cause }),
            ),
          );
          const sawCompleted = yield* Ref.make(false);

          const started: AgentEvent = {
            _tag: "SessionStarted",
            timestamp: new Date(),
            agent_pid: String(proc.pid),
            session_id: sessionId,
            thread_id: sessionId,
            turn_id: turnId,
          };

          const body = proc.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapError(
              (cause: PlatformError) =>
                new ResponseError({ message: "agent stdout read failed", cause }) as AgentError,
            ),
            Stream.flatMap((line) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const mapped = mapCopilotLine(line, new Date());
                  if (mapped.terminal?._tag === "completed") {
                    yield* Ref.set(sawCompleted, true);
                  }
                  const events = Stream.fromIterable(mapped.events);
                  return mapped.terminal?._tag === "failed"
                    ? Stream.concat(events, Stream.fail(mapped.terminal.error))
                    : events;
                }),
              ),
            ),
          );

          // After stdout drains: a clean turn must have seen a successful `result`;
          // otherwise (non-zero / missing result) the process exit is the failure.
          const finalize = Stream.unwrap(
            Effect.gen(function* () {
              const exit = yield* proc.exitCode.pipe(
                Effect.mapError(
                  (cause: PlatformError) =>
                    new ResponseError({
                      message: "agent exit-code read failed",
                      cause,
                    }) as AgentError,
                ),
              );
              const completed = yield* Ref.get(sawCompleted);
              return completed
                ? Stream.empty
                : Stream.fail(new AgentProcessExit({ code: Number(exit), signal: null }));
            }),
          );

          return Stream.make(started).pipe(Stream.concat(body), Stream.concat(finalize));
        }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor)),
      );

      return turnTimeoutMs > 0
        ? stream.pipe(
            Stream.interruptWhen(
              Effect.sleep(Duration.millis(turnTimeoutMs)).pipe(
                Effect.zipRight(Effect.fail(new TurnTimeout({ timeout_ms: turnTimeoutMs }))),
              ),
            ),
          )
        : stream;
    };

    return { run };
  });

/** Layer providing the Copilot subprocess {@link AgentRunner} for a resolved config. */
export const layerCopilotRunner = (
  config: ServiceConfig,
): Layer.Layer<AgentRunner, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(AgentRunner, makeCopilotRunner(config));
