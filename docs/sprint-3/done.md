# Sprint 3 — Done (Observability v2 + Durability Spike)

Handoff for the Producer. See `plan.md` for the original scope, `progress.md` for the
phase-by-phase log, and `durability-spike.md` for the Phase B design.

## Summary

Sprint 3 shipped **Phase A — Observability v2** (a strictly-additive upgrade to the
Sprint 2 dashboard) plus the **#39 blocking durability design spike**. At the #39 gate the
Producer + user decided to **roll the Phase B durability build (#40–#42) to Sprint 4**
rather than rush ~5–7 days of high-risk core surgery at sprint-end.

- **Closed this sprint:** #36, #37, #38, #39, #45.
- **Carried to Sprint 4:** #40, #41, #42, #43 (the durability build-out + its tests/docs).

## What shipped — Phase A (Observability v2)

The loopback snapshot (`GET /api/v1/state`) and the `orchestra dashboard` now surface a
live **event feed**, per-session **agent activity**, and **rich completion/retry** data —
all **strictly additive**. An older daemon that omits the new fields renders exactly like
the Sprint 2 dashboard (asserted by view-model _and_ render tests).

| #   | Issue                             | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #36 | RecentEvents ring + tee observer  | `src/core/observability/recent-events.ts` — Ref-backed ring (cap 200, monotonic `seq`, TestClock-deterministic ISO `emitted_at`). `observer-tee.ts` wraps `ObserverLive`: logs byte-for-byte unchanged AND appends a display-safe draft; high-volume `AgentEvent` + loop-cadence ticks are dropped so they can't drown the feed. (`2274da4`)                                                                                                                                                        |
| #37 | Snapshot enrichment (additive)    | `LiveActivity` (per-issue last activity, cap 256) + `RecentCompletions` (rich finished ring, cap 50) services. `toSnapshot` now emits `recent_events`, `recent_completed`, `running[].last_activity`, and retry `scheduled_at`+`delay_ms`. Existing fields byte-compatible (`completed` IDs-only; monotonic `due_at_ms` unchanged). Exactly **two** sanctioned `loop.ts` edits. (`500f5ef`)                                                                                                         |
| #38 | Dashboard panels                  | New Ink panels: live **EVENTS** feed (newest-first, glyph+colour by level/kind), per-running `↳` last-activity line, **RECENTLY FINISHED** rich list, and an honest wall-clock retry "due" time. Reuses `glyphs.ts`; honours `--ascii`/`NO_COLOR`; panels omit themselves when their data is absent. Pure client work — no `src/core/**`. (`b4e2015`)                                                                                                                                               |
| #45 | EVENTS column wrap (QA follow-up) | Relative-time column wrapped `ago` for events ≥60s old. Root-caused two layers: the 11-char worst-case label, _and_ an **unbounded** `formatDuration` hour tier. Fix: clamped `formatDuration` to a `99h 59m 59s` ceiling (bounds every width-constrained label incl. running `elapsed`) and replaced the magic `9` with a derived `EVENTS_RELATIVE_TIME_COLUMN_WIDTH = RELATIVE_LABEL_MAX_WIDTH(11) + 1`. Layout-only; +3 tests including a width-invariant sweep so it can't regress. (`eff891a`) |

### Honest rendering (the invariant we keep)

- **retrying** shows a wall-clock `due HH:MM:SSZ` derived from `scheduled_at + delay_ms`;
  the monotonic `due_at_ms` is **never** turned into a countdown and never leaks to the UI.
- **last_activity** → `"<event_tag> · <rel> ago"`, or omitted (no fake "0s") when absent.
- **RECENTLY FINISHED** (rich: identifier + relative finished-at + outcome colour) is kept
  visually distinct from the authoritative IDs-only **COMPLETED (n)**, which is unchanged.
- All glyphs/colours reuse the `glyphs.ts` design system; `--ascii` swaps glyphs and
  `NO_COLOR`/non-TTY render plain.

## #39 — Durability design spike (design only)

`docs/sprint-3/durability-spike.md` (501 lines): current-state analysis with file:line
cites, a buildable design for #40–#42, and a per-issue risk/effort sizing. **No `src/**`or`test/**` changed** (`c8663cb`). Headline decisions that set up Sprint 4:

- **Observability rings are NOT persisted** (boundary integrity; `LiveActivity` mutates on
  every agent event and would thrash the writer; post-restart history is cosmetic because
  the authoritative `completed`/counts/totals _are_ restored). On boot they start empty and
  emit one synthetic "restored after restart" event so the gap is honest.
- **Orphaned running issues** reduce to existing machinery: convert each to a
  **due-immediately continuation retry**, so it rides the already-tested
  retry-rearm + reconcile + dispatch path. The **workspace on disk (git tree) is the true
  record of progress** — session resume is an optional, self-healing optimization (default off).
- **Retry re-arm derives from WALL-CLOCK** `scheduled_at + delay_ms`, never the monotonic
  `due_at_ms` (its origin dies with the process). The central trap, made explicit.
- Versioned `Schema.parseJson` payload, atomic temp+rename, single debounced writer with a
  guaranteed shutdown flush, corruption → rename-aside + clean start (never crash). Snapshot
  stays additive — no `/api/v2`.

## Phase B decision — rolled to Sprint 4

Sizing: **~5–7 days** of deep core work whose centre of gravity (#41 orphan reconcile +
boot-ordering idempotency) is exactly the scenario-heavy surgery that must not be rushed at
sprint-end — rushing it risks the stranded/duplicated-issue failure durability exists to
prevent. The spike de-risked the _design_; the _build_ gets a clean Sprint 4. See
`docs/sprint-4/plan.md`.

## QA sign-off (Ivy)

**Verdict: SHIP WITH FOLLOW-UPS — no blockers** (`docs/qa/sprint-3-signoff.md`). Gates
re-verified green; live dashboard exercised against a loopback fake (event feed, activity,
rich completed, honest retry due, `--ascii`/`NO_COLOR`, older-daemon backward-safety,
malformed/empty/500/refused resilience — zero crashes). One minor cosmetic bug filed (#45)
— **fixed before close**.

## Gates (final, on the close branch)

`pnpm typecheck` ✅ 0 · `pnpm lint` ✅ 95 files · `pnpm test` ✅ **266 passed** (was 224 at
Sprint 2 end) · `pnpm build` ✅. CI verified green on Node 22 + 24 + CodeQL + Socket for the
Phase A merge (PR #44).

## Files changed / created (Sprint 3)

**New (services):** `src/core/observability/{recent-events,observer-tee,live-activity,recent-completions}.ts`.
**Modified (core, additive only):** `src/core/observability/{live-observer,snapshot-server}.ts`,
`src/core/orchestrator/loop.ts` (exactly two sanctioned edits), the `RetryEntry` schema,
`src/cli/daemon.ts` (layer wiring).
**Dashboard (client):** `src/cli/dashboard/{snapshot-client,view-model,components}.tsx/.ts`.
**Tests:** `test/recent-events.test.ts`, `test/snapshot-enrichment.test.ts`, expanded
`test/dashboard/{view-model,render,fixtures}` suites.
**Docs:** `docs/sprint-3/{plan,progress,done,durability-spike}.md`,
`docs/qa/sprint-3-signoff.md`, `docs/sprint-4/{plan,progress}.md`, `PROJECT_BRIEF.md` §7/§8.

## How to run / verify

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # all exit 0; 266 tests

# Live, two terminals:
pnpm dev ./WORKFLOW.md --port 4317   # daemon + enriched snapshot API
orchestra dashboard                  # (or: pnpm dev:dashboard) live view w/ event feed
```

## Handoff to Sprint 4

Durability is fully designed and gated — start from `docs/sprint-3/durability-spike.md` and
`docs/sprint-4/plan.md`. Build order: **#40 persistence → #41 restore+reconcile+re-arm
(the risky one) → #42 session continuity → #43 tests+docs**. Keep the snapshot contract
additive and the core-loop edits minimal, exactly as Phase A did.
