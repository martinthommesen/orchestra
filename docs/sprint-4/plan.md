# Sprint 4 — Durable Orchestrator (Phase B build-out)

Carried over from Sprint 3, where the **#39 durability design spike** produced a complete,
buildable design and the Producer + user chose to roll the *build* into its own sprint
rather than rush it at sprint-end. **`docs/sprint-3/durability-spike.md` is the design of
record for this sprint — read it first.**

## Goal
Make Orchestra survive a daemon restart: bookkeeping is intact and in-flight work is
correctly resumed or safely re-derived (no stranded or duplicated issues); a
corrupt/missing state file yields a clean start, never a crash.

## Non-negotiable constraints (carried from Sprint 3)
1. **Snapshot stays strictly additive** on `/api/v1/state` — no `/api/v2`; the Sprint 2/3
   dashboard parser keeps working unchanged.
2. **Persistence is safe:** versioned schema, atomic write (temp + rename), corruption →
   clean start (never crash the daemon on a bad state file).
3. **Retry re-arm derives from WALL-CLOCK** (`scheduled_at + delay_ms`), never the monotonic
   `due_at_ms` (its origin resets per process).
4. **Observability rings are NOT persisted** — they start empty on boot; emit one synthetic
   "restored after restart" event so the gap is honest.
5. Keep core-loop edits minimal and reviewed, as Phase A did.

## Tasks (from the spike; full design in `durability-spike.md`)

- **#40 — Persistence layer.** `Persistence` service (`Context.Tag`) over `@effect/platform`
  `FileSystem`: versioned `Schema.parseJson(PersistedStateV1)` codec (ISO Date round-trip,
  forward-only migration), atomic temp+rename, single scoped debounced writer (default 500 ms)
  signalled from the store mutator chokepoint with a guaranteed final flush, corruption →
  rename-aside + clean start. A transparent `layerDurableOrchestratorStore` decorator swaps
  in for `layerOrchestratorStore` in `daemon.ts` so `loop.ts`/`snapshot-server.ts` need no
  edits. _Effort M · Risk Low–Med._
- **#41 — Restore + reconcile on boot + retry re-arm.** _The risky core surgery._ On startup:
  load the checkpoint, seed state, rebuild the runtime registry; **convert each orphaned
  `running` issue → a due-immediately continuation retry** (rides the existing
  retry/reconcile/dispatch path — reconcile gates terminal/vanished so there's no
  double-dispatch); **re-arm retries from wall-clock**; then run normal tracker reconciliation.
  Emit a `RestoredAfterRestart` observation. Watch boot-ordering idempotency. _Effort H · Risk High._
- **#42 — Session continuity.** Persist `session_id` (+ `turn`, `failure_attempts`, retry
  `kind`) additively on `RunAttempt`/`RetryEntry`; thread `session_id` into the continuation
  dispatch `resume`; gate best-effort resume behind `persistence.resume_sessions` (default
  **off** = fresh session, since the workspace-on-disk carries progress and Copilot session
  liveness across downtime is unverified). Schema work folds into #41. _Effort S–M · Risk Med (Low if default-off)._
- **#43 — Tests + docs + handoff.** State round-trip property test (encode/decode fixed
  point), restore/reconcile scenario tests (orphan active/terminal/vanished, due/future retry,
  both kinds, corrupt file → clean start), wall-clock re-arm under `TestClock`. Docs:
  `docs/sprint-4/done.md`, README durability section, `PROJECT_BRIEF.md` §7/§8. _Effort M · Risk Low._

## Dependencies
`#41 → #40` · `#42 → #41` · `#43 → all`.

## Success criteria
- Kill the daemon mid-run and restart → bookkeeping intact, in-flight work resumed or safely
  re-derived (no stranded/duplicated issues); corrupt/missing state file → clean start.
- `/api/v1/state` still strictly additive; Sprint 2/3 dashboard unaffected.
- All gates 0; core-loop changes minimal and reviewed; no regression in the existing suite.

## Risk note
#41 is the centre of gravity. Land #40 + minimal restore first to de-risk persistence, then
the orphan→continuation reconcile and wall-clock re-arm with heavy scenario coverage before
session resume. The spike already reduces orphan handling to existing, tested machinery —
keep it that way; do not add bespoke orphan-dispatch code.
