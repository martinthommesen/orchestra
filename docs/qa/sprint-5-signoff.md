# Sprint 5 — Operator Experience QA Sign-off

> QA: Ivy · Date: 2026-06-24 · Branch under test: `feature/sprint-5` (synced with `main`) ·
> HEAD `a767bb0` (merge of PR #59) · vitest + @effect/vitest + fast-check@4.8.0 + Ink ·
> Audited against `docs/sprint-5/plan.md`, `docs/sprint-5/done.md`, and `PROJECT_BRIEF.md` §7/§8.
> Scope: #53 (budget guardrails), #54 (restore visibility), #55 (humanized events), #56 (close-out).

## Verdict: ❌ BLOCK — one narrow, trivially-fixable blocker (#60); all three features otherwise sound

Sprint 5's three features are **functionally correct** and the design invariants hold under audit:
the budget gate is a pure pre-`planDispatch` read that provably never kills in-flight work, restore
visibility is display-only and absent on cold start, and the humanizer maps by tag only (no payload
leak) and is deliberately kept out of the lifecycle feed. Three of four gates are green.

**But the headline claim — "336 passed / all gates 0" — is false on re-run.** `pnpm test` is
**non-deterministically red**: it failed **7 of 8** full-suite runs in my hands, every failure in the
*same* test (`test/humanize.test.ts`, the never-blank property), with `fc.string()` counterexamples
`"valueOf"`, `"toString"`, `"__proto__"`. Root cause is a real prototype-chain lookup defect in
`humanizeAgentEvent` (#60). Production runtime is unaffected (the only caller passes a known union
tag), so this is a single, narrowly-scoped, one-line-fixable blocker — **not** a feature failure. I
cannot sign off "all gates green" when the required test gate is a coin-flip the wrong way ~87% of
the time and the sprint's own success criteria demand "all gates 0; no regression in the existing
suite." Re-run cleanly green and this flips to a clean SHIP.

**One bug filed: #60 (major).** No other flakiness observed — every non-humanize suite was green on
all 8 runs, including the budget gate, restore capture, and clock-sensitive paths the task flagged.

---

## Gates (clean run on the merged tree)

| Gate | Command | Result | Evidence |
|------|---------|--------|----------|
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) | ✅ PASS | exit **0** |
| Lint | `pnpm lint` (`biome check .`) | ✅ PASS | "Checked **109 files** … No fixes applied", exit **0** |
| Build | `pnpm build` (`tsup`) | ✅ PASS | `dist/cli/main.js` 133.96 KB + `dist/cli/dashboard.js` 33.80 KB, "Build success", exit **0** |
| Test | `pnpm test` (`vitest run`) | ❌ **FLAKY-RED** | **7/8 full-suite runs failed**; the lone failure is `test/humanize.test.ts` (`is total and never blank…(property)`), counterexamples `valueOf` / `toString` / `__proto__`. On the rare passing seed: **336 passed (336)** across 30 files. |

### Test determinism loop (skeptical re-run, as the task asked)

`pnpm vitest run` ×8 from repo root:

| run | result | failing test / counterexample |
|-----|--------|-------------------------------|
| 1 | ❌ 1 failed / 335 | `humanize` · `["valueOf"]` |
| 2 | ❌ 1 failed / 335 | `humanize` · `["toString"]` |
| 3 | ❌ 1 failed / 335 | `humanize` · `["valueOf"]` |
| 4 | ❌ 1 failed / 335 | `humanize` · `["toString"]` |
| 5 | ❌ 1 failed / 335 | `humanize` · `["toString"]` |
| 6 | ✅ 336 passed | — |
| 7 | ❌ 1 failed / 335 | `humanize` · `["toString"]` |
| 8 | ❌ 1 failed / 335 | `humanize` · `["valueOf"]` |

**1 pass / 7 fail.** The failure is isolated to one suite; **no other test ever flaked** across the
8 runs (budget gate, restore-reconcile, snapshot-server, dashboard render, persistence — all green
every time). The Sprint-4 debounce-flake area and the new budget/restore/clock paths are clean.

### Root cause (filed #60)

`humanizeAgentEvent` looks up `AGENT_EVENT_SUMMARIES[eventTag as AgentEventTag]` on a plain object
literal, so an `eventTag` that collides with an `Object.prototype` member name resolves to an
**inherited function/object**, which is `!== undefined`, so the function returns that non-string:

```
humanizeAgentEvent("toString")  → [Function: toString]   (typeof "function", .length 0)
humanizeAgentEvent("__proto__") → Object.prototype        (typeof "object",  .length undefined)
humanizeAgentEvent("valueOf")   → [Function: valueOf]
```

