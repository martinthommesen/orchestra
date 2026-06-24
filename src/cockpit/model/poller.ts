import { ApiError } from "../api/client";

/**
 * Sprint 6 / #69 — a framework-agnostic, non-overlapping poller for the cockpit. Kept
 * DOM/React-free so its scheduling + connection logic is unit-tested
 * under Node with fake timers and an injected fetcher. `usePolling` is the thin React adapter.
 *
 * Guarantees:
 *   - **No overlap.** The next tick is scheduled only after the current settles — a slow/hung
 *     request never stacks a second concurrent fetch.
 *   - **Never blanks the UI.** A failed poll keeps the last good value and flips the connection
 *     banner to `stale` (or stays `connecting` until the first success).
 *   - **Clean teardown.** `stop()` ignores any in-flight result and clears the timer.
 */

export type ConnectionState = "connecting" | "live" | "stale";

export interface PollState<T> {
  /** Last successfully fetched value, retained across failures (last-good-on-error). */
  readonly data: T | null;
  readonly connection: ConnectionState;
  /** Message from the most recent failed poll, else null. */
  readonly error: string | null;
  /** `now()` of the last good value, for an "updated Ns ago" hint. */
  readonly lastUpdatedAtMs: number | null;
}

export const initialPollState = <T>(): PollState<T> => ({
  data: null,
  connection: "connecting",
  error: null,
  lastUpdatedAtMs: null,
});

export interface PollerDeps<T> {
  readonly fetch: () => Promise<T>;
  readonly intervalMs: number;
  readonly onChange: (state: PollState<T>) => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

const messageOf = (err: unknown): string => {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
};

export class Poller<T> {
  private state: PollState<T> = initialPollState<T>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;

  constructor(private readonly deps: PollerDeps<T>) {}

  getState(): PollState<T> {
    return this.state;
  }

  /** Begin polling immediately. Idempotent. */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.poll();
  }

  /** Stop polling: ignore any in-flight result and clear the pending timer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(patch: Partial<PollState<T>>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const data = await this.deps.fetch();
      if (this.stopped) return;
      this.emit({ data, connection: "live", error: null, lastUpdatedAtMs: this.now() });
    } catch (err) {
      if (this.stopped) return;
      // Keep the last good value — a single failed poll must not blank the UI.
      this.emit({
        connection: this.state.data === null ? "connecting" : "stale",
        error: messageOf(err),
      });
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.deps.intervalMs);
  }
}
