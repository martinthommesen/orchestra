import { Context, Effect, Layer, Ref } from "effect";

/**
 * Sprint 6 / #64 — **operator-pause visibility** (DD-3). The operator-pause latch is a
 * runtime-only gate the owner fiber consults before planning NEW dispatch (exactly like
 * the budget gate). The latch itself lives on the loop fiber; this tiny service mirrors
 * it so the cockpit's read snapshot can project a display-only `control` block on every
 * poll — without the snapshot fiber ever reaching into the loop.
 *
 * It follows the established observability pattern (cf.
 * {@link file://./restore-status.ts RestoreStatus} / {@link file://./live-activity.ts
 * LiveActivity}): written ONLY by the owner fiber (when it applies a Pause/Resume
 * command) and read by the snapshot server. It holds no scheduling state and can never
 * influence dispatch — the authoritative latch is the loop-local one.
 *
 * Runtime-only: it is never persisted, so a restart resumes dispatch (operator pause does
 * not survive a reboot, by design). It defaults to `false` (not paused), so a snapshot
 * omits the `control` block entirely until dispatch is actually withheld — strictly
 * additive, exactly like the budget block.
 */
export class ControlStatus extends Context.Tag("orchestra/ControlStatus")<
  ControlStatus,
  {
    /** Mirror the operator-pause latch (owner-fiber write). */
    readonly setOperatorPaused: (paused: boolean) => Effect.Effect<void>;
    /** Read the operator-pause latch (snapshot-server read). */
    readonly get: Effect.Effect<boolean>;
  }
>() {}

/** Build a control-status holder seeded un-paused. */
const makeControlStatus = (): Effect.Effect<Context.Tag.Service<ControlStatus>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(false);
    return {
      setOperatorPaused: (paused) => Ref.set(ref, paused),
      get: Ref.get(ref),
    };
  });

/** Layer providing a {@link ControlStatus} seeded un-paused (no `control` block until set). */
export const ControlStatusLive: Layer.Layer<ControlStatus> = Layer.effect(
  ControlStatus,
  makeControlStatus(),
);