This violates the function's documented "total, **never-blank string**" contract, which the
property test pins. Suggested fix (dev team owns it): guard with `Object.hasOwn(...)`, or build the
table with `Object.create(null)` / a `Map`. One line; keep the property test as the regression guard.

**Why this is "only" major, not catastrophic:** the sole caller is `loop.ts:634`
`eventTag: event._tag`, where `event` is a parsed `AgentEvent` domain union — always one of the 12
known tags, never a prototype key. So there is **no** log/snapshot corruption or content leak in
production. The blocker is the broken contract + the non-deterministic required gate, not a runtime
defect.

---

## Per-feature findings (vs plan/`done.md` claims)

### #53 — Budget guardrails ✅ (code + tests sound)

| Claim | Verdict | Evidence |
|-------|---------|----------|
| Pure pre-`planDispatch` guard pauses NEW dispatch at the token ceiling | ✅ | `evaluateBudget` (`budget.ts`) is pure/total, no IO/state. `loop.ts:593` `const toDispatch = budget.paused ? [] : planDispatch(sorted, conCtx)` — the *only* behavioral edit. |
| In-flight workers, retries (`handleRetryDue`), reconcile never affected | ✅ | `handleTick` order (`loop.ts:537`): `TickStart → reconcile (unconditional) → preflight → fetch → budget gate → dispatch`. Reconcile runs *before* and independent of the gate; worker completion rides the mailbox `handleWorkerDone`; retries fire on their own timers via the separate `handleRetryDue`. The guard reads none of these paths. **Pinned by `budget-gate.test.ts`**: an in-flight worker that blows the ceiling still finishes & reconciles (`completed` contains `i1`, `running.i1` undefined) while a new candidate `i2` is withheld (`runs == ["i1"]`). |
| `BudgetExceeded` fires once per transition, not per tick | ✅ | Runtime latch `budgetPaused` (`loop.ts:150,570`) emits only on `budget.paused !== budgetPaused`. Test "paused observation fires once per transition" advances 3 ticks → exactly one emission. |
| Snapshot `budget` block present ONLY when a ceiling is configured | ✅ | `snapshot-server.ts` `budgetProjection` returns `null` unless `budget.configured`; spread `...(budget === null ? {} : { budget })`. Unconfigured → field absent. |
| Absent config → guard fully inert (pre-#53 behavior) | ✅ | `evaluateBudget` with `max_total_tokens` undefined → `{configured:false, paused:false}`; gate is identity. `BudgetConfig` is `optionalWith` all-defaults so an unchanged `WORKFLOW.md` decodes. |

Honest follow-up acknowledged in `done.md`: the runtime *resume* latch is unreachable in production
(spend only grows, config loads once). Correct and harmless — covered for a future config-reload. No
issue filed (it's a documented, non-blocking design note, not a defect).

### #54 — Restore visibility ✅

| Claim | Verdict | Evidence |
|-------|---------|----------|
| Set-once capture at boot on a real restore; cold start → field ABSENT | ✅ | `restoreFromCheckpoint` early-returns `[]` when running/retry/completed all empty (`loop.ts:811`) **before** any `restoreStatus.record`, so cold start never records. `makeRestoreStatus` is `Ref<RestoreSummary|null>` seeded `null`, `record: Ref.update(prev => prev ?? summary)` (set-once). `snapshot-server` omits `restore` when `get` is `null`. |
| Display-only — #41's restore/re-arm/reconcile byte-identical | ✅ | The `record` call sits *alongside* the existing `RestoredAfterRestart` emit on the same path; it touches no scheduling state. `at` is stamped from the injected clock (`new Date(wallNow)`), deterministic under TestClock. `restore-reconcile.test.ts` (re-armed-from-wall-clock invariants) green across all 8 loop runs. |

### #55 — Humanized events ⚠️ (correct mapping; prototype-key contract defect → #60)

| Claim | Verdict | Evidence |
|-------|---------|----------|
| Known tags → friendly summaries; unknown → raw label (never blank) | ⚠️ | True for the 12 known tags and ordinary unknown strings. **Fails for `Object.prototype` key names** (`toString`/`valueOf`/`__proto__`/…), which return a function/object — see #60. |
| Maps by tag only, never echoes payload → no content leak | ✅ | Both call sites pass `obs.eventTag` only (`live-observer.ts:96`, `observer-tee.ts:34`). The `AgentEvent` observation carries only `{issueId, identifier, sessionId, eventTag}` — `eventTag = event._tag` (a union tag), no message/prompt/tool-arg text. No path to leak issue content. Compile-checked `Record<AgentEventTag,string>` table. |
| Deliberately NOT flooded into `recent_events` | ✅ | `toEventDraft` (`recent-events.ts:62`) returns `null` for `AgentEvent` (and Tick*/Reconciled). `BudgetExceeded`/`RestoredAfterRestart` transitions *are* in the feed — correct (once-per-transition / once-at-boot, not chatter). |

### #56 — Close-out ✅ (with the gate caveat above)

Cross-feature coverage (`test/cross-feature.test.ts`, 3 tests) genuinely exercises all-three-blocks-
at-once, cold-start absence-of-all, and a full wire→VM decode — no duplication of per-feature suites.
README/`done.md`/`PROJECT_BRIEF.md` §7/§8 are accurate **except** the "336 passed / all gates 0"
claim, which does not survive re-run (see #60).

---

## Additive-snapshot / backward-compat audit ✅

A cold-start, unconfigured daemon emits **none** of the new blocks, verified end-to-end:

- **Wire (server):** `budget` omitted unless `configured` (`budgetProjection`), `restore` omitted
  unless a summary was captured (`restoreProjection`), humanized `last_activity.message` rides the
  already-existing additive `last_activity` (attached only when present).
- **Parse (client):** `parseBudget`/`parseRestore` → `undefined` when absent; spread only when
  defined. `last_activity.message` is `optString` (older daemons send only `event_tag`).
- **VM:** `budget`/`restore` default to `null`; `formatLastActivity` prefers `message ?? event_tag`.
- **Render:** `DashboardView` shows the `RESTORED`/`BUDGET` `<Section>`s only when non-null.

So a pre-Sprint-5 dashboard renders byte-identically. Pinned by `cross-feature.test.ts` #2.

## Accessibility / render switches ✅ (by reading the render path)

`components.tsx` threads `ascii` + `color` (Themed) through every panel including the new `Budget`
and `Restore` rows and the last-activity line: glyphs swap to ASCII (`{ascii ? budget.ascii :
budget.glyph}`, `↳`→`-`), and colour is gated by `color` (so `NO_COLOR`/non-TTY render plain).
Consistent with the Sprint-2/3 design system. Verified by reading; the dashboard render suite is
green on all loop runs.

---

## Issues filed

| # | Severity | Area | Title |
|---|----------|------|-------|
| [#60](https://github.com/martinthommesen/orchestra/issues/60) | **major** | `area:observability` + `area:testing` | `humanizeAgentEvent` returns non-string for `Object.prototype` keys → property test flaky-red (`pnpm test` fails ~7/8 runs) |

No `severity:*` labels exist on the repo (as in Sprints 1/3/4); severity is in the title/body, with
`bug` + the closest `area:*` labels applied.

---

## What I exercised (beyond reading the code)

- **Gates** — typecheck (0), lint (109 files, 0), build (0) on the merged tree; `test` re-run **8×**
  to characterise the flake (1 pass / 7 fail, all `humanize`).
- **Flake isolation** — confirmed the failure is a single suite with a deterministic root cause
  (prototype-chain lookup), reproduced the exact counterexamples, and ran a direct Node repro of the
  non-string return values.
- **Invariant audit** — traced the budget gate's placement in `handleTick` (reconcile-before-gate,
  retries/workers off-path), the set-once restore `Ref` + cold-start early-return, and the humanizer's
  tag-only, no-payload call sites; each against its pinning test.
- **Additive/back-compat** — walked server projection → client parse → VM → render for all three
  blocks, confirming cold-start omits everything.

No source files, git state, or commits were modified by QA beyond this sign-off doc and GitHub issue
#60 (working tree otherwise clean). I did not push or open a PR.

---

## Out of scope / not tested (stated honestly)

- **Live runtime smoke** — a real daemon run against `WORKFLOW.md` with a `budget.max_total_tokens`
  and a snapshot port needs a real GitHub token + target repo + the headless `copilot` CLI, none of
  which are reliably reproducible in this environment. I did **not** run a live smoke and make no
  claims from one; this sign-off rests on the gate results + code/test audit above.
- **Budget runtime-resume in production** — unreachable today (documented `done.md` follow-up); the
  resume latch is covered only by the observation-render tests, not a live config-reload.

---

## Path to a clean SHIP

Fix #60 (one-line own-property guard in `humanize.ts`), confirm `pnpm vitest run` is green on a
repeat loop (≥8×), and this verdict flips to **✅ SHIP**. Everything else in Sprint 5 is already
there.
