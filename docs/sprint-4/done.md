# Sprint 4 — Done (Durable Orchestrator)

Handoff for the Producer. See `plan.md` for the original scope, `progress.md` for the
phase-by-phase log, and `docs/sprint-3/durability-spike.md` for the design of record.

## Summary

Sprint 4 makes Orchestra **survive a daemon restart**. State is checkpointed to disk; on
boot it is restored, reconciled against the tracker, and in-flight work is safely re-derived
or resumed — with **zero new double-dispatch risk** and a guaranteed clean start on a
corrupt/missing file. The snapshot contract stayed **strictly additive** (no `/api/v2`), and
the core-loop surgery was kept minimal and reviewed, exactly as Phase A did.

- **Closed this sprint:** #40, #41, #42, #43.
- **Carried in:** the #39 durability design spike (Sprint 3) — built here, not re-spiked.

## What shipped

| # | Issue | Outcome |
|---|-------|---------|
| #40 | Persistence layer | `src/core/persistence/` — versioned `PersistedStateV1` codec (`Schema.parseJson`, ISO `Date` round-trip, forward-only `migrateToCurrent` seam), a `Persistence` service over `@effect/platform` `FileSystem` (`load` missing→`none` / corrupt→rename-aside+`none`, never throws; `save` **atomic** temp+rename, total; `markDirty` coalescing `Queue.sliding(1)`; `runWriter` single scoped debounced fiber + **guaranteed final flush** finalizer), and `layerDurableOrchestratorStore` — a transparent drop-in for `layerOrchestratorStore` so `loop.ts`/`snapshot-server.ts` need no edits. (`dc154f3`) |
| #41 | Restore + reconcile on boot + retry re-arm | `loop.ts` `restoreFromCheckpoint`: rebuild the in-memory registry from `running`/`retry_attempts`, **convert each orphaned `running` → a due-immediately `kind:"continuation"` retry** (rides the existing retry/reconcile/dispatch path), **re-arm every pending retry from wall-clock** (`remainingWallMs` = `scheduled_at + delay_ms − now`; the monotonic `due_at_ms` is never read), emit one `RestoredAfterRestart`. Additive `RunAttempt.{turn,failure_attempts}` + `RetryEntry.kind`. The seed restores the **full** state; the loop's reconcile completes it. (`daf75c9`) |
| #42 | Session continuity (opt-in resume) | Additive `RunAttempt.session_id` / `RetryEntry.session_id` (captured at the existing `StreamingTurn`/`setRunning`/`setRetry` sites). `persistence.resume_sessions` (default **off**). When on, a restored continuation carries its `session_id` into the existing `--resume` dispatch argument; when off it runs fresh — byte-for-byte the #41 path. **Self-healing:** a rejected resume fails the worker → failure-backoff → re-dispatch fresh; never strands, never crashes. (`76fa17d`) |
| #43 | Tests + docs + handoff | Stabilized the pre-existing #40 debounce/final-flush `TestClock` flake (two real races, fixed deterministically — see below), filled the audited coverage gaps, and wrote this close-out. (`0e83f87` tests; docs commit closes the issue.) |

## Key design decisions (so a future sprint doesn't regress them)

- **#40/#41 seed boundary is one restore flow.** The durable store seeds the **complete**
  `OrchestratorState` (scheduling slice included), but seeding `running`/`retry_attempts` is
  only safe *because* `restoreFromCheckpoint` rebuilds the registry, converts orphans, and
  re-arms timers before the first dispatch. The two halves are inseparable — do not seed the
  scheduling slice without the loop-side reconcile, or issues strand. Reloadable knobs
  (`poll_interval_ms`, `max_concurrent_agents`) always come from the **live config**, never the
  (possibly stale) checkpoint.
- **Orphan → due-immediately continuation retry**, never a bespoke resumption path. An orphaned
  `running` issue is reduced entirely to existing, tested machinery (retry → reconcile →
  continuation dispatch).
- **Wall-clock re-arm.** Retry fire instants derive from `scheduled_at + delay_ms` (absolute,
  captured at schedule time). The monotonic `due_at_ms` resets per process and **must never** be
  turned into a cross-restart countdown.
- **Opt-in, self-healing session resume.** Default off — the on-disk workspace is the true record
  of progress and Copilot's cross-restart session liveness is unverified. Resume can only help,
  never strand.
- **Observability rings are not persisted.** They boot empty and emit one synthetic
  `RestoredAfterRestart` event so the feed gap is honest. The authoritative counts/totals *are*
  restored.

### Boot-ordering exactly-once invariant (DO NOT REGRESS)

`seedState` (full) → `restoreFromCheckpoint` (registry rebuild + orphan→due-continuation written
to the store + compute re-arm plan + emit `RestoredAfterRestart`) → `startupCleanup` → **enqueue
the first `Tick`** → **fork the re-arm timers** → fork poll loop → drain. Exactly-once is
**structural**, three reinforcing reasons:

1. Restored orphan/retry issues stay `claimed`, so the first tick's candidate selection (which
   excludes `claimed`) can never re-dispatch them fresh.
