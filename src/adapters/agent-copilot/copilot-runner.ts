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
 * - **Secrets:** the resolved GitHub token is handed to the child via env
 *   (`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`) and is never logged.
 * - **Continuation:** first turn pins a generated `--session-id`; a resumed turn passes
 *   `--resume <sessionId>`. Either way a `SessionStarted` carrying that id is emitted
 *   first so the orchestrator can resume the thread.
 * - **Robustness:** unrecognized/garbage lines never crash the run (`Malformed`); the
 *   terminal `result` (or process exit) is the success/failure signal — exit 0 with a
 *   `result` ⇒ `TurnCompleted`, otherwise `AgentProcessExit`.
 */
const makeCopilotRunner = (
  config: ServiceConfig,
): Effect.Effect<typeof AgentRunner.Service, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const ghAuth = config.tracker.api_key;
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
        Command.env({
          COPILOT_AUTO_UPDATE: "false",
          ...(ghAuth
            ? { GITHUB_TOKEN: ghAuth, COPILOT_GITHUB_TOKEN: ghAuth, GH_TOKEN: ghAuth }
            : {}),
        }),
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
