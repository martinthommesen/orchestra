import { Context, Effect, Layer } from "effect";
import type { ReconcileAction } from "./reconcile";

/**
 * Orchestrator observability seam (SPEC §13, Task 12). The loop emits a typed
 * {@link Observation} at every meaningful state transition; the {@link Observer}
 * service decides what to do with it. The Live layer renders structured `key=value`
 * logs (with Milo's status glyphs); tests provide a queue-backed observer to step the
 * loop deterministically. Keeping this behind a Tag means the loop never hard-codes a
 * logging dependency and the JSON-snapshot API can subscribe to the same stream.
 *
 * The retry "kind" distinguishes a fixed continuation turn from an exponential-backoff
 * failure retry (SPEC §8.4).
 */
export type RetryKind = "continuation" | "failure";

export type Observation =
  | { readonly _tag: "Started"; readonly pollIntervalMs: number; readonly maxConcurrent: number }
  | {
      /**
       * Boot-time restore summary (Sprint 4 / #41). Emitted once, after the checkpoint is
       * restored and the registry rebuilt, so the otherwise-empty observability feed and the
       * logs honestly show the daemon resumed from a checkpoint (counts only — no secrets).
       */
      readonly _tag: "RestoredAfterRestart";
      /** Orphaned `running` issues converted to due-immediately continuation retries. */
      readonly orphanedRunningConverted: number;
      /** Pending retries re-armed from their wall-clock due time. */
      readonly reArmedRetries: number;
      /** Completed issue IDs restored (bookkeeping). */
      readonly restoredCompleted: number;
    }
  | { readonly _tag: "StartupCleanup"; readonly removed: ReadonlyArray<string> }
  | { readonly _tag: "TickStart" }
  | {
      readonly _tag: "TickEnd";
      readonly dispatched: ReadonlyArray<string>;
      readonly dispatchSkipped: boolean;
    }
  | {
      readonly _tag: "Reconciled";
      readonly actions: ReadonlyArray<ReconcileAction>;
    }
  | {
      readonly _tag: "Dispatched";
      readonly issueId: string;
      readonly identifier: string;
      readonly attempt: number | null;
      readonly turn: number;
      readonly resumed: boolean;
    }
  | {
      readonly _tag: "AgentEvent";
      readonly issueId: string;
      readonly identifier: string;
      readonly sessionId: string | null;
      readonly eventTag: string;
    }
  | { readonly _tag: "WorkerCompleted"; readonly issueId: string; readonly identifier: string }
  | {
      readonly _tag: "WorkerFailed";
      readonly issueId: string;
      readonly identifier: string;
      readonly message: string;
    }
  | { readonly _tag: "WorkerKilled"; readonly issueId: string; readonly reason: string }
  | { readonly _tag: "WorkspaceCleaned"; readonly issueId: string; readonly identifier: string }
  | {
      readonly _tag: "RetryScheduled";
      readonly issueId: string;
      readonly identifier: string;
      readonly kind: RetryKind;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly _tag: "RetryFired"; readonly issueId: string; readonly identifier: string }
  | { readonly _tag: "PreflightFailed"; readonly reason: string }
  | { readonly _tag: "TrackerError"; readonly op: string; readonly message: string };

export class Observer extends Context.Tag("orchestra/Observer")<
  Observer,
  {
    readonly emit: (obs: Observation) => Effect.Effect<void>;
  }
>() {}

/** A no-op observer (useful as a default and in micro-tests). */
export const ObserverNoop: Layer.Layer<Observer> = Layer.succeed(Observer, {
  emit: () => Effect.void,
});
