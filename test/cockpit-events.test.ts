import { describe, expect, it } from "vitest";
import type { EventEnvelopeWire, SnapshotWire } from "../src/cockpit/api/types";
import { eventKinds, filterEvents, toEventsView } from "../src/cockpit/model/events";

const NOW = Date.parse("2026-01-01T00:01:00.000Z");

const ev = (over: Partial<EventEnvelopeWire>): EventEnvelopeWire => ({
  seq: 1,
  emitted_at: "2026-01-01T00:00:57.000Z",
  level: "info",
  kind: "dispatched",
  message: "dispatched a worker",
  ...over,
});

const snap = (events: ReadonlyArray<EventEnvelopeWire>): SnapshotWire => ({
  poll_interval_ms: 1000,
  max_concurrent_agents: 1,
  counts: { running: 0, retrying: 0, completed: 0, claimed: 0 },
  running: [],
  retrying: [],
  completed: [],
  recent_completed: [],
  recent_events: events,
  totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_seconds: 0 },
  rate_limits: null,
});

describe("toEventsView", () => {
  it("reverses the append-only wire order to newest-first", () => {
    const rows = toEventsView(
      snap([
        ev({ seq: 1, kind: "dispatched" }),
        ev({ seq: 2, kind: "completed" }),
        ev({ seq: 3, kind: "failed", level: "warn" }),
      ]),
      NOW,
    );
    expect(rows.map((r) => r.seq)).toEqual([3, 2, 1]);
  });

  it("precomputes glyph/relative-time per row", () => {
    const [row] = toEventsView(snap([ev({ seq: 7, kind: "completed" })]), NOW);
    expect(row?.glyph).toBe("✓");
    expect(row?.relativeLabel).toBe("3s ago");
  });

  it("renders relative sentinel for an unparseable emitted_at", () => {
    const [row] = toEventsView(snap([ev({ emitted_at: "nope" })]), NOW);
    expect(row?.relativeLabel).toBe("—");
  });
});

describe("filterEvents", () => {
  const rows = toEventsView(
    snap([
      ev({
        seq: 1,
        kind: "dispatched",
        level: "info",
        message: "started ORC-1",
        identifier: "ORC-1",
      }),
      ev({ seq: 2, kind: "failed", level: "warn", message: "boom", identifier: "ORC-2" }),
      ev({ seq: 3, kind: "completed", level: "info", message: "done ORC-3", identifier: "ORC-3" }),
    ]),
    NOW,
  );

  it("filters by level", () => {
    expect(filterEvents(rows, { level: "warn", kind: "all", query: "" }).map((r) => r.seq)).toEqual(
      [2],
    );
  });

  it("filters by kind", () => {
    expect(
      filterEvents(rows, { level: "all", kind: "completed", query: "" }).map((r) => r.seq),
    ).toEqual([3]);
  });

  it("filters by free-text against message + identifier (case-insensitive)", () => {
    expect(
      filterEvents(rows, { level: "all", kind: "all", query: "orc-2" }).map((r) => r.seq),
    ).toEqual([2]);
    expect(
      filterEvents(rows, { level: "all", kind: "all", query: "boom" }).map((r) => r.seq),
    ).toEqual([2]);
  });

  it("returns all rows for the empty filter", () => {
    expect(filterEvents(rows, { level: "all", kind: "all", query: "  " })).toHaveLength(3);
  });

  it("lists distinct kinds sorted", () => {
    expect(eventKinds(rows)).toEqual(["completed", "dispatched", "failed"]);
  });
});
