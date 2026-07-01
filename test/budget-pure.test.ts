import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentTotals } from "../src/core/domain/orchestrator-state";
import { PositiveNumber, ServiceConfig } from "../src/core/domain/workflow";
import { toSnapshot } from "../src/core/observability/snapshot";
import { evaluateBudget } from "../src/core/orchestrator/budget";
import { initialState, zeroTotals } from "../src/core/orchestrator/state";

/**
 * Sprint 5 / #53, Sprint 6 / #77 — pure coverage for the budget guardrail: config decode
 * (additive, all-defaults), the {@link evaluateBudget} decision (token ceiling, USD ceiling,
 * and both), and the strictly-additive snapshot projection. The loop-level dispatch gating
 * lives in `budget-gate.test.ts`.
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
      limitUsd: null,
      spentUsd: null,
      remainingUsd: null,
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

// ── USD ceiling (#77) ─────────────────────────────────────────────────────────

describe("BudgetConfig filter — money-path guard (#77)", () => {
  it("PositiveNumber rejects zero and negative values, accepts positive decimals", () => {
    expect(() => Schema.decodeUnknownSync(PositiveNumber)(0)).toThrow();
    expect(() => Schema.decodeUnknownSync(PositiveNumber)(-1)).toThrow();
    expect(Schema.decodeUnknownSync(PositiveNumber)(0.5)).toBe(0.5);
    expect(Schema.decodeUnknownSync(PositiveNumber)(5)).toBe(5);
  });

  it("rejects max_cost_usd without usd_per_million_tokens", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceConfig)({ budget: { max_cost_usd: 10 } }),
    ).toThrow();
  });

  it("accepts max_cost_usd with usd_per_million_tokens", () => {
    const config = Schema.decodeUnknownSync(ServiceConfig)({
      budget: { max_cost_usd: 10, usd_per_million_tokens: 5 },
    });
    expect(config.budget.max_cost_usd).toBe(10);
    expect(config.budget.usd_per_million_tokens).toBe(5);
  });

  it("rejects negative usd_per_million_tokens (PositiveNumber guard)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceConfig)({
        budget: { usd_per_million_tokens: -1, max_cost_usd: 10 },
      }),
    ).toThrow();
  });

  it("rejects zero max_cost_usd (PositiveNumber guard)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceConfig)({
        budget: { usd_per_million_tokens: 5, max_cost_usd: 0 },
      }),
    ).toThrow();
  });

  it("usd_per_million_tokens alone (no cost ceiling) is accepted", () => {
    const config = Schema.decodeUnknownSync(ServiceConfig)({
      budget: { usd_per_million_tokens: 5 },
    });
    expect(config.budget.usd_per_million_tokens).toBe(5);
    expect(config.budget.max_cost_usd).toBeUndefined();
  });
});

describe("evaluateBudget USD ceiling (#77)", () => {
  it("computes spentUsd = tokens/1e6 * rate", () => {
    const s = evaluateBudget({ usd_per_million_tokens: 5, max_cost_usd: 10 }, totals(1_000_000));
    expect(s.spentUsd).toBe(5);
    expect(s.limitUsd).toBe(10);
    expect(s.remainingUsd).toBe(5);
    expect(s.paused).toBe(false);
  });

  it("pauses when cost ≥ max_cost_usd even if under the token ceiling", () => {
    // 2_000_001 tokens / 1e6 * 5 = 10.000005 ≥ 10 → cost ceiling hit
    const s = evaluateBudget(
      { max_total_tokens: 10_000_000, usd_per_million_tokens: 5, max_cost_usd: 10 },
      totals(2_000_001),
    );
    expect(s.paused).toBe(true);
    // Token ceiling not hit (2M < 10M)
    expect(s.remainingTokens ?? 0).toBeGreaterThan(0);
  });

  it("pauses when tokens ≥ token ceiling even if under cost ceiling", () => {
    const s = evaluateBudget(
      { max_total_tokens: 100, usd_per_million_tokens: 5, max_cost_usd: 1_000 },
      totals(100),
    );
    expect(s.paused).toBe(true);
    expect(s.limitUsd).toBe(1_000);
    expect(s.spentUsd).toBeLessThan(1_000);
  });

  it("USD-only config (no token ceiling) still pauses on cost", () => {
    // 500_000 / 1e6 * 10 = 5 ≥ 5 → cost ceiling hit
    const s = evaluateBudget({ usd_per_million_tokens: 10, max_cost_usd: 5 }, totals(500_000));
    expect(s.configured).toBe(true);
    expect(s.limitTokens).toBeNull();
    expect(s.paused).toBe(true);
    expect(s.spentUsd).toBe(5);
    expect(s.remainingUsd).toBe(0);
  });

  it("both-null stays inert (empty budget = no ceiling)", () => {
    const s = evaluateBudget({}, totals(999_999_999));
    expect(s.configured).toBe(false);
    expect(s.paused).toBe(false);
    expect(s.limitUsd).toBeNull();
    expect(s.spentUsd).toBeNull();
    expect(s.remainingUsd).toBeNull();
  });

  it("configured reflects either ceiling being set", () => {
    expect(evaluateBudget({ max_total_tokens: 1 }, totals(0)).configured).toBe(true);
    expect(
      evaluateBudget({ usd_per_million_tokens: 5, max_cost_usd: 1 }, totals(0)).configured,
    ).toBe(true);
    expect(evaluateBudget({}, totals(0)).configured).toBe(false);
  });
});

describe("budget snapshot projection USD (#77)", () => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({});
  const state = initialState(config);

  it("USD-only ceiling projects a budget block with USD fields, no token fields", () => {
    // 500_000 / 1e6 * 10 = 5 → exactly at limit
    const snap = toSnapshot(state, {
      budget: evaluateBudget({ usd_per_million_tokens: 10, max_cost_usd: 5 }, totals(500_000)),
    });
    expect(snap.budget).toBeDefined();
    expect(snap.budget?.spent_usd).toBe(5);
    expect(snap.budget?.limit_usd).toBe(5);
    expect(snap.budget?.remaining_usd).toBe(0);
    expect(snap.budget?.paused).toBe(true);
    expect(snap.budget?.spent_tokens).toBe(500_000);
    // No token fields when no token ceiling is configured.
    expect((snap.budget as unknown as Record<string, unknown>).limit_tokens).toBeUndefined();
    expect((snap.budget as unknown as Record<string, unknown>).remaining_tokens).toBeUndefined();
  });

  it("both ceilings project both field groups in one block", () => {
    const snap = toSnapshot(
      { ...state, agent_totals: totals(500_000) },
      {
        budget: evaluateBudget(
          { max_total_tokens: 1_000_000, usd_per_million_tokens: 10, max_cost_usd: 100 },
          totals(500_000),
        ),
      },
    );
    expect(snap.budget?.limit_tokens).toBe(1_000_000);
    expect(snap.budget?.remaining_tokens).toBe(500_000);
    expect(snap.budget?.spent_usd).toBe(5);
    expect(snap.budget?.limit_usd).toBe(100);
    expect(snap.budget?.remaining_usd).toBe(95);
    expect(snap.budget?.paused).toBe(false);
  });
});
