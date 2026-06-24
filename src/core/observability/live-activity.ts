import { Context, Effect, Clock as EffectClock, Layer, Ref } from "effect";

/**
 * Sprint 3 / #37 — **per-session live activity**. Records the last agent event seen for
 * each running issue so the snapshot API can surface a `running[].last_activity` line
 * ("what is this worker doing right now?"). Like {@link RecentEvents} this is
 * observability, never scheduling state: it is fed by the
 * {@link file://./observer-tee.ts tee observer} from `AgentEvent` observations and read
 * by the snapshot server — the orchestrator loop never touches it.
 *
 * The map is keyed by `issue_id` and bounded to {@link LIVE_ACTIVITY_CAP} (oldest
 * insertion evicted) so a long-lived daemon cannot grow it without bound; the snapshot
 * only ever displays entries for issues that are *currently running*, so stale entries
 * for finished issues are harmless and simply never rendered.
 */

/** Max distinct issues retained in the activity map. */
export const LIVE_ACTIVITY_CAP = 256;

/** One issue's most-recent agent activity (the `running[].last_activity` shape). */
export interface ActivityEntry {
  /** The normalized agent event tag (e.g. `TurnCompleted`). */
  readonly event_tag: string;
  /** Wall-clock ISO instant the activity was observed. */
  readonly at: string;
  /** Optional one-line summary (absent today — the AgentEvent observation carries none). */
  readonly message?: string;
}

/** What the tee passes in (the `at` timestamp is stamped inside the service). */
export interface ActivityInput {
  readonly event_tag: string;
  readonly message?: string;
}

/** Live-activity service. `set` is non-failing and cheap; `snapshot` is a safe read. */
export class LiveActivity extends Context.Tag("orchestra/LiveActivity")<
  LiveActivity,
  {
    readonly set: (issueId: string, input: ActivityInput) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<ReadonlyMap<string, ActivityEntry>>;
  }
>() {}

const evict = (map: Map<string, ActivityEntry>, cap: number): void => {
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
};

/** Build a live-activity map bounded to `cap` distinct issues. */
export const makeLiveActivity = (
  cap: number = LIVE_ACTIVITY_CAP,
): Effect.Effect<Context.Tag.Service<LiveActivity>> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, ActivityEntry>>(new Map());
    return {
      set: (issueId, input) =>
        Effect.gen(function* () {
          const ms = yield* EffectClock.currentTimeMillis;
          const entry: ActivityEntry = {
            event_tag: input.event_tag,
            at: new Date(ms).toISOString(),
            ...(input.message !== undefined ? { message: input.message } : {}),
          };
          yield* Ref.update(ref, (prev) => {
            const next = new Map(prev);
            // Re-insert to keep most-recently-touched issues last (insertion-order eviction).
            next.delete(issueId);
            next.set(issueId, entry);
            evict(next, cap);
            return next;
          });
        }),
      snapshot: Ref.get(ref),
    };
  });

/** Layer providing an empty {@link LiveActivity} map at the default cap. */
export const LiveActivityLive: Layer.Layer<LiveActivity> = Layer.effect(
  LiveActivity,
  makeLiveActivity(),
);
