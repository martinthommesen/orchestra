# Sprint 4 — Progress

Branch: `feature/sprint-4` (off `main` @ `0e48363`).
Design of record: `docs/sprint-3/durability-spike.md`.

## Task board
| # | Task | Status |
|---|------|--------|
| 40 | Persistence layer (versioned, atomic, debounced) | ✅ done |
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
