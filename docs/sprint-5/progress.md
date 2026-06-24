# Sprint 5 — Progress

Live tracker. Theme: **Operator Experience** (budget guardrails + durability visibility +
humanized event summaries). Branch: `feature/sprint-5` (off `main` @ `ec31b4c`).

## Board

| # | Task | Effort · Risk | Status |
|---|------|---------------|--------|
| #53 | Budget guardrails (pause dispatch at a spend ceiling) | M · Med | ✅ done |
| #54 | Surface durability/restore state in snapshot + dashboard | S–M · Low | ⏳ pending |
| #55 | Humanized agent-event summaries | M · Low | ⏳ pending |
| #56 | Tests + docs + handoff close-out | M · Low | ⏳ pending |

Dependencies: #53/#54/#55 independent · #56 → all.
Build order: #53 (review-gated) → #54 → #55 → #56.

Baseline at sprint start: **295 tests** green on `main` (`ec31b4c`).

## Notes

_(per-task notes land here as work completes — files changed, decisions, gate results.)_

### #53 — Budget guardrails ✅

Vertical slice (config → pure gate → core dispatch gate → snapshot → dashboard), all
strictly additive. The guard pauses **new** dispatch at a token ceiling and never touches
in-flight work.

**Config shape (additive, all-defaults).** New `budget` block on `ServiceConfig`
(`Schema.optionalWith`, default `BudgetConfig.make({})`), so an unchanged `WORKFLOW.md`
still decodes and the guard stays inert:

```
budget:
  max_total_tokens: <positive int>   # absent → unlimited (guard inert)
```

Only `max_total_tokens` — a single concrete token ceiling. **I did NOT add the optional
USD ceiling.** Per the clean-code "minimal-but-complete" mandate I declined to ship a cost
knob (`max_cost_usd` + `usd_per_million_tokens`) in this review-gated, dispatch-path chunk;
it's a clean, separately-addable concrete follow-up and the gate/snapshot/parse surface
stays minimal. The token ceiling fully delivers the headline behavior.

**Guard placement + in-flight-work-untouched guarantee (the key bit).**
In `loop.ts` `handleTick`, immediately after `const state = yield* store.get;` and BEFORE
`planDispatch`: `evaluateBudget(config.budget, state.agent_totals)` computes spend vs.
ceiling, then the *only* behavioral change is one line —
`const toDispatch = budget.paused ? [] : planDispatch(sorted, conCtx);`. When paused we
plan **zero** fresh dispatches and emit `TickEnd { dispatchSkipped: true }`.

Why in-flight work is provably untouched:
- the gate is a pure pre-`planDispatch` read; it does **not** modify the concurrency math,
  the retry math, or reconcile — `reconcile` already ran at the top of the tick and runs
  unchanged whether or not the budget is paused;
- it gates **only** `handleTick`'s fresh `toDispatch` loop. Retries / continuations
  re-dispatch through the **separate** `handleRetryDue` message path (fired by per-issue
  timer fibers), which the guard never reads or blocks;
- worker fibers stream and post `WorkerDone` on their own fibers; nothing in the gate
  interrupts, kills, or reschedules them.
- Test `budget-gate.test.ts` "at/over ceiling …" proves it: a worker dispatched while
  under budget reports usage that blows the ceiling, then a new candidate appears — the new
  candidate is withheld (`runner.runs == ["i1"]`) while the in-flight worker finishes and
  reconciles into `completed` exactly as today.

**Once-per-transition observation.** A runtime-only `let budgetPaused` latch in the loop
closure emits the new `BudgetExceeded` observation (`paused: boolean`, `limitTokens`,
`spentTokens`) only when `budget.paused` flips — entering paused, and on resume (resume is
reachable only if a future config reload raises the ceiling; spend is monotonic). No
per-tick spam; proven by the "fires once per transition" test (tick #2 emits one, tick #3
emits none). Rendered exhaustively in the feed (`recent-events.ts`: `budget_paused` warn /
`budget_resumed` info) and logfmt (`live-observer.ts`, reusing the `⏸ blocked` glyph).

**Snapshot (strictly additive, no /api/v2).** `runSnapshotServer(port, budgetConfig)`; the
read handler projects `evaluateBudget(...)` from the live totals. `toSnapshot` emits a
`budget` block `{ limit_tokens, spent_tokens, remaining_tokens, paused }` **only when a
ceiling is configured** — absent otherwise, so older dashboards are unaffected. Pure, no
state mutation.

**Dashboard.** Snapshot client gained `SnapshotBudget` + tolerant `parseBudget` (absent →
`undefined`). View-model gained `BudgetVM` (null → panel omitted) reusing `glyphs.ts`:
active → `▶ running` (info), paused → `⏸ blocked` (warn). `components.tsx` renders a
`BUDGET` `<Section>` only when `vm.budget !== null`; honors `--ascii`/`NO_COLOR`/non-TTY
like the existing panels.

**Files changed.**
- `src/core/domain/workflow.ts` — `BudgetConfig` + `budget` on `ServiceConfig`.
- `src/core/orchestrator/budget.ts` — **new** pure `evaluateBudget` / `BudgetStatus`.
- `src/core/orchestrator/loop.ts` — `budgetPaused` latch + pre-`planDispatch` gate + transition emit.
- `src/core/orchestrator/observer.ts` — `BudgetExceeded` observation variant.
- `src/core/observability/recent-events.ts`, `live-observer.ts` — exhaustive render of the variant.
- `src/core/observability/snapshot-server.ts` — `budget` extra + projection; `runSnapshotServer` takes `budgetConfig`.
- `src/cli/daemon.ts` — pass `def.config.budget` to the snapshot server.
- `src/cli/dashboard/snapshot-client.ts` — `SnapshotBudget` + `parseBudget`.
- `src/cli/dashboard/view-model.ts` — `BudgetVM` + `toBudgetVM` + wiring.
- `src/cli/dashboard/components.tsx` — `BUDGET` section.
- Tests: **new** `test/budget-gate.test.ts` (3 loop scenarios), **new** `test/budget-pure.test.ts`
  (8: config decode, evaluator, snapshot projection); additions to `test/dashboard/view-model.test.ts`
  (3), `test/dashboard/snapshot-client.test.ts` (4); harness gained a `budgetMaxTotalTokens` knob;
  exhaustive `Observation` sample maps in `live-observer`/`recent-events` tests gained `BudgetExceeded`;
  `snapshot-server.test.ts` updated for the new `runSnapshotServer` arg.

**Gate results.** `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm build` ✅ ·
`pnpm test` ✅ **312 passed** (295 baseline + 17 new, 0 regressions).

**Surprising / worth noting.** Runtime resume of a paused budget is effectively
unreachable in production (spend only grows, config is loaded once) — the latch still
handles resume correctly and cheaply, and it's covered by the exhaustive observation render
tests, so the code stays honest if a future config-reload feature raises the ceiling.
