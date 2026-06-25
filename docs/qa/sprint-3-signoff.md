# Sprint 3 — Phase A QA Sign-off (Observability v2)

> QA: Ivy · Date: 2026-06-24 · Branch under test: `feature/sprint-3` @ `c8663cb`
> (even with `main`; Phase A merged via PR #44 — commits `2274da4` #36, `500f5ef` #37,
> `b4e2015` #38; `c8663cb` is the design-only #39 spike) · Node v24.16.0 · pnpm 11.8.0

## Verdict: ✅ SHIP WITH FOLLOW-UPS

Phase A — Observability v2 — is solid. All four quality gates are green on the merged
tree, every new dashboard surface behaves as specified, the snapshot contract is
**strictly additive** (an older-daemon snapshot renders byte-for-byte like the Sprint 2
dashboard — new panels simply absent), and the dashboard degrades gracefully against
every malformed/empty/HTTP-error/refused input I threw at it without a single crash.

**No blockers.** One **minor** cosmetic defect filed (#45): the EVENTS feed's relative-time
column is one character too narrow, so events older than 60s wrap "ago" onto a second
line. It does not affect correctness, data honesty, or stability and does not gate
Sprint 3 close-out.

> Scope note: Phase B (durability — #40–#42) is **not built** (deferred to Sprint 4 per the
> #39 spike recommendation) and was therefore **not** tested. This sign-off covers Phase A
> (#36/#37/#38) + confirms the #39 spike is design-only (no `src/**` or `test/**` touched).

---

## Gates (clean run on the merged tree)

| Gate      | Command                           | Result  | Evidence                                                                         |
| --------- | --------------------------------- | ------- | -------------------------------------------------------------------------------- |
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) | ✅ PASS | exit **0**                                                                       |
| Lint      | `pnpm lint` (`biome check .`)     | ✅ PASS | "Checked **95 files** … No fixes applied", exit **0**                            |
| Test      | `pnpm test` (`vitest run`)        | ✅ PASS | **263 passed / 263**, **23 files**, exit **0** (matches progress.md "263 (+17)") |
| Build     | `pnpm build` (`tsup`)             | ✅ PASS | `dist/cli/main.js` 109.12 KB + `dist/cli/dashboard.js` 30.47 KB, exit **0**      |

New/affected test files all green: `recent-events.test.ts` (8), `live-activity.test.ts` (4),
`snapshot-enrichment.test.ts` (5), `dashboard/view-model.test.ts` (29),
`dashboard/snapshot-client.test.ts` (10), `dashboard/render.test.tsx` (8).

---

## Live dashboard verification

I ran the **built** `dist/cli/dashboard.js` against a loopback HTTP fake serving crafted
`/api/v1/state` bodies (the same defensive-fake approach as prior smokes), capturing the
rendered Ink frames. Findings against the Phase-A acceptance points:

| #   | Check                                                            | Result  | What I saw                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | EVENTS feed newest-first, glyph+colour by level/kind             | ✅ PASS | Wire is newest-last → rendered newest-first. `started ▶` cyan, `completed ✓` green, `killed ✗` red, `retry_scheduled ⏳` yellow, unknown-kind/info `·` muted, warn fallback `⚠`. Identifier prefix + truncated message present.                                                                |
| 2   | Per-running `↳` last-activity line, omitted when absent          | ✅ PASS | Running row **with** `last_activity` showed `↳ TurnCompleted · 3s ago`; a sibling running row **without** activity cleanly omitted the line (no fake "0s", no `undefined`).                                                                                                                    |
| 3   | RECENTLY FINISHED rich list, distinct from IDs-only COMPLETED    | ✅ PASS | `RECENTLY FINISHED` shows `identifier + outcome(coloured) + relative finished-at`, newest-first; the authoritative `COMPLETED (n)` IDs-only summary (`i-004 i-003 …`) is unchanged and still present.                                                                                          |
| 4   | Retry HONEST wall-clock due time, no monotonic leak              | ✅ PASS | Retry row showed `due HH:MM:SSZ` computed from `scheduled_at + delay_ms` (UTC). **Not** a live countdown; the monotonic `due_at_ms: 99999` never appeared. Older-daemon retry (no `scheduled_at`/`delay_ms`) correctly omits the due cell.                                                     |
| 5   | `--ascii` glyph swap                                             | ✅ PASS | `▶→>`, `↳→-`, `⏳→~`, `✓→+`, `✗→x`.                                                                                                                                                                                                                                                            |
| 6   | `NO_COLOR` / non-TTY → plain (no ANSI colour)                    | ✅ PASS | Non-TTY (piped) render emitted no colour. `shouldUseColor` (glyphs.ts:76) checks `NO_COLOR` **first** → `NO_COLOR=1` always yields plain; unit-tested in `glyphs.test.ts`.                                                                                                                     |
| 7   | **Backward-safety:** older-daemon snapshot renders like Sprint 2 | ✅ PASS | A snapshot omitting all new fields rendered exactly the Sprint 2 layout — EVENTS, RECENTLY FINISHED, `↳`, and the retry due cell all **absent**; no crash, no `undefined`. `optArray`/optional parsers default cleanly.                                                                        |
| 8   | Resilience: malformed / empty / non-JSON / HTTP 500 / refused    | ✅ PASS | Each surfaced a typed error banner under `status connecting`, panels empty, **no crash**, clean SIGTERM exit: `malformed snapshot: expected string at "workspace_path"`, `Unexpected end of JSON input`, invalid-JSON token error, `snapshot API returned HTTP 500`, `fetch failed` (refused). |
| 9   | CLI dispatch + arg validation                                    | ✅ PASS | `orchestra dashboard --help` (via `main.js`) and standalone `dashboard.js --help` print usage, exit **0**; `--port 0` → `--port must be an integer in 1..65535` exit **1**; `--wat` → `unknown option` exit **1**.                                                                             |
| 10  | No regression to Sprint 2 dashboard / snapshot contract          | ✅ PASS | Existing fields byte-compatible; `completed` stays IDs-only; the older-daemon render is identical to Sprint 2. Full suite green.                                                                                                                                                               |

---

## Issues filed

| #                                                             | Severity  | Area          | Title                                                                                                                  |
| ------------------------------------------------------------- | --------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [#45](https://github.com/martinthommesen/orchestra/issues/45) | **minor** | observability | EVENTS feed relative-time column (`width={9}`) wraps `"Xm YYs ago"` (10 chars) onto a second line for events ≥ 60s old |

No `severity:*` labels exist on the repo (as in Sprint 1); severity is encoded in the
title/body, with `bug` + `area:observability` applied.

### #45 detail (minor, cosmetic)

`EventRow` (`components.tsx:~169`) renders the relative time in `<Box width={9}>`, but
`toViewModel` can emit up to `"Xm YYs ago"` = 10 chars once an event ages past one minute,
so Ink wraps `ago` to its own indented line. Data is correct and honest; only the layout
breaks. Deterministically reproduced with an event `emitted_at` > 60s in the past. Suggested
fix (for the dev team) noted in the issue: widen the column or shorten the label.

---

## What I exercised (beyond reading the code)

- **Gates** — ran typecheck / lint / test / build on the merged tree; all exit `0`.
  Test count confirmed **263/263 across 23 files**; lint **95 files**.
- **Live dashboard smokes** — built `dist/cli/dashboard.js` driven against a loopback
  fake `/api/v1/state` across scenarios: full enriched snapshot, older-daemon shape (no
  new fields), `--ascii`, `NO_COLOR`/non-TTY, plus malformed (missing required field),
  `{}`, empty body, non-JSON body, HTTP 500, and connection-refused. Captured and inspected
  the rendered Ink frames each time.
- **Honesty checks** — verified the retry due time is wall-clock (`scheduled_at + delay_ms`,
  UTC) and that the monotonic `due_at_ms` (`99999` sentinel) never leaks to the UI; verified
  `↳` activity and the activity line omit cleanly (no fake "0s") when absent.
- **CLI** — `--help` (dispatcher + standalone) exit 0; `--port 0` and unknown-flag exit 1.
- **Spike scope** — confirmed #39 is design-only: `git status` clean, no `src/**`/`test/**`
  changes in `c8663cb`.

No source files, git state, or commits were modified by QA (verified `git status` clean
before and after; the only change is this sign-off doc + GitHub issue #45).

---

## Out of scope (not tested)

- **Phase B durability (#40–#42)** — not built; deferred to Sprint 4 per the #39 spike.
  No persistence / restart / resume behaviour exists to exercise.
- **Real-repo + real Copilot run** — an operator step (cost/noise); the Sprint 1 runbook
  still applies. Not run.
