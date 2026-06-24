import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";
import { describe, expect } from "vitest";
import { LIVE_ACTIVITY_CAP, makeLiveActivity } from "../src/core/observability/live-activity";

/**
 * Sprint 3 / #37 — per-session live-activity map. Stamps a wall-clock instant, omits an
 * absent message, keeps the most-recently-touched issue, and is bounded (oldest evicted).
 */

describe("LiveActivity", () => {
  it.effect("records the latest activity per issue with a wall-clock ISO instant", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const act = yield* makeLiveActivity();
      yield* act.set("i1", { event_tag: "SessionStarted" });
      yield* TestClock.setTime(5000);
      yield* act.set("i1", { event_tag: "TurnCompleted", message: "done" });
      const map = yield* act.snapshot;
      const entry = map.get("i1");
      expect(entry?.event_tag).toBe("TurnCompleted");
      expect(entry?.at).toBe(new Date(5000).toISOString());
      expect(entry?.message).toBe("done");
    }),
  );

  it.effect("omits message when none is supplied (exactOptionalPropertyTypes)", () =>
    Effect.gen(function* () {
      const act = yield* makeLiveActivity();
      yield* act.set("i1", { event_tag: "AgentMessage" });
      const entry = (yield* act.snapshot).get("i1");
      expect(entry).toBeDefined();
      expect("message" in (entry as object)).toBe(false);
    }),
  );

  it.effect("is bounded: oldest issues are evicted past the cap", () =>
    Effect.gen(function* () {
      const act = yield* makeLiveActivity(3);
      for (let i = 0; i < 5; i += 1) {
        yield* act.set(`i${i}`, { event_tag: "TurnCompleted" });
      }
      const map = yield* act.snapshot;
      expect(map.size).toBe(3);
      expect([...map.keys()]).toEqual(["i2", "i3", "i4"]);
    }),
  );

  it.effect("re-touching an issue keeps it (eviction is by last-touch order)", () =>
    Effect.gen(function* () {
      const act = yield* makeLiveActivity(2);
      yield* act.set("a", { event_tag: "x" });
      yield* act.set("b", { event_tag: "x" });
      yield* act.set("a", { event_tag: "y" }); // re-touch a → b is now oldest
      yield* act.set("c", { event_tag: "x" }); // evicts b
      const keys = [...(yield* act.snapshot).keys()];
      expect(keys).toEqual(["a", "c"]);
      expect(LIVE_ACTIVITY_CAP).toBeGreaterThan(0);
    }),
  );
});
