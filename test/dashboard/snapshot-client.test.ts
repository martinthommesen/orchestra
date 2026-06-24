import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeFetchSnapshot,
  parseSnapshot,
  type Snapshot,
  SnapshotHttpError,
  SnapshotParseError,
} from "../../src/cli/dashboard/snapshot-client";

/**
 * #31 — defensive parsing of the loopback `GET /api/v1/state` body. The dashboard never
 * trusts the wire bytes: a malformed body becomes a typed error the poller can surface,
 * not a render crash.
 */

/** A well-formed wire body mirroring `toSnapshot` (Dates already ISO strings). */
const wire = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  poll_interval_ms: 1000,
  max_concurrent_agents: 4,
  counts: { running: 1, retrying: 1, completed: 2, claimed: 1 },
  running: [
    {
      issue_id: "42",
      issue_identifier: "#42",
      attempt: null,
      workspace_path: "/tmp/ws/42",
      started_at: "2024-01-01T00:00:00.000Z",
      status: "StreamingTurn",
    },
  ],
  retrying: [{ issue_id: "7", identifier: "#7", attempt: 2, due_at_ms: 123456, error: "boom" }],
  completed: ["1", "2"],
  totals: { input_tokens: 10, output_tokens: 5, total_tokens: 15, runtime_seconds: 1.5 },
  rate_limits: null,
  ...overrides,
});

describe("parseSnapshot", () => {
  it("parses a well-formed body into a typed Snapshot", () => {
    const snap = parseSnapshot(wire());
    expect(snap.poll_interval_ms).toBe(1000);
    expect(snap.max_concurrent_agents).toBe(4);
    expect(snap.counts.running).toBe(1);
    expect(snap.running[0]?.issue_identifier).toBe("#42");
    expect(snap.running[0]?.attempt).toBeNull();
    expect(snap.running[0]?.started_at).toBe("2024-01-01T00:00:00.000Z");
    expect(snap.retrying[0]?.due_at_ms).toBe(123456);
    expect(snap.completed).toEqual(["1", "2"]);
    expect(snap.totals.total_tokens).toBe(15);
    expect(snap.rate_limits).toBeNull();
  });

  it("attaches running.error only when present (exactOptionalPropertyTypes)", () => {
    const without = parseSnapshot(wire());
    expect("error" in (without.running[0] ?? {})).toBe(false);

    const withErr = parseSnapshot(
      wire({
        running: [
          {
            issue_id: "42",
            issue_identifier: "#42",
            attempt: 1,
            workspace_path: "/tmp/ws/42",
            started_at: "2024-01-01T00:00:00.000Z",
            status: "Failed",
            error: "kaboom",
          },
        ],
      }),
    );
    expect(withErr.running[0]?.error).toBe("kaboom");
  });

  it("keeps an unknown-shaped rate_limits as an opaque passthrough", () => {
    const snap = parseSnapshot(wire({ rate_limits: { remaining: 17, weird: [1, 2, 3] } }));
    expect(snap.rate_limits).toEqual({ remaining: 17, weird: [1, 2, 3] });
  });

  it("treats a missing rate_limits as null", () => {
    const body = wire();
    delete (body as { rate_limits?: unknown }).rate_limits;
    expect(parseSnapshot(body).rate_limits).toBeNull();
  });

  it("rejects non-object bodies", () => {
    for (const bad of [null, 42, "nope", [1, 2, 3]]) {
      expect(() => parseSnapshot(bad)).toThrow(SnapshotParseError);
    }
  });

  it("rejects missing or mistyped fields", () => {
    expect(() => parseSnapshot(wire({ poll_interval_ms: "1000" }))).toThrow(SnapshotParseError);
    expect(() => parseSnapshot(wire({ counts: { running: 1 } }))).toThrow(SnapshotParseError);
    expect(() => parseSnapshot(wire({ running: [{ issue_id: "x" }] }))).toThrow(SnapshotParseError);
    expect(() => parseSnapshot(wire({ completed: ["ok", 7] }))).toThrow(SnapshotParseError);
    expect(() => parseSnapshot(wire({ totals: { input_tokens: 1 } }))).toThrow(SnapshotParseError);
  });

  it("treats an absent budget block as undefined (older daemon / no ceiling)", () => {
    expect(parseSnapshot(wire()).budget).toBeUndefined();
  });

  it("parses the additive budget block when present (#53)", () => {
    const snap = parseSnapshot(
      wire({
        budget: { limit_tokens: 1000, spent_tokens: 1200, remaining_tokens: 0, paused: true },
      }),
    );
    expect(snap.budget).toEqual({
      limit_tokens: 1000,
      spent_tokens: 1200,
      remaining_tokens: 0,
      paused: true,
    });
  });

  it("rejects a malformed budget block", () => {
    expect(() => parseSnapshot(wire({ budget: { limit_tokens: 1000 } }))).toThrow(
      SnapshotParseError,
    );
    expect(() =>
      parseSnapshot(
        wire({
          budget: { limit_tokens: 1000, spent_tokens: 1, remaining_tokens: 1, paused: "yes" },
        }),
      ),
    ).toThrow(SnapshotParseError);
  });
});

describe("makeFetchSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/v1/state and returns the parsed snapshot", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(wire()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snap = await makeFetchSnapshot(2000)(
      "http://127.0.0.1:4317",
      new AbortController().signal,
    );
    expect(snap.counts.completed).toBe(2);

    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe("http://127.0.0.1:4317/api/v1/state");
  });

  it("throws SnapshotHttpError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(
      makeFetchSnapshot(2000)("http://127.0.0.1:4317", new AbortController().signal),
    ).rejects.toBeInstanceOf(SnapshotHttpError);
  });

  it("cancels the unconsumed body before throwing on non-2xx (Fix 3)", async () => {
    const cancel = vi.fn(async () => undefined);
    const fakeRes = { ok: false, status: 503, body: { cancel } } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeRes),
    );
    await expect(
      makeFetchSnapshot(2000)("http://127.0.0.1:4317", new AbortController().signal),
    ).rejects.toBeInstanceOf(SnapshotHttpError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("still throws SnapshotHttpError if cancelling the body rejects (cleanup never throws)", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("stream already locked");
    });
    const fakeRes = { ok: false, status: 500, body: { cancel } } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeRes),
    );
    await expect(
      makeFetchSnapshot(2000)("http://127.0.0.1:4317", new AbortController().signal),
    ).rejects.toBeInstanceOf(SnapshotHttpError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

// Compile-time guard: the exported type is what we expect to render against.
const _typecheck: Snapshot | null = null;
void _typecheck;
