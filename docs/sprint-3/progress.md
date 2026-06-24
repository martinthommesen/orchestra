# Sprint 3 — Progress

Branch: `feature/sprint-3` (from `main` @ 5f31f76). Identity: martin-lammetun.thommesen@telenor.no.

## Task board
| # | Phase | Task | Status |
|---|-------|------|--------|
| 36 | A | RecentEvents ring-buffer service + tee Observer | pending |
| 37 | A | Snapshot enrichment (additive fields) | pending |
| 38 | A | Dashboard event-log + activity + rich completed | pending |
| 39 | B | **BLOCKING** durability design spike | pending |
| 40 | B | Persistence layer (versioned, atomic, debounced) | pending |
| 41 | B | Restore + reconcile on boot + retry re-arm | pending |
| 42 | B | Session continuity (persist session_id / resume) | pending |
| 43 | C | Tests + docs + handoff | pending |

## Sequencing
- Phase A (#36→#37→#38) runs first — additive, low risk.
- #39 is a blocking gate for Phase B; STOP after the spike for Producer review.
- At the #39 gate, decide with the user whether #40–#42 fit Sprint 3 or roll to Sprint 4.

## Decisions
- Scope: all four user themes — durability=full worker/retry resume, log-tailing=event feed.
- Snapshot stays additive on `/api/v1/state` (no v2; Sprint 2 dashboard unaffected).
- Events live in a separate `RecentEvents` service (not in OrchestratorState); fan-out via
  an explicit tee Observer (Observer is a single Tag, not a bus).
- Retry wall-clock comes from `scheduled_at`+`delay_ms` captured at schedule time, never
  derived from the monotonic `due_at_ms`.

## Risks
- Phase B is real core surgery (orphaned running fibers, monotonic→wall-clock retries,
  session resume, atomic persistence). De-risked via the #39 spike gate.
- Re-opening the snapshot contract — mitigated by strict additivity + the defensive parser.

## Notes
- (updated as work lands)
