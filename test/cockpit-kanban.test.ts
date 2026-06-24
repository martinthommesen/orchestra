import { describe, expect, it } from "vitest";
import type { SnapshotWire } from "../src/cockpit/api/types";
import { type ColumnId, type KanbanColumn, toKanban } from "../src/cockpit/model/kanban";

const NOW = Date.parse("2026-01-01T00:01:00.000Z");

const snap = (over: Partial<SnapshotWire> = {}): SnapshotWire => ({
  poll_interval_ms: 1000,
  max_concurrent_agents: 3,
  counts: { running: 0, retrying: 0, completed: 0, claimed: 0 },
  running: [],
  retrying: [],
  completed: [],
  recent_completed: [],
  recent_events: [],
  totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_seconds: 0 },
  rate_limits: null,
  ...over,
});

const col = (cols: ReadonlyArray<KanbanColumn>, id: ColumnId) => cols.find((c) => c.id === id);

describe("toKanban", () => {
  it("produces the four columns in order", () => {
    const cols = toKanban(snap(), NOW);
    expect(cols.map((c) => c.id)).toEqual(["claimed", "running", "retrying", "completed"]);
  });

  it("running cards carry a cancel action with elapsed + attempt detail", () => {
    const cols = toKanban(
      snap({
        counts: { running: 1, retrying: 0, completed: 0, claimed: 1 },
        running: [
          {
            issue_id: "i1",
            issue_identifier: "ORC-1",
            attempt: 2,
            workspace_path: "/ws",
            started_at: "2026-01-01T00:00:40.000Z",
            status: "StreamingTurn",
          },
        ],
      }),
      NOW,
    );
    const running = col(cols, "running");
    expect(running?.cards).toHaveLength(1);
    const card = running?.cards[0];
    expect(card?.identifier).toBe("ORC-1");
    expect(card?.action).toBe("cancel");
    expect(card?.badge.label).toBe("running");
    expect(card?.detail).toBe("#2 · 20s");
    // The instance key binds action state to this SESSION (issueId:started_at).
    expect(card?.instanceKey).toBe("i1:2026-01-01T00:00:40.000Z");
  });

  it("retrying cards carry a retry action with attempt, due time and reason", () => {
    const cols = toKanban(
      snap({
        counts: { running: 0, retrying: 1, completed: 0, claimed: 1 },
        retrying: [
          {
            issue_id: "i2",
            identifier: "ORC-2",
            attempt: 3,
            due_at_ms: 999,
            scheduled_at: "2026-01-01T00:00:00.000Z",
            delay_ms: 65000,
            error: "timed out",
          },
        ],
      }),
      NOW,
    );
    const retrying = col(cols, "retrying");
    const card = retrying?.cards[0];
    expect(card?.action).toBe("retry");
    expect(card?.badge.label).toBe("retrying");
    expect(card?.detail).toBe("#3 · due 00:01:05Z · timed out");
    // Retrying binds the instance key to the attempt number (issueId:attempt).
    expect(card?.instanceKey).toBe("i2:3");
  });

  it("completed cards from recent_completed are newest-first with no action", () => {
    const cols = toKanban(
      snap({
        counts: { running: 0, retrying: 0, completed: 2, claimed: 0 },
        recent_completed: [
          {
            issue_id: "a",
            identifier: "ORC-A",
            finished_at: "2026-01-01T00:00:50.000Z",
            outcome: "completed",
          },
          {
            issue_id: "b",
            identifier: "ORC-B",
            finished_at: "2026-01-01T00:00:58.000Z",
            outcome: "killed",
          },
        ],
      }),
      NOW,
    );
    const completed = col(cols, "completed");
    expect(completed?.count).toBe(2);
    expect(completed?.cards.map((c) => c.identifier)).toEqual(["ORC-B", "ORC-A"]);
    expect(completed?.cards[0]?.badge.label).toBe("failed"); // killed → failed
    expect(completed?.cards[0]?.action).toBeNull();
  });

  it("falls back to IDs-only completed when no rich block is sent", () => {
    const cols = toKanban(
      snap({
        counts: { running: 0, retrying: 0, completed: 2, claimed: 0 },
        completed: ["x", "y"],
      }),
      NOW,
    );
    const completed = col(cols, "completed");
    expect(completed?.cards.map((c) => c.identifier)).toEqual(["y", "x"]);
    expect(completed?.cards[0]?.detail).toBe("completed");
  });

  it("claimed column is count-only (pending = claimed - running - retrying, clamped ≥ 0)", () => {
    const cols = toKanban(
      snap({
        counts: { running: 1, retrying: 1, completed: 0, claimed: 4 },
        running: [
          {
            issue_id: "i1",
            issue_identifier: "ORC-1",
            attempt: 1,
            workspace_path: "/ws",
            started_at: NOW.toString(),
            status: "PreparingWorkspace",
          },
        ],
        retrying: [{ issue_id: "i2", identifier: "ORC-2", attempt: 1, due_at_ms: 1, error: null }],
      }),
      NOW,
    );
    const claimed = col(cols, "claimed");
    expect(claimed?.countOnly).toBe(true);
    expect(claimed?.cards).toHaveLength(0);
    expect(claimed?.count).toBe(2); // 4 - 1 - 1
  });

  it("clamps pending-claimed at zero against transient count drift", () => {
    const cols = toKanban(
      snap({ counts: { running: 2, retrying: 1, completed: 0, claimed: 1 } }),
      NOW,
    );
    expect(col(cols, "claimed")?.count).toBe(0);
  });

  it("gives the same issue a NEW instance key when it re-appears as a fresh session", () => {
    const runningAt = (startedAt: string): SnapshotWire =>
      snap({
        counts: { running: 1, retrying: 0, completed: 0, claimed: 1 },
        running: [
          {
            issue_id: "i1",
            issue_identifier: "ORC-1",
            attempt: 1,
            workspace_path: "/ws",
            started_at: startedAt,
            status: "StreamingTurn",
          },
        ],
      });

    const first = col(toKanban(runningAt("2026-01-01T00:00:10.000Z"), NOW), "running")?.cards[0];
    // Same issue cancelled then re-dispatched → a new session with a later started_at.
    const second = col(toKanban(runningAt("2026-01-01T00:00:50.000Z"), NOW), "running")?.cards[0];

    expect(first?.issueId).toBe(second?.issueId);
    // The instance key differs, so the board treats the re-dispatched session as a fresh card
    // (its action button is enabled again) rather than inheriting the prior session's state.
    expect(first?.instanceKey).not.toBe(second?.instanceKey);
  });
});
