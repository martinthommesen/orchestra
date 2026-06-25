import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { ServiceConfig } from "../src/core/domain/workflow";
import {
  MissingTrackerApiKey,
  MissingTrackerRepo,
  UnsupportedTrackerKind,
} from "../src/core/errors";
import {
  CONTINUATION_DELAY_MS,
  FAILURE_BASE_MS,
  failureBackoffMs,
} from "../src/core/orchestrator/backoff";
import {
  availableSlots,
  concurrencyContext,
  perStateLimit,
  planDispatch,
} from "../src/core/orchestrator/concurrency";
import { preflight, SUPPORTED_TRACKER_KIND } from "../src/core/orchestrator/preflight";
import { planReconciliation } from "../src/core/orchestrator/reconcile";
import {
  compareIssues,
  isBlockerResolved,
  isEligible,
  selectCandidates,
  selectionContext,
} from "../src/core/orchestrator/selection";
import {
  addUsage,
  claim,
  clearRetry,
  clearRunning,
  initialState,
  markCompleted,
  release,
  setRetry,
  setRunning,
  unclaim,
} from "../src/core/orchestrator/state";
import { buildDef, makeIssue, makeStateRef } from "./fakes/harness";

/**
 * Sprint 1, Task 11 — unit + property coverage for the orchestrator's pure cores
 * (selection §8.2, concurrency §8.3, backoff §8.4, reconciliation §8.5, state §7,
 * preflight §6.3). These functions carry the scheduling invariants, so they are tested
 * exhaustively in isolation; the full-loop scenarios live in `orchestrator-loop.test.ts`.
 */

const ctxOf = (over?: Partial<Parameters<typeof selectionContext>[0]>) =>
  selectionContext({
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Closed"],
    requiredLabels: [],
    claimed: [],
    ...over,
  });

// ───────────────────────────── selection (§8.2) ─────────────────────────────

describe("selection / isEligible", () => {
  it("accepts an active, unclaimed, label-satisfying issue", () => {
    expect(isEligible(makeIssue({ id: "1", identifier: "A-1", state: "Todo" }), ctxOf())).toBe(
      true,
    );
  });

  it("rejects terminal-state issues", () => {
    expect(isEligible(makeIssue({ id: "1", identifier: "A-1", state: "Done" }), ctxOf())).toBe(
      false,
    );
  });

  it("rejects non-active (e.g. Backlog) states", () => {
    expect(isEligible(makeIssue({ id: "1", identifier: "A-1", state: "Backlog" }), ctxOf())).toBe(
      false,
    );
  });

  it("rejects already-claimed issues", () => {
    expect(
      isEligible(
        makeIssue({ id: "1", identifier: "A-1", state: "Todo" }),
        ctxOf({ claimed: ["1"] }),
      ),
    ).toBe(false);
  });

  it("requires every configured label (normalized)", () => {
    const ctx = ctxOf({ requiredLabels: ["Ready"] });
    expect(isEligible(makeIssue({ id: "1", identifier: "A-1", state: "Todo" }), ctx)).toBe(false);
    expect(
      isEligible(makeIssue({ id: "1", identifier: "A-1", state: "Todo", labels: ["ready"] }), ctx),
    ).toBe(true);
  });

  it("holds back a Todo with an unresolved blocker, but not once In Progress", () => {
    const blocked = { id: "b", identifier: "B-1", state: "Todo" } as const;
    const todo = makeIssue({ id: "1", identifier: "A-1", state: "Todo", blocked_by: [blocked] });
    const inProgress = makeIssue({
      id: "1",
      identifier: "A-1",
      state: "In Progress",
      blocked_by: [blocked],
    });
    expect(isEligible(todo, ctxOf())).toBe(false);
    expect(isEligible(inProgress, ctxOf())).toBe(true);
  });

  it("treats a resolved (terminal-state) blocker as cleared, and a null-state blocker as unresolved", () => {
    const terminals = ctxOf().terminalStates;
    expect(isBlockerResolved({ id: "b", identifier: "B-1", state: "Done" }, terminals)).toBe(true);
    expect(isBlockerResolved({ id: "b", identifier: "B-1", state: null }, terminals)).toBe(false);
    const cleared = makeIssue({
      id: "1",
      identifier: "A-1",
      state: "Todo",
      blocked_by: [{ id: "b", identifier: "B-1", state: "Done" }],
    });
    expect(isEligible(cleared, ctxOf())).toBe(true);
  });
});

