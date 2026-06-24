# Sprint 4 — Progress

Branch: `feature/sprint-4` (off `main` @ `0e48363`).
Design of record: `docs/sprint-3/durability-spike.md`.

## Task board
| # | Task | Status |
|---|------|--------|
| 40 | Persistence layer (versioned, atomic, debounced) | ✅ done |
| 41 | Restore + reconcile on boot + retry re-arm | ✅ done |
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

### #40 — Persistence layer (done)
**Files created:**
- `src/core/persistence/persisted-state.ts` — versioned `PersistedStateV1 = { version, saved_at, state }`
  over the existing `OrchestratorState`. `Schema.parseJson(...)` codec (`encodePersisted`/`decodePersisted`)
  so `Date`s round-trip as ISO and decode is validated. **Forward-only migration seam**:
  `KnownPersisted` union + `migrateToCurrent` switch on the `version` discriminant — today V1-only
  (identity), with a 3-step doc-comment for adding V2 (no speculative V2 stub).
- `src/core/persistence/persistence.ts` — the `Persistence` service (`Context.Tag`) over
  `@effect/platform` `FileSystem`. `load` (missing→`none`, read-fail→log+`none`, corrupt→
  rename-aside `state.json.corrupt-<ts>`+log+`none`, **never throws**), `save` (atomic temp+rename,
  **total**: IO faults logged not raised, so the final flush can't fail teardown; serialized by a
  semaphore), `markDirty` (coalescing `Queue.sliding(1)`), `runWriter` (single `forkScoped` debounced
  loop: take→`sleep(debounce_ms)`→flush, + an `addFinalizer` **guaranteed final flush** registered
  before the fork so it runs after the writer is interrupted on scope close). `resolvePersistencePaths`:
  default `<workspace.root>/.orchestra/state.json`, debounce default 500 ms.
- `src/core/persistence/durable-store.ts` — `layerDurableOrchestratorStore(config)` transparent
  decorator: load→seed→wrap `update`/`modify` (mark-dirty after each)→`runWriter`. **Drop-in** for
  `layerOrchestratorStore`; `get`/`update`/`modify` semantics identical → `loop.ts`/`snapshot-server.ts`
  untouched. `seedState` is the #40/#41 boundary (below).
- `src/core/persistence/index.ts` — barrel.
- `test/persistence.test.ts` — 9 tests: codec fixed-point (§2.8, Dates equal as Dates) + corrupt-string
  `ParseError`; service save→load round-trip (no temp leftover); missing→`none`; corrupt→rename-aside
  +`none` (no throw); bookkeeping-only seed boundary; **debounce gating + final flush under `TestClock`**;
  `layerDurableOrchestratorStore` drop-in cold start.

**Files changed:**
- `src/core/domain/workflow.ts` — additive optional `persistence?: { dir?, debounce_ms (default 500) }`
  block on `ServiceConfig` (all-defaults → unchanged `WORKFLOW.md` still decodes; loader untouched, it
  spreads `...config`).
- `src/cli/daemon.ts` — `appLayer` swaps `layerOrchestratorStore` → `layerDurableOrchestratorStore`
  (its `FileSystem` comes from the ambient `NodeContext.layer` already at the program root).