2. The re-arm timers are forked **after** the `Tick` is already in the FIFO mailbox; the single
   consumer drains the `Tick` (reconcile → dispatch) before any `RetryDue` those timers post — so
   reconcile gates every restored issue (terminal → `TerminalKill`, vanished → `NeitherKill`, both
   `registry.delete` so the later `RetryDue` is a no-op).
3. Forking the timers before the drain means restored issues already hold a concurrency slot
   (`timerFiber !== null`) when the first tick plans dispatch — no over-admission.

Re-order these steps and you reintroduce the stranded/duplicated-issue failure durability exists
to prevent. The scenario tests in `test/restore-reconcile.test.ts` pin all three.

## #43 — flake root cause + fix

The #40 debounce/final-flush `TestClock` tests flaked intermittently under full-suite parallel
load (reproduced on clean `main` @ `b494e83` — pre-existing, not caused by #42). **Two distinct
real races**, both fixed deterministically *without weakening the assertions*:

1. **Sleep-registration race.** The test advanced the virtual clock before the forked debounced
   writer had parked in `Effect.sleep(debounce_ms)`, so its sleep deadline was computed from an
   already-advanced clock and the window-crossing `adjust` never reached it. **Fix:**
   `awaitWriterParked` blocks on `TestClock.sleeps()` until the writer's sleep is registered
   (yielding to the scheduler between polls).
2. **Real-FS settle race (the dominant one).** After the window fires, the multi-step atomic
   write (`mkdir → writeFile → rename`) runs on the *real* event loop; a fixed pair of
   `setImmediate` settles is not a reliable barrier under load, so `fs.exists` could observe the
   file before `rename` landed. **Fix:** `awaitFileExists` polls the real FS, **bounded** (returns
   `false` on a genuine regression rather than hanging).

The debounce assertions are unchanged in strength: parked → 499 ms no file → +1 ms write lands;
the new coalescing test proves a burst collapses to exactly one scheduled flush. **No production
code changed** — the seam is test-only. Verified with a **20×** full-suite parallel-load loop:
**20/20 green**.

## #43 — coverage audited + added

Audited the durability suite against the spike's invariants and the plan's success criteria. The
restore/reconcile/resume scenarios (#41/#42) and the leaf-schema codec tests (#42 `domain.test.ts`)
were already complete — **not duplicated**. Genuinely missing, now added:

- **Additive-field survival end-to-end.** Enriched `sampleState` with the #41/#42 continuity
  fields (`turn`, `failure_attempts`, `session_id`, `kind`), so the codec fixed-point **and** the
  real `save → load` round-trip now prove those fields survive `encode → write → read → decode` —
  not just the leaf domain schemas in isolation.
- **Debounce coalescing.** A burst of N mutations in one window collapses to **exactly one**
  scheduled flush (`TestClock.sleeps()` length 1) carrying the latest coalesced state, with no
  trailing window.

The guaranteed-final-flush-on-shutdown invariant was already covered (and is now also robust to
the FS-settle race).

## Gates (final, on `feature/sprint-4`)

`pnpm typecheck` ✅ 0 · `pnpm lint` ✅ 101 files · `pnpm test` ✅ **291 passed** (was 266 at
Sprint 3 end: +9 #40, +9 #41, +6 #42, +1 #43) · `pnpm build` ✅. Determinism verified by a 20×
full-suite parallel-load loop (20/20 green).

## Files changed / created (Sprint 4)

**New (services):** `src/core/persistence/{persisted-state,persistence,durable-store,index}.ts`.
**Modified (core, additive only):** `src/core/orchestrator/loop.ts` (the restore/re-arm + the
continuity persist chokepoints), `src/core/orchestrator/observer.ts` (`RestoredAfterRestart`),
`src/core/observability/{recent-events,live-observer}.ts`, the `RunAttempt`/`RetryEntry` schemas,
`src/core/domain/workflow.ts` (`PersistenceConfig`), `src/cli/daemon.ts` (layer swap).
**Tests:** `test/persistence.test.ts`, `test/restore-reconcile.test.ts` (new),
`test/domain.test.ts`, `test/recent-events.test.ts`, `test/live-observer.test.ts`.
**Docs:** `docs/sprint-4/{progress,done}.md`, `README.md` (Durability section + config block),
`PROJECT_BRIEF.md` §7/§8.

## How to run / verify

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # all exit 0; 291 tests

# Durability in practice:
pnpm dev ./WORKFLOW.md --port 4317   # daemon writes <workspace.root>/.orchestra/state.json
# Ctrl-C mid-run, then restart the same command → bookkeeping intact, orphaned running issues
# resume as continuations, retries re-arm at the right wall-clock time. Corrupt the state file
# and it boots clean (renamed aside as state.json.corrupt-<ts>).
```

## Follow-ups (candidates for a future sprint)

- **Session resume is unproven against a live Copilot.** `resume_sessions` is default-off and
  self-healing by design; flipping it on for real workloads needs an integration validation that
  Copilot honors `--resume` across daemon downtime (today only the fake-agent self-heal path is
  tested).
- **Checkpoint surface in the dashboard / snapshot** (e.g. `saved_at`, "restored after restart"
  banner) is not exposed — the `RestoredAfterRestart` event lands in the bounded ring only.
- **Migration is V1-only** (identity). The `migrateToCurrent` seam + a 3-step doc-comment are in
  place; the first real schema bump exercises it.