describe("selection / sort + selectCandidates", () => {
  it("orders by priority asc (null last), then created_at asc (null last), then identifier", () => {
    const a = makeIssue({ id: "1", identifier: "A-1", state: "Todo", priority: 2 });
    const b = makeIssue({ id: "2", identifier: "A-2", state: "Todo", priority: 1 });
    const c = makeIssue({ id: "3", identifier: "A-3", state: "Todo", priority: null });
    expect(
      [a, b, c]
        .slice()
        .sort(compareIssues)
        .map((i) => i.id),
    ).toEqual(["2", "1", "3"]);
  });

  it("breaks priority ties by created_at then identifier", () => {
    const old = new Date(1_000);
    const newer = new Date(2_000);
    const a = makeIssue({
      id: "1",
      identifier: "Z-9",
      state: "Todo",
      priority: 1,
      created_at: newer,
    });
    const b = makeIssue({
      id: "2",
      identifier: "A-1",
      state: "Todo",
      priority: 1,
      created_at: old,
    });
    const c = makeIssue({
      id: "3",
      identifier: "M-5",
      state: "Todo",
      priority: 1,
      created_at: old,
    });
    // b & c share oldest created_at → identifier tiebreak (A-1 before M-5); a is newest → last.
    expect(
      [a, b, c]
        .slice()
        .sort(compareIssues)
        .map((i) => i.id),
    ).toEqual(["2", "3", "1"]);
  });

  const arbIssue = fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      identifier: fc.string({ minLength: 1, maxLength: 6 }),
      state: fc.constantFrom("Todo", "In Progress", "Done", "Closed", "Backlog"),
      priority: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
      created_at: fc.option(
        fc.date({ min: new Date(0), max: new Date(10_000), noInvalidDate: true }),
        {
          nil: null,
        },
      ),
    })
    .map((r) =>
      makeIssue({
        id: r.id,
        identifier: r.identifier,
        state: r.state,
        priority: r.priority,
        created_at: r.created_at,
      }),
    );

  it("property: selectCandidates output is fully sorted and contains only eligible issues", () => {
    fc.assert(
      fc.property(fc.array(arbIssue, { maxLength: 30 }), (issues) => {
        const ctx = ctxOf();
        const out = selectCandidates(issues, ctx);
        // every output is eligible
        expect(out.every((i) => isEligible(i, ctx))).toBe(true);
        // pairwise sorted
        for (let i = 1; i < out.length; i++) {
          expect(compareIssues(out[i - 1] as never, out[i] as never)).toBeLessThanOrEqual(0);
        }
        // deterministic / stable across repeated calls
        const again = selectCandidates(issues, ctx);
        expect(again.map((i) => i.id)).toEqual(out.map((i) => i.id));
      }),
    );
  });

  it("property: never double-dispatch — a claimed/running issue is never selected", () => {
    fc.assert(
      fc.property(
        fc.array(arbIssue, { maxLength: 30 }),
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 30 }),
        (issues, claimed) => {
          // `claimed` carries the ids of every already-claimed *and* running issue
          // (setRunning claims), so this models the orchestrator's in-flight set.
          const ctx = ctxOf({ claimed });
          const out = selectCandidates(issues, ctx);
          const claimedSet = new Set(claimed);
          // No selected candidate is already in flight — the core no-double-dispatch rule.
          expect(out.some((i) => claimedSet.has(i.id))).toBe(false);
          // And every selected candidate is independently eligible.
          expect(out.every((i) => isEligible(i, ctx))).toBe(true);
        },
      ),
    );
  });
});

// ───────────────────────────── concurrency (§8.3) ─────────────────────────────

