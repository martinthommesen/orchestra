import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentTotals } from "../src/core/domain/orchestrator-state";
import { ServiceConfig } from "../src/core/domain/workflow";
import { toSnapshot } from "../src/core/observability/snapshot-server";
import { evaluateBudget } from "../src/core/orchestrator/budget";
import { initialState, zeroTotals } from "../src/core/orchestrator/state";

/**
 * Sprint 5 / #53 — pure coverage for the budget guardrail: config decode (additive,
 * all-defaults), the {@link evaluateBudget} decision, and the strictly-additive snapshot
 * projection. The loop-level dispatch gating lives in `budget-gate.test.ts`.
 */

const totals = (total: number): AgentTotals =>
  AgentTotals.make({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
    runtime_seconds: 0,
  });

describe("budget config (additive, #53)", () => {
  it("an unchanged config (no budget block) decodes with an inert budget", () => {
    const config = Schema.decodeUnknownSync(ServiceConfig)({});
    expect(config.budget.max_total_tokens).toBeUndefined();
    expect(evaluateBudget(config.budget, zeroTotals()).configured).toBe(false);
  });

  it("a configured ceiling decodes and drives the guard", () => {
    const config = Schema.decodeUnknownSync(ServiceConfig)({
      budget: { max_total_tokens: 500 },
    });
    expect(config.budget.max_total_tokens).toBe(500);
    expect(evaluateBudget(config.budget, totals(499)).paused).toBe(false);
    expect(evaluateBudget(config.budget, totals(500)).paused).toBe(true);
  });
});

describe("evaluateBudget (#53)", () => {
  it("no ceiling → inert: never paused, no limit/remaining", () => {
    const s = evaluateBudget({}, totals(1_000_000));
    expect(s).toEqual({
      configured: false,
      limitTokens: null,
      spentTokens: 1_000_000,
      remainingTokens: null,
      paused: false,
    });
  });

  it("under ceiling → not paused, remaining counts down", () => {
    const s = evaluateBudget({ max_total_tokens: 100 }, totals(40));
    expect(s.paused).toBe(false);
    expect(s.remainingTokens).toBe(60);
  });

  it("exactly at ceiling → paused, remaining clamps to 0", () => {
    const s = evaluateBudget({ max_total_tokens: 100 }, totals(100));
    expect(s.paused).toBe(true);
    expect(s.remainingTokens).toBe(0);
  });

  it("over ceiling → paused, remaining never goes negative", () => {
    const s = evaluateBudget({ max_total_tokens: 100 }, totals(250));
    expect(s.paused).toBe(true);
    expect(s.remainingTokens).toBe(0);
  });
});

describe("budget snapshot projection (#53, strictly additive)", () => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({});
  const state = initialState(config);

  it("omits the budget block entirely when no ceiling is configured", () => {
    const snap = toSnapshot(state, { budget: evaluateBudget({}, state.agent_totals) });
    expect("budget" in snap).toBe(false);
  });

  it("emits a budget block when a ceiling is configured", () => {
    const snap = toSnapshot(
      { ...state, agent_totals: totals(120) },
      { budget: evaluateBudget({ max_total_tokens: 100 }, totals(120)) },
    );
    expect(snap.budget).toEqual({
      limit_tokens: 100,
      spent_tokens: 120,
      remaining_tokens: 0,
      paused: true,
    });
  });
});
