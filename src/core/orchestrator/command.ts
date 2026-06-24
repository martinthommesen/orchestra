import { Context, Deferred, Effect, Layer, Queue } from "effect";
import type { ServiceConfig } from "../domain/workflow";

/**
 * Sprint 6 / #64 — the **command channel** (DD-2). Operator actions (pause/resume
 * dispatch, retry-an-issue-now, cancel a session, reload settings) are not applied by
 * whatever fiber received the HTTP request — that would reintroduce the cross-fiber
 * shared mutable state the architecture deliberately bans. Instead each action becomes a
 * {@link Command} placed on this bus; the loop forks one tiny pump fiber that drains the
 * bus into the **same single-consumer mailbox** the owner fiber already applies serially
 * (`Tick` / `AgentEvent` / `WorkerDone` / `RetryDue`). The owner fiber applies the command
 * in-order, exactly where it applies every other message, then completes the per-command
 * `Deferred` with a {@link CommandResult}.
 *
 * The HTTP handler only {@link CommandBus.send}s and awaits the `Deferred` (with a
 * timeout it imposes itself). This keeps every state mutation on the one owner fiber and
 * the whole thing deterministic under `TestClock`.
 */

/** An operator command to apply on the owner fiber. */
export type Command =
  /** Withhold NEW dispatch (runtime-only operator latch, DD-3). */
  | { readonly _tag: "PauseDispatch" }
  /** Clear the operator latch; dispatch resumes (subject to the budget gate). */
  | { readonly _tag: "ResumeDispatch" }
  /** Fire a pending retry / re-dispatch an eligible issue immediately. */
  | { readonly _tag: "RetryNow"; readonly issueId: string }
  /** Interrupt ONLY the named worker fiber, release the issue, drop its registry entry. */
  | { readonly _tag: "CancelSession"; readonly issueId: string }
  /**
   * Hot-reload the safe orchestration knobs (Sprint 6 / #66). Carries the already
   * validated, fully-resolved {@link ServiceConfig} parsed from the freshly-written
   * `WORKFLOW.md`; the owner fiber swaps its live config and patches the matching
   * `OrchestratorState` knobs so the next tick plans against them — killing nothing.
   */
  | { readonly _tag: "ReloadConfig"; readonly config: ServiceConfig };

/** The live dispatch-gate state surfaced after a control command. */
export interface ControlState {
  /** True when NEW dispatch is currently withheld (operator OR budget). */
  readonly dispatchPaused: boolean;
  /** Why dispatch is withheld, or null when it is active. */
  readonly pausedBy: "operator" | "budget" | null;
}

/** The serial outcome the owner fiber reports for an applied {@link Command}. */
export type CommandResult =
  /** Pause/Resume: the resulting dispatch-gate state. */
  | { readonly _tag: "Control"; readonly state: ControlState }
  /** RetryNow/CancelSession: whether the action was accepted, with a reason when not. */
  | { readonly _tag: "Ack"; readonly accepted: boolean; readonly reason: string | null }
  /** ReloadConfig: applied (the editable subset is re-read from disk by the HTTP handler). */
  | { readonly _tag: "Reloaded" };

/** An envelope pairing a command with the `Deferred` its result is delivered through. */
export interface EnqueuedCommand {
  readonly command: Command;
  readonly reply: Deferred.Deferred<CommandResult>;
}

/**
 * The command bus service. `send` is for HTTP handlers (offer + await the ack); `take`
 * is for the loop's pump fiber (drain one envelope into the mailbox). The underlying
 * queue is unbounded — commands are rare, operator-driven, and never dropped.
 */
export class CommandBus extends Context.Tag("orchestra/CommandBus")<
  CommandBus,
  {
    /** Offer a command and await the owner fiber's {@link CommandResult}. */
    readonly send: (command: Command) => Effect.Effect<CommandResult>;
    /** Take the next enqueued command (the loop pump → mailbox). */
    readonly take: Effect.Effect<EnqueuedCommand>;
  }
>() {}

/** Build a {@link CommandBus} backed by an unbounded queue + per-command `Deferred`. */
export const makeCommandBus = (): Effect.Effect<Context.Tag.Service<CommandBus>> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<EnqueuedCommand>();
    return {
      send: (command) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<CommandResult>();
          yield* Queue.offer(queue, { command, reply });
          return yield* Deferred.await(reply);
        }),
      take: Queue.take(queue),
    };
  });

/** Layer providing a fresh, empty {@link CommandBus}. */
export const CommandBusLive: Layer.Layer<CommandBus> = Layer.effect(CommandBus, makeCommandBus());
