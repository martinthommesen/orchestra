import type {
  Snapshot,
  SnapshotRetrying,
  SnapshotRunning,
} from "../../src/cli/dashboard/snapshot-client";

/** Shared snapshot fixtures for the dashboard view-model / poller / render tests. */

export const STARTED_AT = "2024-01-01T00:00:00.000Z";

export const makeRunning = (overrides: Partial<SnapshotRunning> = {}): SnapshotRunning => ({
  issue_id: "i1",
  issue_identifier: "ORC-1",
  attempt: null,
  workspace_path: "/tmp/orchestra/ws/i1",
  started_at: STARTED_AT,
  status: "StreamingTurn",
  ...overrides,
});

export const makeRetrying = (overrides: Partial<SnapshotRetrying> = {}): SnapshotRetrying => ({
  issue_id: "i2",
  identifier: "ORC-2",
  attempt: 2,
  due_at_ms: 99999,
  error: "rate limited",
  ...overrides,
});

export const makeSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  poll_interval_ms: 1000,
  max_concurrent_agents: 4,
  counts: { running: 1, retrying: 1, completed: 3, claimed: 2 },
  running: [makeRunning()],
  retrying: [makeRetrying()],
  completed: ["a", "b", "c"],
  totals: { input_tokens: 100, output_tokens: 40, total_tokens: 140, runtime_seconds: 75 },
  rate_limits: null,
  ...overrides,
});