**KEY DECISION — seed-vs-reconcile boundary (#40 restores BOOKKEEPING ONLY):**
The checkpoint persists the *whole* state (the writer saves live `store.get`, scheduling included), but
on restore #40 seeds only the **safe bookkeeping** — `completed`, `agent_totals`, `agent_rate_limits`,
and the config-derived knobs. The **scheduling slice** (`running`, `claimed`, `retry_attempts`) is reset
to empty with a `TODO(#41)` hook. Rationale: the loop builds reconcile/dispatch inputs from the in-memory
`registry`, which boots empty; seeding `running`/`retry_attempts` without #41's registry rebuild +
wall-clock re-arm + orphan→continuation reconcile would **strand** issues (a `running` entry with no
worker is never progressed and stays `claimed`; a `retry_attempts` entry with no re-armed timer never
fires) and risk the per-tick reconcile mishandling orphans. Bookkeeping gates nothing in dispatch
(`completed` is bookkeeping-only), so restoring it is 100% safe and immediately valuable (token totals +
completion history + correct counts survive a restart) while reproducing today's safe behaviour for the
scheduling slice (next tick re-selects active issues fresh) — **zero new double-dispatch risk**. This is
exactly the spike's §3 "safe, high-value slice". No `RunAttempt`/`RetryEntry` continuity fields added —
those belong to #41/#42 (kept minimal, non-speculative).

**Gates:** typecheck 0 · lint 0 · build 0 · **275 tests** (266 baseline + 9 new), full suite green.

### #41 — Restore + reconcile + retry re-arm on boot (done)
**Files changed:**
- `src/core/persistence/durable-store.ts` — **`seedState` replaced**: bookkeeping-only path +
  `TODO(#41)` hook deleted; now seeds the **complete** `OrchestratorState` (running / claimed /
  retry_attempts included). Reloadable knobs (`poll_interval_ms`, `max_concurrent_agents`) always
  come from the live config, never the (possibly stale) checkpoint. One coherent restore flow:
  this seed + the loop's reconcile.
- `src/core/orchestrator/loop.ts` — the one place #41 adds real loop code:
  - **`restoreFromCheckpoint`** (runs in `runOrchestrator` startup, after `Started`, before
    `startupCleanup` + first `Tick`): reads the seeded store, rebuilds the in-memory `registry`
    from `running`/`retry_attempts` (synthetic minimal `Issue` from persisted id/identifier;
    `restoredIssue`), **converts each orphaned `running` → a due-immediately `kind:"continuation"`
    retry** (`setRetry(clearRunning(...))`, `attempt = turn+1`, carries `turnCount`/`failureAttempts`
    from the persisted `RunAttempt`), **re-arms every pending retry from wall-clock**, and emits one
    `RestoredAfterRestart`. Returns a re-arm plan.
  - **`remainingWallMs`** — `fireInstant = scheduled_at.getTime() + delay_ms`,
    `remaining = max(fireInstant − Date.now(), 0)`. The monotonic `due_at_ms` is **never** read.
  - **`armRestoredRetry`** — forks the residual-delay timer, records `rec.timerFiber`.
  - **`dispatch`** now persists `turn`/`failure_attempts` on the `RunAttempt` at the existing
    `setRunning` site; **`scheduleRetry`** persists `kind` on the `RetryEntry` at the existing
    `setRetry` site (the only continuity writes; populated at existing sites, no new bookkeeping).
- `src/core/domain/run-attempt.ts` — additive optional `turn?: Int`, `failure_attempts?: Int`.
- `src/core/domain/retry-entry.ts` — additive optional `kind?: "failure" | "continuation"`.
- `src/core/orchestrator/observer.ts` — new `RestoredAfterRestart` observation (counts only).
- `src/core/observability/recent-events.ts` + `live-observer.ts` — exhaustive-switch cases for it
  (one synthetic `kind:"restored"` feed entry + structured `event=restored` log line).
- `test/restore-reconcile.test.ts` (NEW, 8 scenarios) — orphan→continuation dispatched **exactly
  once**; orphan gone **terminal**/**vanished** → killed, not re-dispatched; pending retry **past-due
  → fires immediately** and **future → fires at the residual wall-clock offset**, both proving
  wall-clock (seeded `due_at_ms = 5_000_000`: a monotonic read would need a ~5_000_000 ms advance;
  every assertion fires with ≤ 10_001 ms); **missing/corrupt checkpoint → clean empty boot**;
  `RestoredAfterRestart` counts.
- `test/persistence.test.ts` — the #40 "bookkeeping-only seed" test updated to assert **full
  restore** (scheduling slice + config-sourced knobs).
- `test/recent-events.test.ts`, `test/live-observer.test.ts` — `RestoredAfterRestart` sample + a
  focused "restored" draft assertion.

**Boot ordering (seed → registry rebuild → orphan reconcile → first tick → dispatch):**
`seedState` (full) → `restoreFromCheckpoint` (registry rebuild + orphan→due-continuation in the
store + compute re-arm plan + emit `RestoredAfterRestart`) → `startupCleanup` → **enqueue the first
`Tick`** → **fork the re-arm timers** → fork poll loop → drain. **Exactly-once is structural:**
(1) the orphan/retry issues stay `claimed`, so the first tick's candidate selection (which excludes
`claimed`) can never re-dispatch them fresh; (2) the re-arm timers are forked **after** the `Tick` is
already in the FIFO mailbox, and the single consumer drains the `Tick` (reconcile → dispatch) before
any `RetryDue` those timers post — so reconcile gates every restored issue (terminal → `TerminalKill`,
vanished → `NeitherKill`, both `registry.delete` so the later `RetryDue` is a no-op); (3) forking the
timers before the drain means restored issues already hold a concurrency slot (`timerFiber !== null`)
when the first tick plans dispatch — no over-admission. An orphan is reduced entirely to existing
machinery (retry → reconcile → continuation dispatch); no parallel resumption path.

**Wall-clock re-arm:** `remainingWallMs` derives the fire instant from `scheduled_at + delay_ms`
(absolute wall-clock, captured at schedule time in #37); `due_at_ms` (monotonic, dead-process origin)
is never read on restore. Past-due → `delayMs = 0` (due now); future → residual delay. The test
proves it isn't monotonic by seeding `due_at_ms = 5_000_000` and firing every re-arm with a ≤ 10 s
clock advance (a monotonic countdown would need ~5_000 s).

**Additive schema fields (minimal, #41-needs-only):** `RunAttempt.turn`, `RunAttempt.failure_attempts`
(orphan→continuation preserves turn/backoff accounting → `attempt = turn+1`), `RetryEntry.kind`
(re-arm reconstructs `pendingKind` so `handleRetryDue` re-dispatches the correct shape). **No
`session_id`** — restored continuations run **fresh** (`rec.sessionId` stays null, no `--resume`);
session continuity is #42 (workspace-on-disk is the true record of progress). All optional/additive →
`/api/v1/state` stays strictly additive, no `/api/v2`; the persistence codec round-trip is unaffected
(absent optionals stay absent).

**Observability:** rings stay ephemeral (not persisted). One synthetic `RestoredAfterRestart` →
`kind:"restored"` feed entry + `event=restored` log with `orphaned_running_converted` /
`rearmed_retries` / `restored_completed` counts (no secrets). Cold start emits nothing.

**Corruption/empty → clean start:** preserved end-to-end (durable `load` → `none` → `initialState`);
covered by two regression-guard scenarios (missing + corrupt → normal dispatch, corrupt file renamed
aside).

**Gates:** typecheck 0 · lint 0 · build 0 · **284 tests** (275 baseline + 9 new: 8 restore/reconcile
scenarios + 1 recent-events draft), full suite green.
