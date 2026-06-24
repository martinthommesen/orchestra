import { Context, Effect, Layer, Ref } from "effect";

/**
 * Sprint 5 / #54 — **durability/restore visibility**. When the orchestrator boots on a
 * non-empty checkpoint (#41), `restoreFromCheckpoint` converts orphaned `running` issues
 * into due-immediately continuations, re-arms pending retries from wall-clock, and emits a
 * ONE-SHOT `RestoredAfterRestart` observation. That observation only ever appears
 * transiently in the events feed — a minute after boot an operator has no durable signal
 * that "this daemon is running on restored state".
 *
 * This service holds that boot-time fact as a small immutable record so the snapshot
 * server can project a display-only `restore` block on every poll. It is pure
 * observability, exactly like {@link file://./live-activity.ts LiveActivity} /
 * {@link file://./recent-completions.ts RecentCompletions}: written ONCE by the loop at
 * boot (only on a real restore) and read by the snapshot server. It touches no scheduling
 * state — the restore that #41 performs stays byte-identical.
 *
 * Cold start → the loop never records → the snapshot omits the field entirely, so older
 * dashboards are unaffected (strictly additive, like #53's budget block).
 */

/** The boot-time restore fact, captured once. All counts come straight from #41's summary. */
export interface RestoreSummary {
  /** Wall-clock ISO instant the restore happened (stamped from the injected clock). */
  readonly at: string;
  /** Orphaned `running` issues converted into due-immediately continuations. */
  readonly orphanedRunningConverted: number;
  /** Pending retries re-armed from wall-clock. */
  readonly reArmedRetries: number;
  /** Issues already `completed` in the restored checkpoint. */
  readonly restoredCompleted: number;
}

/**
 * Restore-status service. `record` is set-once (the first boot-time summary wins; later
 * calls are ignored so the captured fact stays immutable); `get` is a safe read that
 * returns `null` until/unless a restore was recorded.
 */
export class RestoreStatus extends Context.Tag("orchestra/RestoreStatus")<
  RestoreStatus,
  {
    readonly record: (summary: RestoreSummary) => Effect.Effect<void>;
    readonly get: Effect.Effect<RestoreSummary | null>;
  }
>() {}

/** Build a restore-status holder seeded empty (cold start → no field). */
export const makeRestoreStatus = (): Effect.Effect<Context.Tag.Service<RestoreStatus>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<RestoreSummary | null>(null);
    return {
      // Set-once: the boot-time capture is immutable; ignore any later write.
      record: (summary) => Ref.update(ref, (prev) => prev ?? summary),
      get: Ref.get(ref),
    };
  });

/** Layer providing an empty {@link RestoreStatus} (no restore recorded yet). */
export const RestoreStatusLive: Layer.Layer<RestoreStatus> = Layer.effect(
  RestoreStatus,
  makeRestoreStatus(),
);