describe("concurrency", () => {
  it("availableSlots clamps at zero", () => {
    expect(availableSlots(5, 2)).toBe(3);
    expect(availableSlots(2, 5)).toBe(0);
  });

  it("perStateLimit falls back to the global cap when no override", () => {
    const ctx = concurrencyContext({
      globalLimit: 10,
      perStateLimits: { "in progress": 2 },
      runningTotal: 0,
      runningByState: new Map(),
    });
    expect(perStateLimit("In Progress", ctx)).toBe(2);
    expect(perStateLimit("Todo", ctx)).toBe(10);
  });

  it("planDispatch respects the global free-slot budget", () => {
    const sorted = [
      makeIssue({ id: "1", identifier: "A-1", state: "Todo" }),
      makeIssue({ id: "2", identifier: "A-2", state: "Todo" }),
      makeIssue({ id: "3", identifier: "A-3", state: "Todo" }),
    ];
    const ctx = concurrencyContext({
      globalLimit: 2,
      perStateLimits: {},
      runningTotal: 1,
      runningByState: new Map([["todo", 1]]),
    });
    // global available = 2 - 1 = 1
    expect(planDispatch(sorted, ctx).map((i) => i.id)).toEqual(["1"]);
  });

  it("planDispatch respects per-state caps", () => {
    const sorted = [
      makeIssue({ id: "1", identifier: "A-1", state: "Todo" }),
      makeIssue({ id: "2", identifier: "A-2", state: "In Progress" }),
      makeIssue({ id: "3", identifier: "A-3", state: "Todo" }),
    ];
    const ctx = concurrencyContext({
      globalLimit: 10,
      perStateLimits: { todo: 1 },
      runningTotal: 0,
      runningByState: new Map(),
    });
    // only one Todo allowed; the In Progress one passes too
    expect(planDispatch(sorted, ctx).map((i) => i.id)).toEqual(["1", "2"]);
  });

  const arbState = fc.constantFrom("Todo", "In Progress", "Review");
  const arbPlanInput = fc.record({
    issues: fc.array(
      fc
        .record({ id: fc.string({ minLength: 1, maxLength: 5 }), state: arbState })
        .map((r) => makeIssue({ id: r.id, identifier: r.id, state: r.state })),
      { maxLength: 25 },
    ),
    globalLimit: fc.integer({ min: 0, max: 8 }),
    runningTotal: fc.integer({ min: 0, max: 8 }),
    perStateLimits: fc.dictionary(arbState, fc.integer({ min: 0, max: 5 })),
  });

  it("property: planDispatch never exceeds the global budget nor any per-state cap", () => {
    fc.assert(
      fc.property(arbPlanInput, (input) => {
        const ctx = concurrencyContext({
          globalLimit: input.globalLimit,
          perStateLimits: input.perStateLimits,
          runningTotal: input.runningTotal,
          runningByState: new Map(),
        });
        const chosen = planDispatch(input.issues, ctx);
        // never beyond global free slots
        expect(chosen.length).toBeLessThanOrEqual(
          availableSlots(input.globalLimit, input.runningTotal),
        );
        // never beyond any per-state cap
        const byState = new Map<string, number>();
        for (const issue of chosen) {
          const s = issue.state.toLowerCase();
          byState.set(s, (byState.get(s) ?? 0) + 1);
        }
        for (const [s, count] of byState) {
          expect(count).toBeLessThanOrEqual(perStateLimit(s, ctx));
        }
        // chosen is a subsequence of the input (order preserved)
        const ids = input.issues.map((i) => i.id);
        const chosenIds = chosen.map((i) => i.id);
        let k = 0;
        for (const id of ids) {
          if (k < chosenIds.length && chosenIds[k] === id) k++;
        }
        expect(k).toBe(chosenIds.length);
      }),
    );
  });
});

// ───────────────────────────── backoff (§8.4) ─────────────────────────────

describe("backoff", () => {
  it("uses 10s * 2^(attempt-1), capped", () => {
    expect(failureBackoffMs(1, 300_000)).toBe(FAILURE_BASE_MS);
    expect(failureBackoffMs(2, 300_000)).toBe(20_000);
    expect(failureBackoffMs(3, 300_000)).toBe(40_000);
    expect(failureBackoffMs(99, 300_000)).toBe(300_000);
    expect(CONTINUATION_DELAY_MS).toBe(1_000);
  });

  it("treats attempt <= 0 as the first attempt", () => {
    expect(failureBackoffMs(0, 300_000)).toBe(FAILURE_BASE_MS);
    expect(failureBackoffMs(-5, 300_000)).toBe(FAILURE_BASE_MS);
  });

  it("property: monotonic non-decreasing and never above the cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1_000, max: 1_000_000 }),
        (attempt, cap) => {
          const here = failureBackoffMs(attempt, cap);
          const next = failureBackoffMs(attempt + 1, cap);
          expect(here).toBeLessThanOrEqual(next);
          expect(here).toBeLessThanOrEqual(cap);
          expect(here).toBeGreaterThanOrEqual(Math.min(FAILURE_BASE_MS, cap));
        },
      ),
    );
  });
});

