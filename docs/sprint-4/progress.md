# Sprint 4 — Progress

Branch: _(not yet created — `feature/sprint-4` off `main` once Sprint 3 close merges)_.
Design of record: `docs/sprint-3/durability-spike.md`.

## Task board
| # | Task | Status |
|---|------|--------|
| 40 | Persistence layer (versioned, atomic, debounced) | pending |
| 41 | Restore + reconcile on boot + retry re-arm | pending |
| 42 | Session continuity (persist session_id / resume) | pending |
| 43 | Tests + docs + handoff | pending |

## Carry-over context
- Rolled from Sprint 3 at the #39 gate (Producer + user decision): Phase A (Observability v2)
  + the durability spike shipped in Sprint 3; the Phase B *build* is this sprint.
- Full design, file:line current-state analysis, and per-issue sizing live in
  `docs/sprint-3/durability-spike.md`. Don't re-spike — build from it.

## Sequencing
- #40 first (self-contained, low risk) → #41 the risky core surgery (orphan reconcile +
  wall-clock re-arm + boot ordering) with heavy scenario tests → #42 session continuity
  (schema folds into #41) → #43 close-out.

## Notes
- (updated as work lands)
