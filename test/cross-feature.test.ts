import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { SnapshotWire } from "../src/cockpit/api/types";
import { toFleetView } from "../src/cockpit/model/fleet";
import { AgentTotals } from "../src/core/domain/orchestrator-state";
import { RunAttempt } from "../src/core/domain/run-attempt";
import { ServiceConfig } from "../src/core/domain/workflow";
import { humanizeAgentEvent } from "../src/core/observability/humanize";
import type { ActivityEntry } from "../src/core/observability/live-activity";
import type { RestoreSummary } from "../src/core/observability/restore-status";
import { toSnapshot } from "../src/core/observability/snapshot";
import { evaluateBudget } from "../src/core/orchestrator/budget";
import { initialState, setRunning } from "../src/core/orchestrator/state";

/**
 * Sprint 5 / #56 — **cross-feature** coverage. The per-feature suites
 * (`budget-pure`, `budget-gate`, `restore-pure`, `restore-reconcile`, `humanize`, and the
 * cockpit model suites) each prove ONE feature in isolation, and each only ever sets a
 * SINGLE additive extra on `toSnapshot` / a single cockpit panel. This file pins the
 * **interactions** they don't: the three Sprint 5 additive blocks (`budget`, `restore`,
 * and a humanized `running[].last_activity.message`) all present **at once** and correctly
 * shaped, and the additive-safety contract that a cold start carries **none** of them. No
 * assertion here duplicates a per-feature suite — every case is a co-occurrence the
 * single-feature tests cannot reach.
 *
 * Sprint 6 / #72: the wire's surviving consumer is the web cockpit, so the decode-side case
 * exercises the cockpit's `toFleetView`.
 */

const config = Schema.decodeUnknownSync(ServiceConfig)({});

const totals = (total: number): AgentTotals =>
  AgentTotals.make({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
    runtime_seconds: 0,
  });

const restoreSummary: RestoreSummary = {
  at: "2026-06-24T10:00:00.000Z",
  orphanedRunningConverted: 1,
  reArmedRetries: 2,
  restoredCompleted: 3,
};

const runningState = () =>
  setRunning(
    initialState(config),
    RunAttempt.make({
      issue_id: "i1",
      issue_identifier: "ORC-1",
      attempt: null,
      workspace_path: "/tmp/ws/i1",
      started_at: new Date("2026-06-24T10:00:00.000Z"),
      status: "StreamingTurn",
    }),
  );

describe("cross-feature: budget + restore + last_activity coexist on one snapshot (#56)", () => {
  it("emits all three additive blocks at once, each correctly shaped and non-interfering", () => {
    // The scenario the issue calls out: a budget-paused daemon that ALSO booted on a
    // restored checkpoint, with a running issue reporting a humanized last activity.
    const activity = new Map<string, ActivityEntry>([
      [
        "i1",
        { event_tag: "TurnCompleted", at: "2026-06-24T10:00:03.000Z", message: "finished turn" },
      ],
    ]);
    const snap = toSnapshot(runningState(), {
      budget: evaluateBudget({ max_total_tokens: 100 }, totals(120)),
      restore: restoreSummary,
      activity,
    });

    // budget (#53) — paused, clamped remaining.
    expect(snap.budget).toEqual({
      limit_tokens: 100,
      spent_tokens: 120,
      remaining_tokens: 0,
      paused: true,
    });
    // restore (#54) — snake_case wire shape, untouched by the budget block.
    expect(snap.restore).toEqual({
      at: "2026-06-24T10:00:00.000Z",
      orphaned_running_converted: 1,
      rearmed_retries: 2,
      restored_completed: 3,
    });
    // last_activity (#55) — humanized message rides on the running row.
    const row = snap.running[0] as { last_activity?: ActivityEntry };
    expect(row.last_activity?.message).toBe("finished turn");
    expect(row.last_activity?.event_tag).toBe("TurnCompleted");

    // The whole thing must JSON round-trip (the wire is the cockpit's only input).
    const encoded = JSON.stringify(snap);
    const json = JSON.parse(encoded);
    expect(json.budget.paused).toBe(true);
    expect(json.restore.at).toBe("2026-06-24T10:00:00.000Z");
    expect(json.running[0].last_activity.message).toBe("finished turn");
  });

  it("cold start (no budget, no restore, no activity) carries NONE of the new blocks", () => {
    // Additive safety: a bare projection (unconfigured budget, never restored, no observed
    // activity) must look byte-identical to a pre-Sprint-5 snapshot — every new additive
    // field absent, asserted together in one place.
    const snap = toSnapshot(runningState(), {
      budget: evaluateBudget({}, runningState().agent_totals),
    });
    expect("budget" in snap).toBe(false);
    expect("restore" in snap).toBe(false);
    expect((snap.running[0] as { last_activity?: unknown }).last_activity).toBeUndefined();
  });
});

describe("cross-feature: the cockpit view-model resolves a fully-loaded snapshot (#56)", () => {
  // NOW is 60s after the running row's started_at and the restore `at`, so relative
  // labels render as a round "1m 00s".
  const NOW = Date.parse("2026-06-24T10:01:00.000Z");

  it("toFleetView populates the budget, restore, and last-activity panels together", () => {
    // A single wire body carrying all three Sprint 5 additions; the message is derived
    // from the real humanizer table so the path is end-to-end (wire → view model).
    const wire: SnapshotWire = {
      poll_interval_ms: 1000,
      max_concurrent_agents: 4,
      counts: { running: 1, retrying: 1, completed: 3, claimed: 0 },
      running: [
        {
          issue_id: "i1",
          issue_identifier: "ORC-1",
          attempt: null,
          workspace_path: "/tmp/ws/i1",
          started_at: "2026-06-24T10:00:00.000Z",
          status: "StreamingTurn",
          last_activity: {
            event_tag: "TurnCompleted",
            at: "2026-06-24T10:00:00.000Z",
            message: humanizeAgentEvent("TurnCompleted"),
          },
        },
      ],
      retrying: [
        { issue_id: "i2", identifier: "ORC-2", attempt: 2, due_at_ms: 123456, error: "boom" },
      ],
      completed: ["a", "b", "c"],
      recent_events: [],
      recent_completed: [],
      totals: { input_tokens: 80, output_tokens: 40, total_tokens: 120, runtime_seconds: 1.5 },
      rate_limits: null,
      budget: { limit_tokens: 100, spent_tokens: 120, remaining_tokens: 0, paused: true },
      restore: {
        at: "2026-06-24T10:00:00.000Z",
        orphaned_running_converted: 1,
        rearmed_retries: 2,
        restored_completed: 3,
      },
    };

    const vm = toFleetView(wire, NOW);

    // All three panels resolve from the same projection, none clobbering another.
    expect(vm.budget?.paused).toBe(true);
    expect(vm.budget?.stateLabel).toBe("paused");
    expect(vm.restore?.summary).toBe("1 running · 2 retrying · 3 completed · restored 1m 00s ago");
    // The running row prefers the humanized message ("finished turn") over the raw tag.
    expect(vm.running[0]?.lastActivityLabel).toBe(
      `${humanizeAgentEvent("TurnCompleted")} · 1m 00s ago`,
    );
  });
});