// ───────────────────────────── reconciliation (§8.5) ─────────────────────────────

describe("reconciliation", () => {
  const active = new Set(["in progress", "todo"]);
  const terminal = new Set(["done", "closed"]);

  it("kills a stalled worker (precedence over tracker state)", () => {
    const actions = planReconciliation({
      running: [{ issueId: "1", lastEventAt: 0 }],
      refreshed: new Map([["1", makeStateRef("1", "In Progress")]]),
      now: 10_000,
      stallTimeoutMs: 5_000,
      activeStates: active,
      terminalStates: terminal,
    });
    expect(actions).toEqual([{ _tag: "StallKill", issueId: "1" }]);
  });

  it("disables stall detection when timeout <= 0", () => {
    const actions = planReconciliation({
      running: [{ issueId: "1", lastEventAt: 0 }],
      refreshed: new Map([["1", makeStateRef("1", "In Progress")]]),
      now: 10_000_000,
      stallTimeoutMs: 0,
      activeStates: active,
      terminalStates: terminal,
    });
    expect(actions).toEqual([
      { _tag: "UpdateActive", issueId: "1", ref: makeStateRef("1", "In Progress") },
    ]);
  });

  it("keeps all workers untouched when the refresh failed", () => {
    const actions = planReconciliation({
      running: [{ issueId: "1", lastEventAt: 9_999 }],
      refreshed: null,
      now: 10_000,
      stallTimeoutMs: 5_000,
      activeStates: active,
      terminalStates: terminal,
    });
    expect(actions).toEqual([]);
  });

  it("maps terminal → TerminalKill, active → UpdateActive, vanished/other → NeitherKill", () => {
    const actions = planReconciliation({
      running: [
        { issueId: "term", lastEventAt: 9_999 },
        { issueId: "act", lastEventAt: 9_999 },
        { issueId: "other", lastEventAt: 9_999 },
        { issueId: "gone", lastEventAt: 9_999 },
      ],
      refreshed: new Map([
        ["term", makeStateRef("term", "Done")],
        ["act", makeStateRef("act", "In Progress")],
        ["other", makeStateRef("other", "Backlog")],
      ]),
      now: 10_000,
      stallTimeoutMs: 5_000,
      activeStates: active,
      terminalStates: terminal,
    });
    expect(actions).toEqual([
      { _tag: "TerminalKill", issueId: "term" },
      { _tag: "UpdateActive", issueId: "act", ref: makeStateRef("act", "In Progress") },
      { _tag: "NeitherKill", issueId: "other" },
      { _tag: "NeitherKill", issueId: "gone" },
    ]);
  });

  it("property: never emits more actions than running workers", () => {
    const arbRunning = fc.array(
      fc.record({
        issueId: fc.string({ minLength: 1, maxLength: 4 }),
        lastEventAt: fc.integer({ min: 0, max: 1_000 }),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(arbRunning, fc.integer({ min: 0, max: 2_000 }), (running, now) => {
        const actions = planReconciliation({
          running,
          refreshed: new Map(
            running.map((r) => [r.issueId, makeStateRef(r.issueId, "In Progress")]),
          ),
          now,
          stallTimeoutMs: 500,
          activeStates: active,
          terminalStates: terminal,
        });
        expect(actions.length).toBeLessThanOrEqual(running.length);
      }),
    );
  });

  it("parked (abandoned) issues reconcile by tracker state only — no stall, no UpdateActive", () => {
    const actions = planReconciliation({
      running: [],
      abandoned: [{ issueId: "term" }, { issueId: "act" }, { issueId: "gone" }],
      refreshed: new Map([
        ["term", makeStateRef("term", "Done")],
        ["act", makeStateRef("act", "In Progress")],
      ]),
      now: 10_000,
      stallTimeoutMs: 5_000,
      activeStates: active,
      terminalStates: terminal,
    });
    // active → left parked (no action); terminal → reap; vanished → release.
    expect(actions).toEqual([
      { _tag: "TerminalKill", issueId: "term" },
      { _tag: "NeitherKill", issueId: "gone" },
    ]);
  });

  it("leaves abandoned issues untouched when the tracker refresh failed", () => {
    const actions = planReconciliation({
      running: [],
      abandoned: [{ issueId: "a" }],
      refreshed: null,
      now: 10_000,
      stallTimeoutMs: 5_000,
      activeStates: active,
      terminalStates: terminal,
    });
    expect(actions).toEqual([]);
  });
});

// ───────────────────────────── state transitions (§7) ─────────────────────────────

describe("state transitions", () => {
  const base = () => initialState(buildDef().config);
  const attempt = (id: string) => ({
    issue_id: id,
    issue_identifier: id,
    attempt: null,
    workspace_path: `/ws/${id}`,
    started_at: new Date(0),
    status: "PreparingWorkspace" as const,
  });

  it("claim is idempotent; unclaim removes", () => {
    const s = claim(claim(base(), "a"), "a");
    expect(s.claimed).toEqual(["a"]);
    expect(unclaim(s, "a").claimed).toEqual([]);
  });

  it("setRunning records the attempt and claims; clearRunning keeps the claim", () => {
    const s = setRunning(base(), attempt("a"));
    expect(s.running.a?.issue_id).toBe("a");
    expect(s.claimed).toContain("a");
    const cleared = clearRunning(s, "a");
    expect(cleared.running.a).toBeUndefined();
    expect(cleared.claimed).toContain("a");
  });

  it("setRetry/clearRetry manage the retry map and claim", () => {
    const entry = { issue_id: "a", identifier: "a", attempt: 1, due_at_ms: 123, error: null };
    const s = setRetry(base(), entry);
    expect(s.retry_attempts.a?.attempt).toBe(1);
    expect(s.claimed).toContain("a");
    expect(clearRetry(s, "a").retry_attempts.a).toBeUndefined();
  });

  it("markCompleted clears running/retry/claim and records completion", () => {
    const s0 = setRetry(setRunning(base(), attempt("a")), {
      issue_id: "a",
      identifier: "a",
      attempt: 1,
      due_at_ms: 0,
      error: null,
    });
    const s = markCompleted(s0, "a");
    expect(s.completed).toEqual(["a"]);
    expect(s.running.a).toBeUndefined();
    expect(s.retry_attempts.a).toBeUndefined();
    expect(s.claimed).not.toContain("a");
  });

  it("release clears everything without marking completed", () => {
    const s = release(setRunning(base(), attempt("a")), "a");
    expect(s.completed).toEqual([]);
    expect(s.running.a).toBeUndefined();
    expect(s.claimed).not.toContain("a");
  });

  it("addUsage accumulates token + runtime totals", () => {
    const s = addUsage(
      addUsage(base(), {
        input_tokens: 3,
        output_tokens: 5,
        total_tokens: 8,
        total_api_duration_ms: 2_000,
      }),
      {
        input_tokens: 1,
        total_tokens: 1,
      },
    );
    expect(s.agent_totals.input_tokens).toBe(4);
    expect(s.agent_totals.output_tokens).toBe(5);
    expect(s.agent_totals.total_tokens).toBe(9);
    expect(s.agent_totals.runtime_seconds).toBeCloseTo(2);
  });
});

// ───────────────────────────── preflight (§6.3) ─────────────────────────────

describe("preflight", () => {
  const decode = (tracker: Record<string, unknown>): ServiceConfig =>
    Schema.decodeUnknownSync(ServiceConfig)({ tracker });

  it("accepts a complete github config", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* preflight(decode({ kind: "github", repo: "o/r", api_key: "tok" }));
        expect(SUPPORTED_TRACKER_KIND).toBe("github");
      }),
    ));

  it.effect("fails UnsupportedTrackerKind when kind is missing/unsupported", () =>
    Effect.gen(function* () {
      const e1 = yield* Effect.flip(preflight(decode({ repo: "o/r", api_key: "t" })));
      expect(e1).toBeInstanceOf(UnsupportedTrackerKind);
      const e2 = yield* Effect.flip(
        preflight(decode({ kind: "linear", repo: "o/r", api_key: "t" })),
      );
      expect(e2._tag).toBe("UnsupportedTrackerKind");
    }),
  );

  it.effect("fails MissingTrackerRepo when repo absent", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(preflight(decode({ kind: "github", api_key: "t" })));
      expect(e).toBeInstanceOf(MissingTrackerRepo);
    }),
  );

  it.effect("fails MissingTrackerApiKey when api_key absent", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(preflight(decode({ kind: "github", repo: "o/r" })));
      expect(e).toBeInstanceOf(MissingTrackerApiKey);
    }),
  );
});
