# Sprint 5 — Done (Operator Experience)

Handoff for the Producer. See `plan.md` for the original scope, `progress.md` for the
phase-by-phase log.

## Summary

Sprint 5 turns to the **operator**: making agent spend controllable and the daemon's
behavior legible at a glance, without touching the core dispatch/retry/persistence
semantics any more than a single additive guard requires. Three independent features plus
this close-out. The snapshot contract stayed **strictly additive** (no `/api/v2`), and only
#53 touched the dispatch path — as a pure pre-`planDispatch` guard, no new kill paths.

- **Closed this sprint:** #53, #54, #55, #56.

## What shipped

| # | Issue | Outcome |
|---|-------|---------|
| #53 | Budget guardrails | Additive optional `budget.max_total_tokens` config (`Schema.optionalWith`, all-defaults). New pure `evaluateBudget`/`BudgetStatus` (`src/core/orchestrator/budget.ts`) — no IO, no state. In `handleTick`, a pre-`planDispatch` guard: `const toDispatch = budget.paused ? [] : planDispatch(...)`, pausing **new** dispatch at the token ceiling while in-flight workers, retries, and reconcile are provably untouched. A runtime `budgetPaused` latch emits `BudgetExceeded` once per transition (rendered in feed + logfmt). Strictly-additive snapshot `budget` block (present only when configured) + dashboard `BUDGET` panel. (`9d429ea`) |
| #54 | Durability/restore visibility | Promoted #41's one-shot `RestoredAfterRestart` fact to a durable, display-only signal. New set-once `RestoreStatus` context service (`src/core/observability/restore-status.ts`, same family as `LiveActivity`/`RecentCompletions`) holding an immutable `RestoreSummary`, written **once** by the loop at boot on the same path that emits `RestoredAfterRestart` (cold start → never recorded → field omitted). Strictly-additive snapshot `restore` block + dashboard `RESTORED` indicator (`⟳ restored after restart · n running · n retrying · n completed · restored Xs ago`). No scheduling change — #41's restore stays byte-identical. (`baf2549`) |
| #55 | Humanized agent-event summaries | New pure `humanizeAgentEvent` (`src/core/observability/humanize.ts`) — total, never-blank, mapping each `AgentEvent` tag to a friendly one-liner via a `Record<AgentEventTag, string>` table (a new union variant trips a **compile** error; unknown tags fall back to the raw label). Wired at the two surfaces where agent events appear: the logfmt line (`live-observer.ts`) and per-session `LiveActivity.message` (`observer-tee.ts`), which flows onto `running[].last_activity` and is preferred over the raw tag in the dashboard. Maps by tag only — never echoes agent payload text. Deliberately **not** pushed into `recent_events` (per-turn chatter would flood the feed). (`785ad04`) |
| #56 | Tests + docs + handoff | Cross-feature coverage audit/fill (3 genuinely new co-occurrence cases, see below), README (`budget` config + operator-visibility section), this close-out, `progress.md` close record, `PROJECT_BRIEF.md` §7/§8. |

## Key design decisions (so a future sprint doesn't regress them)

