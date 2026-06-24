import { type HttpApi, HttpApiBuilder, HttpApiError, HttpServerResponse } from "@effect/platform";
import { Duration, Effect, Layer } from "effect";
import { ControlStatus } from "../observability/control-status";
import { LiveActivity } from "../observability/live-activity";
import { LiveBudget } from "../observability/live-budget";
import { RecentCompletions } from "../observability/recent-completions";
import { RecentEvents } from "../observability/recent-events";
import { RestoreStatus } from "../observability/restore-status";
import { toSnapshot } from "../observability/snapshot";
import { evaluateBudget } from "../orchestrator/budget";
import { type Command, CommandBus, type CommandResult } from "../orchestrator/command";
import { OrchestratorStore } from "../orchestrator/state";
import { WorkflowFile } from "../workflow/workflow-file";
import { type AckWire, CockpitApi, type CockpitAuth, type ControlStateWire } from "./api";

/**
 * Sprint 6 / #65 — the cockpit endpoint handlers. The **read** handler returns a raw
 * `HttpServerResponse.json(toSnapshot(...))` so `GET /api/v1/state` stays byte-compatible
 * with the Sprint-5 wire shape (DD-1). The **control** handlers each `send` a {@link Command}
 * onto the {@link CommandBus} and return only AFTER the owner fiber acks it — within a bounded
 * timeout, beyond which they answer 503 (the owner fiber is wedged), per the API contract.
 */

/** How long a mutating endpoint waits for the owner fiber to ack before answering 503. */
export const COMMAND_TIMEOUT = Duration.seconds(5);

/** Map the loop's `Control` result onto the wire shape; defensive default if mis-tagged. */
const toControlWire = (result: CommandResult): ControlStateWire =>
  result._tag === "Control"
    ? { dispatch_paused: result.state.dispatchPaused, paused_by: result.state.pausedBy }
    : { dispatch_paused: false, paused_by: null };

/** Map the loop's `Ack` result onto the wire shape; defensive default if mis-tagged. */
const toAckWire = (result: CommandResult): AckWire =>
  result._tag === "Ack"
    ? { accepted: result.accepted, reason: result.reason }
    : { accepted: false, reason: "unexpected command result" };

/**
 * The read group implementation. The budget block is projected from the **live** ceiling
 * ({@link LiveBudget}, written by the owner fiber on `ReloadConfig`) so a hot settings reload
 * is reflected in the next snapshot — never the stale startup value.
 */
export const readGroupLive = HttpApiBuilder.group(CockpitApi, "read", (handlers) =>
  handlers
    .handle("state", () =>
      Effect.gen(function* () {
        const store = yield* OrchestratorStore;
        const events = yield* RecentEvents;
        const completions = yield* RecentCompletions;
        const activity = yield* LiveActivity;
        const restoreStatus = yield* RestoreStatus;
        const controlStatus = yield* ControlStatus;
        const liveBudget = yield* LiveBudget;
        const state = yield* store.get;
        const recentEvents = yield* events.list;
        const recentCompleted = yield* completions.list;
        const activityMap = yield* activity.snapshot;
        const restore = yield* restoreStatus.get;
        const operatorPaused = yield* controlStatus.get;
        const budgetConfig = yield* liveBudget.get;
        return yield* HttpServerResponse.json(
          toSnapshot(state, {
            recentEvents,
            recentCompleted,
            activity: activityMap,
            budget: evaluateBudget(budgetConfig, state.agent_totals),
            operatorPaused,
            ...(restore === null ? {} : { restore }),
          }),
        ).pipe(Effect.orDie);
      }),
    )
    .handle("settings", () =>
      // The whitelisted editable subset (DD-4) — raw values, secrets excluded by construction.
      Effect.gen(function* () {
        const workflowFile = yield* WorkflowFile;
        return yield* workflowFile.read.pipe(
          Effect.catchAll(() => new HttpApiError.InternalServerError()),
        );
      }),
    ),
);

/** Run one command through the bus, answering 503 if the owner fiber does not ack in time. */
const sendCommand = (
  command: Command,
): Effect.Effect<CommandResult, HttpApiError.ServiceUnavailable, CommandBus> =>
  Effect.gen(function* () {
    const bus = yield* CommandBus;
    return yield* bus.send(command).pipe(
      Effect.timeoutFail({
        duration: COMMAND_TIMEOUT,
        onTimeout: () => new HttpApiError.ServiceUnavailable(),
      }),
    );
  });

/** The control group implementation — every endpoint is gated by the auth middleware. */
export const controlGroupLive = HttpApiBuilder.group(CockpitApi, "control", (handlers) =>
  handlers
    .handle("pause", () => sendCommand({ _tag: "PauseDispatch" }).pipe(Effect.map(toControlWire)))
    .handle("resume", () => sendCommand({ _tag: "ResumeDispatch" }).pipe(Effect.map(toControlWire)))
    .handle("retry", ({ path }) =>
      sendCommand({ _tag: "RetryNow", issueId: path.id }).pipe(Effect.map(toAckWire)),
    )
    .handle("cancel", ({ path }) =>
      sendCommand({ _tag: "CancelSession", issueId: path.id }).pipe(Effect.map(toAckWire)),
    )
    .handle("settings", ({ payload }) =>
      // Stage the patch, then gate the durable commit on the owner accepting the reload
      // (DD-4): `applyPatch` writes a temp, resolves it, sends `ReloadConfig`, and only
      // commits the atomic rename after the owner acks. A validation failure → 400; a wedged
      // owner (reload not acked within the timeout) → 503, with NOTHING persisted or applied.
      Effect.gen(function* () {
        const workflowFile = yield* WorkflowFile;
        const applied = yield* workflowFile
          .applyPatch(payload, (config) =>
            sendCommand({ _tag: "ReloadConfig", config }).pipe(Effect.asVoid),
          )
          .pipe(
            Effect.catchTags({
              SettingsRejected: () => new HttpApiError.BadRequest(),
              MissingWorkflowFile: () => new HttpApiError.BadRequest(),
              WorkflowParseError: () => new HttpApiError.BadRequest(),
              WorkflowFrontMatterNotAMap: () => new HttpApiError.BadRequest(),
            }),
          );
        return applied.settings;
      }),
    ),
);

/** Assemble the full implemented API layer (read + control + auth), minus the auth impl. */
export const cockpitApiLive = (): Layer.Layer<
  HttpApi.Api,
  never,
  | OrchestratorStore
  | RecentEvents
  | RecentCompletions
  | LiveActivity
  | RestoreStatus
  | ControlStatus
  | LiveBudget
  | CommandBus
  | CockpitAuth
  | WorkflowFile
> =>
  HttpApiBuilder.api(CockpitApi).pipe(
    Layer.provide(readGroupLive),
    Layer.provide(controlGroupLive),
  );
