# Sprint 3 — Progress

Branch: `feature/sprint-3` (from `main` @ 5f31f76). Identity: martin-lammetun.thommesen@telenor.no.

## Task board
| # | Phase | Task | Status |
|---|-------|------|--------|
| 36 | A | RecentEvents ring-buffer service + tee Observer | ✅ done (2274da4) |
| 37 | A | Snapshot enrichment (additive fields) | ✅ done |
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

### #36 — RecentEvents ring + tee Observer (done, 2274da4)
- New `src/core/observability/recent-events.ts`: `RecentEvents` service (Ref-backed ring,
  cap 200, monotonic 1-based `seq`, wall-clock ISO `emitted_at` from Effect's clock so it
  is TestClock-deterministic). Pure `toEventDraft(Observation)` → display-safe draft;
  **drops** `AgentEvent` (high-volume per-turn chatter) + `TickStart`/`TickEnd`/`Reconciled`
  (loop cadence) so they can't drown the feed (constraint #3). Message truncated at
  ingestion (`EVENT_MESSAGE_MAX = 160`).
- New `src/core/observability/observer-tee.ts`: `observerTee` wraps the live observer —
  logs via the extracted `logObservation` (byte-for-byte unchanged) AND appends a draft.
  `ObservabilityLive` bundles tee + ring (shared instance via `Layer.provideMerge`).
- `live-observer.ts`: extracted `logObservation`; `daemon.ts`: `ObserverLive` →
  `ObservabilityLive`.
- Gates: typecheck/lint/build 0; tests 237 (+8). Full suite green.

### #37 — Snapshot enrichment, strictly additive (done)
- New `live-activity.ts` (`LiveActivity` service): per-issue last agent activity
  `{event_tag, at, message?}`, fed by the tee from `AgentEvent` observations, bounded
  (cap 256, oldest-touch evicted). Read by the snapshot server, merged onto matching
  `running[]` entries only.
- New `recent-completions.ts` (`RecentCompletions` service): rich finished-issue ring
  `{issue_id, identifier, finished_at, outcome}` (cap 50, newest-last). Loop-fed at the
  two `markCompleted` sites (`outcome:"completed"` natural / `"killed"` terminal); kept
  OUT of the authoritative IDs-only `completed` list.
- `observer-tee.ts`: extended to also write `LiveActivity` on `AgentEvent`. `RetryEntry`
  schema gains optional `scheduled_at` (Date) + `delay_ms` (Int), captured at the
  `setRetry` site so the dashboard can show an HONEST wall-clock retry time; monotonic
  `due_at_ms` retained, never used for a countdown.
- `snapshot-server.ts`: `toSnapshot(state, extras?)` now also emits `recent_events`,
  `recent_completed`, `running[].last_activity`; existing fields byte-compatible
  (`completed` IDs-only, `due_at_ms` unchanged). `runSnapshotServer` reads the three
  services. `daemon.ts` provides `RecentCompletionsLive` (one shared instance) alongside
  `ObservabilityLive` (which owns the shared `RecentEvents`+`LiveActivity`).
- **loop.ts surgery = exactly the two sanctioned edits** (retry timing capture +
  rich-completion record). `last_activity` is captured by the tee/observer path, NOT in
  the loop — this is how #37's last_activity reconciles with constraint #5's "only two
  loop changes".
- Gates: typecheck/lint/build 0; tests 246 (+9). Full suite green.