- **The budget gate is a pure pre-`planDispatch` read (#53).** The *only* behavioral change
  is one line withholding the fresh-dispatch list when paused. It does **not** modify
  concurrency/retry math or reconcile, and it gates only `handleTick`'s fresh dispatch loop
  — retries/continuations re-dispatch through the **separate** `handleRetryDue` path the
  guard never reads. Keep budget evaluation pure and out of the worker/reconcile paths.
- **Additive-only snapshot strategy across all three features.** Every new wire field
  (`budget`, `restore`, the humanized `last_activity.message`) is emitted **only when
  applicable** and absent otherwise, so a pre-Sprint-5 dashboard renders identically — no
  `/api/v2`. The cross-feature test pins that a cold start carries **none** of them.
- **Set-once `RestoreStatus` context service (#54).** The boot-time restore fact is
  *runtime data computed after the snapshot fiber starts*, so it must be a shared Ref-backed
  context service (not a closed-over value like the static budget config). `record` is
  set-once (`prev ?? summary`) so the first boot capture is immutable.
- **Compile-checked humanizer table (#55).** Typing the summary map as
  `Record<AgentEventTag, string>` means adding an `AgentEvent` variant without a summary is a
  type error — no silent miss. Map by **tag only**, never payload, so a summary can't leak
  issue content into logs/snapshot (BRIEF §9.2).
- **Deliberate non-flooding of `recent_events` (#55).** AgentEvents stay dropped from the
  lifecycle feed (`toEventDraft` → `null`); the humanizer lives at the existing AgentEvent
  surfaces (logfmt + `LiveActivity`). Re-adding per-turn chatter to the feed would be a
  regression.

## #56 — coverage audited + added

Audited the three shipped suites as a whole. The per-feature tests are complete **in
isolation** — but each only ever sets a **single** additive extra on `toSnapshot` / a single
dashboard panel, so the **interactions** were the genuine gap. Added one focused file,
`test/cross-feature.test.ts` (**3 tests**), with no assertion that duplicates a per-feature
suite:

1. **All three additive blocks at once on one snapshot.** A budget-paused daemon that ALSO
   booted on a restored checkpoint with a running issue reporting a humanized last activity
   — `budget` + `restore` + `running[].last_activity.message` all present, correctly shaped,
   non-interfering, and JSON round-tripping. (The issue's first example.)
2. **Cold-start older-dashboard safety, asserted together.** A bare projection (unconfigured
   budget, never restored, no observed activity) carries **none** of the new blocks —
   `budget`/`restore` absent and `last_activity` undefined in one place. The per-feature
   tests each assert one absence; this pins the simultaneous contract.
3. **Full dashboard decode of a fully-loaded snapshot.** A single raw wire body carrying all
   three additions → `parseSnapshot` → `toViewModel` populates the `budget`, `restore`, and
   humanized last-activity panels together (message derived from the real humanizer table, so
   the path is end-to-end raw-bytes → VM). (The issue's second example.)

Everything else the issue floated was already covered and **not** duplicated: the budget
evaluator/gate (`budget-pure`, `budget-gate`), the set-once holder + real-loop capture
(`restore-pure`, `restore-reconcile`), the humanizer table + fallback (`humanize`), and each
panel's parse/render in isolation (`dashboard/*`).

## Gates (final, on `feature/sprint-5`)

`pnpm typecheck` ✅ 0 · `pnpm lint` ✅ 109 files · `pnpm test` ✅ **336 passed** (333 at
sprint feature-merge: +3 cross-feature, 0 regressions) · `pnpm build` ✅.

Per-feature contributions to the count: +17 #53 (312), +13 #54 (325), +8 #55 (333), +3 #56
(336).

## Files changed / created (Sprint 5)

**New (core/observability):** `src/core/orchestrator/budget.ts` (#53),
`src/core/observability/restore-status.ts` (#54), `src/core/observability/humanize.ts` (#55).
**Modified (core, additive only):** `src/core/orchestrator/loop.ts` (budget gate + latch;
restore capture), `src/core/orchestrator/observer.ts` (`BudgetExceeded`),
`src/core/observability/{recent-events,live-observer,observer-tee,live-activity,snapshot-server}.ts`,
`src/core/domain/workflow.ts` (`BudgetConfig`), `src/cli/daemon.ts` (snapshot-server budget arg
+ `RestoreStatusLive`).
**Dashboard:** `src/cli/dashboard/{snapshot-client,view-model,components.tsx}` (budget/restore
parse + VM + panels; humanized last-activity preference).
**Tests:** `test/budget-{pure,gate}.test.ts`, `test/restore-pure.test.ts`,
`test/humanize.test.ts`, `test/cross-feature.test.ts` (new); additions to
`test/{live-observer,recent-events,restore-reconcile,snapshot-server}.test.ts` and
`test/dashboard/{snapshot-client,view-model,render}.test.ts`; `test/fakes/harness.ts`
(`budgetMaxTotalTokens` knob + `RestoreStatusLive`).
**Docs:** `docs/sprint-5/{progress,done}.md`, `README.md` (Budget guardrails + Operator
visibility sections + `budget` config table), `PROJECT_BRIEF.md` §7/§8.

## How to run / verify

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # all exit 0; 336 tests

# Budget in practice — add to WORKFLOW.md and run with a snapshot port:
#   budget:
#     max_total_tokens: 100000
pnpm dev ./WORKFLOW.md --port 4317
# Once cumulative agent spend reaches the ceiling, new dispatch pauses (in-flight work
# finishes); the snapshot's `budget` block and the dashboard BUDGET panel show `paused`.
# Restart the daemon on a non-empty checkpoint → the snapshot `restore` block + dashboard
# RESTORED indicator appear; a cold start shows neither. Agent activity reads in plain
# language on each running issue's last-activity line.
```

## Follow-ups / carry-forwards (candidates for a future sprint)

- **Runtime budget-resume latch is unreachable in production (honest quirk, #53).** Spend
  only grows and config is loaded once, so a paused budget resumes only via a future
  config-reload feature that raises the ceiling. The latch still handles resume correctly and
  cheaply and is covered by the exhaustive observation-render tests, so the code stays honest
  if such a feature lands. (Pairs naturally with the still-deferred WORKFLOW.md hot-reload.)
- **Optional USD budget ceiling intentionally deferred (#53).** Only `max_total_tokens`
  shipped. The cost knob (`max_cost_usd` + `usd_per_million_tokens`) is a clean,
  separately-addable concrete follow-up; the token ceiling fully delivers the headline
  behavior and keeps the review-gated dispatch-path change minimal.
- **Live-Copilot `--resume` across downtime still unproven (carried from Sprint 4).**
  `persistence.resume_sessions` is default-off and self-healing; enabling it for real
  workloads still needs an integration validation that Copilot honors `--resume` across
  daemon downtime (today only the fake-agent self-heal path is tested). Restore visibility
  (#54) surfaces *that* a restore happened — it does not validate session resume itself.
- **Schema migration is still V1-only** (the `migrateToCurrent` seam awaits its first real
  bump), and the snapshot/dashboard remain **read-only** — no control plane, auth, or metrics
  export.
