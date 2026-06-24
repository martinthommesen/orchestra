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
  | { readonly _tag: "TrackerError"; readonly op: string; readonly message: string }
  | {
      /**
       * Budget guardrail transition (Sprint 5 / #53). Emitted **once per transition**
       * (entering paused, then resuming) — never every tick — when cumulative spend
       * crosses the configured token ceiling. `paused: true` = NEW dispatch is now
       * withheld; `paused: false` = the ceiling was cleared/raised and dispatch resumes.
       * In-flight workers, retries, and reconciliation are unaffected either way.
       */
      readonly _tag: "BudgetExceeded";
      readonly paused: boolean;
      readonly limitTokens: number;
      readonly spentTokens: number;
    }
  | {
      /**
       * Operator-pause transition (Sprint 6 / #64, DD-3). Emitted when an operator
       * `PauseDispatch`/`ResumeDispatch` command flips the runtime latch. `paused: true` =
       * NEW dispatch is now withheld by the operator; `paused: false` = the operator
       * cleared it (dispatch resumes, still subject to the budget gate). In-flight workers,
       * retries, and reconciliation are unaffected either way — exactly like the budget gate.
       */
      readonly _tag: "OperatorControl";
      readonly paused: boolean;
    }
  | {
      /**
       * An operator `CancelSession` interrupted exactly the named worker (Sprint 6 / #64).
       * The issue is released and dropped from the registry; no other worker is touched.
       */
      readonly _tag: "SessionCancelled";
      readonly issueId: string;
      readonly identifier: string;
    }
  | {
      /**
       * An operator `RetryNow` request (Sprint 6 / #64). `accepted: true` when a pending
       * retry was fired early / an eligible issue re-dispatched; `accepted: false` for an
       * unknown or ineligible id (a typed no-op).
       */
      readonly _tag: "RetryNowRequested";
      readonly issueId: string;
      readonly accepted: boolean;
    };

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
