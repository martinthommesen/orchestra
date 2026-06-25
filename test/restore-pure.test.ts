import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ServiceConfig } from "../src/core/domain/workflow";
import { makeRestoreStatus, type RestoreSummary } from "../src/core/observability/restore-status";
import { toSnapshot } from "../src/core/observability/snapshot";
import { initialState } from "../src/core/orchestrator/state";

/**
 * Sprint 5 / #54 — pure coverage for the restore/durability visibility: the set-once
 * {@link makeRestoreStatus} holder and the strictly-additive snapshot projection. The
 * real loop-level capture (a seeded restart writes the summary; a cold start writes
 * nothing) is proven against {@link runOrchestrator} in `restore-reconcile.test.ts`.
 */

const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({
  at: "2026-06-24T10:00:00.000Z",
  orphanedRunningConverted: 1,
  reArmedRetries: 2,
  restoredCompleted: 3,
  ...over,
});

const config = Schema.decodeUnknownSync(ServiceConfig)({});
const state = initialState(config);

describe("RestoreStatus holder (#54)", () => {
  it("starts empty (cold start → no captured restore)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rs = yield* makeRestoreStatus();
        expect(yield* rs.get).toBeNull();
      }),
    ));

  it("captures the boot-time summary on record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rs = yield* makeRestoreStatus();
        yield* rs.record(summary());
        expect(yield* rs.get).toEqual(summary());
      }),
    ));

  it("is set-once: the first captured summary wins, later writes are ignored", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rs = yield* makeRestoreStatus();
        yield* rs.record(summary({ orphanedRunningConverted: 1 }));
        yield* rs.record(summary({ orphanedRunningConverted: 99 }));
        expect((yield* rs.get)?.orphanedRunningConverted).toBe(1);
      }),
    ));
});

describe("restore snapshot projection (#54, strictly additive)", () => {
  it("omits the restore block entirely on a cold start (no summary)", () => {
    const snap = toSnapshot(state);
    expect("restore" in snap).toBe(false);
  });

  it("emits the restore block (snake_case wire shape) after a real restore", () => {
    const snap = toSnapshot(state, { restore: summary() });
    expect(snap.restore).toEqual({
      at: "2026-06-24T10:00:00.000Z",
      orphaned_running_converted: 1,
      rearmed_retries: 2,
      restored_completed: 3,
    });
  });

  it("survives JSON round-trip with ISO `at` intact", () => {
    const encoded = JSON.stringify(toSnapshot(state, { restore: summary() }));
    const json = JSON.parse(encoded);
    expect(json.restore.at).toBe("2026-06-24T10:00:00.000Z");
    expect(json.restore.restored_completed).toBe(3);
  });
});
