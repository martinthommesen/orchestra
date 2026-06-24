import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotPoller, type SnapshotState } from "../../src/cli/dashboard/poller";
import type { FetchSnapshot, Snapshot } from "../../src/cli/dashboard/snapshot-client";
import { makeSnapshot } from "./fixtures";

/**
 * #33 — polling-hook logic (tested through the framework-agnostic poller with fake
 * timers + an injected fetcher): requests never overlap, a disconnect after a good
 * snapshot preserves stale data and flips the banner, and stop() aborts the in-flight
 * fetch + clears the timer.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const BASE = "http://127.0.0.1:4317";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SnapshotPoller", () => {
  it("never overlaps requests — schedules the next poll only after the current settles", async () => {
    const pending = deferred<Snapshot>();
    const fetchSnapshot: FetchSnapshot = vi.fn(() => pending.promise);
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl: BASE,
      intervalMs: 1000,
      onChange: () => {},
    });

    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    // While the first request hangs, no interval can stack a second fetch.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    // Settle it, then one interval later the next poll fires.
    pending.resolve(makeSnapshot());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("keeps the last good snapshot and flips connecting → live → stale", async () => {
    let call = 0;
    const snap = makeSnapshot();
    const fetchSnapshot: FetchSnapshot = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return snap;
      }
      throw new Error("connect ECONNREFUSED 127.0.0.1:4317");
    });
    const states: SnapshotState[] = [];
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl: BASE,
      intervalMs: 1000,
      onChange: (s) => states.push(s),
      now: () => 1000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const live = poller.getState();
    expect(live.connection).toBe("live");
    expect(live.snapshot).toBe(snap);
    expect(live.error).toBeNull();
    expect(live.lastUpdatedAtMs).toBe(1000);

    // Next poll fails — the good snapshot is retained and the banner goes stale.
    await vi.advanceTimersByTimeAsync(1000);
    const stale = poller.getState();
    expect(stale.connection).toBe("stale");
    expect(stale.snapshot).toBe(snap);
    expect(stale.error).toContain("ECONNREFUSED");

    poller.stop();
  });

  it("stays connecting (never blanks) until the first successful poll", async () => {
    const fetchSnapshot: FetchSnapshot = vi.fn(async () => {
      throw new Error("down");
    });
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl: BASE,
      intervalMs: 1000,
      onChange: () => {},
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const state = poller.getState();
    expect(state.connection).toBe("connecting");
    expect(state.snapshot).toBeNull();
    expect(state.error).toBe("down");

    poller.stop();
  });

  it("stop() aborts the in-flight fetch and clears the pending timer", async () => {
    let captured: AbortSignal | undefined;
    const fetchSnapshot: FetchSnapshot = vi.fn((_baseUrl, signal) => {
      captured = signal;
      return new Promise<Snapshot>(() => {
        /* never settles */
      });
    });
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl: BASE,
      intervalMs: 1000,
      onChange: () => {},
    });

    poller.start();
    expect(captured?.aborted).toBe(false);

    poller.stop();
    expect(captured?.aborted).toBe(true);

    // No further polls after stop.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent", () => {
    const fetchSnapshot: FetchSnapshot = vi.fn(
      () =>
        new Promise<Snapshot>(() => {
          /* hang */
        }),
    );
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl: BASE,
      intervalMs: 1000,
      onChange: () => {},
    });
    poller.start();
    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});
