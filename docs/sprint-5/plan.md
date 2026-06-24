# Sprint 5 — Operator Experience

With the orchestrator now durable (Sprint 4), Sprint 5 turns to the operator: making spend
controllable and the daemon's behavior legible at a glance. Three independent, mostly-additive
features plus a close-out.

## Goal
Let an operator **manage the work** with confidence: cap agent spend before it runs away, see a
post-restart resume at a glance, and read what agents are doing in plain language — without
touching the core dispatch/retry semantics any more than a single additive guard requires.

## Constraints (carried forward)
1. **Snapshot stays strictly additive** on `/api/v1/state` — no `/api/v2`; older dashboards keep
   working, absent fields → panel omitted.
2. **Never kill in-flight work for a budget.** A budget pauses *new* dispatch only; running
   workers finish and reconcile normally.
3. **Display-only stays display-only.** Restore visibility and humanized summaries change no
   dispatch/retry/persistence behavior.
4. No secrets in logs, feed, or snapshot.

## Tasks

- **#53 — Budget guardrails.** Additive optional `budget` config (a token ceiling at minimum;
  optional configured USD ceiling). In `handleTick`, before `planDispatch`: when cumulative
  `agent_totals` spend ≥ ceiling, **pause new dispatch** (in-flight workers untouched) and emit a
  dispatch-paused observation once per transition. Additive budget status on the snapshot + a
  dashboard budget indicator. _Effort M · Risk Med (additive dispatch guard, no kills)._
- **#54 — Durability/restore visibility.** Promote #41's one-shot `RestoredAfterRestart` data to
  an additive snapshot `restore` field (null on cold start) and a dashboard restore indicator
  (`⟳ restored after restart at HH:MM:SSZ (n running, n retrying, n completed)`). _Effort S–M ·
  Risk Low._
- **#55 — Humanized agent-event summaries.** A pure humanizer mapping agent-event tags (and short
  sequences) → friendly one-line summaries, wired into the `recent_events` feed, the logfmt line,
  and the dashboard EVENTS panel; unknown tags fall back to the raw label. Display-only. _Effort M
  · Risk Low._
- **#56 — Tests + docs + handoff.** Cross-feature coverage audit/fill, README (`budget` config +
  operator features), `docs/sprint-5/done.md`, `progress.md` close record, `PROJECT_BRIEF.md`
  §7/§8. _Effort M · Risk Low._

## Dependencies
`#53`, `#54`, `#55` are independent of each other. `#56 → all`.

## Build order
#53 first (the headline, the only one touching the dispatch path — gate it for review), then #54
and #55 (low-risk, additive), then #56 close-out. Total ~4–6 days.

## Success criteria
- A configured budget pauses new dispatch at the ceiling without killing running work, and the
  pause is visible on the snapshot + dashboard; clearing/raising the budget resumes dispatch.
- A restart shows a restore indicator on the dashboard; a cold start shows nothing.
- The event feed reads in plain language; unknown events never blank out.
- `/api/v1/state` stays strictly additive; all gates 0; no regression in the existing suite.

## Risk note
Only #53 touches the dispatch decision, and only as an additive pre-`planDispatch` guard — no new
kill paths, no change to concurrency/retry math. Keep the budget check pure and out of the
worker/reconcile paths.
