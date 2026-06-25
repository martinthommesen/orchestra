import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Poller, type PollState } from "../src/cockpit/model/poller";

describe("Poller (non-overlapping, last-good-on-error)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const collect = <T>() => {
    const states: PollState<T>[] = [];
    return { states, onChange: (s: PollState<T>) => states.push({ ...s }) };
  };

  it("starts connecting and flips to live on the first success", async () => {
    const { states, onChange } = collect<number>();
    const poller = new Poller<number>({
      fetch: () => Promise.resolve(42),
      intervalMs: 100,
      onChange,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const last = states.at(-1);
    expect(last?.connection).toBe("live");
    expect(last?.data).toBe(42);
    poller.stop();
  });

  it("never overlaps: the next fetch starts only after the current settles", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const fetch = () => {
      calls += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve(calls);
        }, 50);
      });
    };
    const { onChange } = collect<number>();
    const poller = new Poller<number>({ fetch, intervalMs: 100, onChange });
    poller.start();
    await vi.advanceTimersByTimeAsync(50); // first settles
    await vi.advanceTimersByTimeAsync(100); // schedule + start second
    await vi.advanceTimersByTimeAsync(50); // second settles
    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    poller.stop();
  });

  it("keeps the last good value and flips to stale on a failed poll", async () => {
    let n = 0;
    const fetch = () => {
      n += 1;
      return n === 1 ? Promise.resolve(7) : Promise.reject(new Error("network down"));
    };
    const { states, onChange } = collect<number>();
    const poller = new Poller<number>({ fetch, intervalMs: 100, onChange });
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // first → live, data 7
    await vi.advanceTimersByTimeAsync(100); // second → fails
    const last = states.at(-1);
    expect(last?.connection).toBe("stale");
    expect(last?.data).toBe(7); // last good retained — UI never blanks
    expect(last?.error).toBe("network down");
    poller.stop();
  });

  it("stays connecting (not stale) when the very first poll fails", async () => {
    const poller = new Poller<number>({
      fetch: () => Promise.reject(new Error("boom")),
      intervalMs: 100,
      onChange: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getState().connection).toBe("connecting");
    expect(poller.getState().data).toBeNull();
    poller.stop();
  });

  it("stops cleanly: no further polls after stop()", async () => {
    let calls = 0;
    const poller = new Poller<number>({
      fetch: () => {
        calls += 1;
        return Promise.resolve(1);
      },
      intervalMs: 100,
      onChange: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const after = calls;
    poller.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(after);
  });

  it("ignores an in-flight result that settles after stop() (no onChange, no schedule)", async () => {
    // A fetch is in flight when stop() is called; its late resolution must not emit a state
    // change or schedule another poll (clean teardown — the stopped guard in applySuccess).
    const { states, onChange } = collect<number>();
    const poller = new Poller<number>({
      fetch: () => new Promise<number>((resolve) => setTimeout(() => resolve(99), 50)),
      intervalMs: 100,
      onChange,
    });
    poller.start();
    poller.stop(); // stop while the first fetch is still pending
    await vi.advanceTimersByTimeAsync(50); // let the in-flight fetch resolve
    expect(states).toHaveLength(0); // late result ignored — UI never updated post-stop
    expect(poller.getState().connection).toBe("connecting");
  });

  it("start() is idempotent: a second start() does not launch a second poll loop", async () => {
    let calls = 0;
    const poller = new Poller<number>({
      fetch: () => {
        calls += 1;
        return Promise.resolve(1);
      },
      intervalMs: 100,
      onChange: () => {},
    });
    poller.start();
    poller.start(); // second start must be a no-op (started guard)
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); // exactly one poll loop running
    poller.stop();
  });
});
