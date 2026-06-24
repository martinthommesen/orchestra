import type { Deferred } from "effect";
import type { AgentEvent } from "../domain/agent-event";
import type { Command, CommandResult } from "./command";

/**
 * The orchestrator mailbox protocol. Workers and timers never touch state directly
 * (SPEC §7 / brainstorm: single state-owning fiber) — they post these messages to a
 * `Queue` that the one owner fiber drains and applies serially. This is what makes the
 * whole loop deterministic under `TestClock`.
 */

/** Terminal outcome a worker fiber reports for its session. */
export type WorkerOutcome =
  /** The agent turn-stream ended cleanly (schedule a continuation if turns remain). */
  | { readonly _tag: "Completed" }
  /** The session failed (schedule an exponential-backoff retry). */
  | { readonly _tag: "Failed"; readonly message: string };

export type Msg =
  /** A poll tick (immediate at startup, then every `poll_interval_ms`). */
  | { readonly _tag: "Tick" }
  /** A normalized agent event streamed from a running worker. */
  | { readonly _tag: "AgentEvent"; readonly issueId: string; readonly event: AgentEvent }
  /** A worker fiber finished (clean or failed). */
  | { readonly _tag: "WorkerDone"; readonly issueId: string; readonly outcome: WorkerOutcome }
  /** A scheduled retry/continuation timer fired for an issue. */
  | { readonly _tag: "RetryDue"; readonly issueId: string }
  /**
   * An operator command pumped off the {@link Command}Bus (Sprint 6 / #64, DD-2). It flows
   * through this same mailbox so the owner fiber applies it serially — in the same place it
   * applies every other message — then completes `reply` with a {@link CommandResult}.
   */
  | {
      readonly _tag: "Command";
      readonly command: Command;
      readonly reply: Deferred.Deferred<CommandResult>;
    };
