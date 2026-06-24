import { errorMessage } from "../../core/util/error";
import type { FetchSnapshot, Snapshot } from "./snapshot-client";

/**
 * Non-overlapping snapshot poller (#31), deliberately framework-agnostic so its
 * scheduling/connection logic can be unit-tested with fake timers and an injected
 * fetcher — no React, no Ink. The {@link file://./use-snapshot.ts} hook is a thin
 * adapter that wires this to component state.
 *
 * Guarantees:
 *   - **No overlap.** The next poll is scheduled only *after* the current one settles,
 *     so a slow/hung request can never stack a second concurrent fetch.
 *   - **Never blanks the UI.** A failed poll keeps the last good snapshot and flips the
 *     connection banner to `stale` (or stays `connecting` until the first success).
 *   - **Clean teardown.** `stop()` aborts the in-flight fetch and clears the timer.
 */

export type ConnectionState = "connecting" | "live" | "stale";

export interface SnapshotState {
  /** Last successfully fetched snapshot, retained across failures. */
  readonly snapshot: Snapshot | null;
  readonly connection: ConnectionState;
  /** Message from the most recent failed poll, else `null`. */
  readonly error: string | null;
  /** `Date.now()` (wall-clock) of the last good snapshot, for an "updated Ns ago" hint. */
  readonly lastUpdatedAtMs: number | null;
}

export const INITIAL_SNAPSHOT_STATE: SnapshotState = {
  snapshot: null,
  connection: "connecting",
  error: null,
  lastUpdatedAtMs: null,
};

export interface SnapshotPollerDeps {
  readonly fetchSnapshot: FetchSnapshot;
  readonly baseUrl: string;
  readonly intervalMs: number;
  readonly onChange: (state: SnapshotState) => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class SnapshotPoller {
  private state: SnapshotState = INITIAL_SNAPSHOT_STATE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private started = false;

  constructor(private readonly deps: SnapshotPollerDeps) {}

  getState(): SnapshotState {
    return this.state;
  }

  /** Begin polling immediately. Idempotent — repeated calls are no-ops. */
  start(): void {
    if (this.stopped || this.started) {
      return;
    }
    this.started = true;
    void this.poll();
  }

  /** Stop polling: abort any in-flight fetch and clear the pending timer. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller !== null) {
      this.controller.abort();
      this.controller = null;
    }
  }

  private emit(patch: Partial<SnapshotState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      const snapshot = await this.deps.fetchSnapshot(this.deps.baseUrl, controller.signal);
      if (this.stopped) {
        return;
      }
      this.emit({
        snapshot,
        connection: "live",
        error: null,
        lastUpdatedAtMs: this.now(),
      });
    } catch (err) {
      if (this.stopped) {
        return;
      }
      // Keep the last good snapshot — a single failed poll must not blank the UI.
      this.emit({
        connection: this.state.snapshot === null ? "connecting" : "stale",
        error: errorMessage(err),
      });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.deps.intervalMs);
  }
}
