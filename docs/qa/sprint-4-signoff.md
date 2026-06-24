# Sprint 4 — Durable Orchestrator QA Sign-off

> QA: Ivy · Date: 2026-06-24 · Branch under test: `feature/sprint-4` (even with `main`,
> includes merge `ae21394` = PR #49) · HEAD `ae21394` · Node v24.16.0 · pnpm 11.8.0
> Audited against the design of record `docs/sprint-3/durability-spike.md` and
> `docs/sprint-4/plan.md` success criteria. Scope: #40, #41, #42, #43.

## Verdict: ✅ SHIP — with two minor, non-blocking follow-ups filed

Sprint 4 is **solid**. All four gates are green on the merged tree, the test count is exactly
**291** as claimed, and the #43 flake is independently confirmed dead (**12/12** full-suite
parallel-load runs + **6/6** durability-only stress runs, zero intermittent failures). Every
durability invariant in the spike holds and is pinned by a test that would *fail* if the
invariant regressed — most importantly the wall-clock re-arm guard and the structural
exactly-once boot ordering. Corruption/missing checkpoints provably yield a clean start, the
write is genuinely atomic and same-dir, `resume_sessions:false` is byte-identical to the #41
baseline, and resume self-heals without stranding work.

**No blockers.** Two **minor** follow-ups filed (#50 robustness, #51 security hardening); both
are defense-in-depth, neither affects the success criteria, and neither gates the sprint close.

---

## Gates (clean run on the merged tree)

| Gate | Command | Result | Evidence |
|------|---------|--------|----------|
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) | ✅ PASS | exit **0** |
| Lint | `pnpm lint` (`biome check .`) | ✅ PASS | "Checked **101 files** … No fixes applied", exit **0** |
| Test | `pnpm test` (`vitest run`) | ✅ PASS | **291 passed / 291**, **25 files**, exit **0** (matches `done.md`) |
| Build | `pnpm build` (`tsup`) | ✅ PASS | `dist/cli/main.js` 124.80 KB + `dist/cli/dashboard.js` 30.72 KB, exit **0** |

New/affected durability suites all green: `persistence.test.ts` (10), `restore-reconcile.test.ts`
(11), `domain.test.ts` (13), `recent-events.test.ts` (9), `live-observer.test.ts` (5).

### Flake verification (independent — #43 claimed 20/20; I re-derived it)

- **Full suite, 12× parallel-load loop:** `12/12` runs reported `Tests 291 passed (291)`, **0**
  intermittent failures.
- **Durability-only stress, 6×:** `pnpm vitest run test/persistence.test.ts
  test/restore-reconcile.test.ts` → `6/6` green (21 tests each), hammering the FS-settle /
  sleep-registration races the #43 fix targets.

The pre-existing #40 debounce/final-flush flake is **confirmed dead** in my hands, not just the
dev team's. The fix is test-only (`awaitWriterParked` + bounded `awaitFileExists`); no production
seam was weakened.

---

## Invariant-by-invariant audit (vs spike + success criteria)

| # | Invariant | Verdict | Evidence / reasoning |
|---|-----------|---------|----------------------|
| 1 | **Retry re-arm is WALL-CLOCK, never monotonic `due_at_ms`** | ✅ PASS | `remainingWallMs` (`loop.ts:757`) computes `scheduled_at.getTime() + delay_ms − wallNow`; `due_at_ms` is **never read** on the restore path. **Regression guard is real:** every seeded retry in `restore-reconcile.test.ts` carries a deliberately bogus `due_at_ms = 5_000_000`, while the tests fire timers with a **1 ms** (already-due) and **10_000 ms** (future) advance. If anyone reintroduced the monotonic read, the timer would need a ~5,000,000 ms advance and those tests would hang/fail. Both the due-now and future cases are proven not-monotonic. |
| 2 | **Exactly-once on boot (no double-dispatch)** | ✅ PASS | Structural, three reinforcing mechanisms, all verified in code: (a) restored orphans/retries stay `claimed`, and the first tick's candidate selection excludes `claimed` (`handleTick` → `selectionContext({claimed})`), so they can never be re-dispatched fresh; (b) the first `Tick` is enqueued (`loop.ts:885`) **before** the re-arm timers are forked (`:890`), and the single FIFO mailbox consumer (`:904`) drains the `Tick` (reconcile → dispatch) fully before any `RetryDue` — so reconcile gates terminal (`TerminalKill` + `registry.delete`) / vanished (`NeitherKill` + `registry.delete`) issues, making the later `RetryDue` a no-op (`handleRetryDue` returns on missing registry entry); (c) timers are forked before the drain so restored issues already hold a slot (`occupiesSlot` via `timerFiber`), preventing over-admission. The terminal/vanished-while-down case is covered by `restore-reconcile.test.ts` scenarios. |
| 3 | **Corruption / missing → clean start, never crash; atomic write** | ✅ PASS | `Persistence.load` is total: missing → `Option.none`; read fault → warn + `none`; decode `ParseError` → rename-aside `state.json.corrupt-<ts>` + `none` (`persistence.ts:106-144`), never throws. `save` is `writeFile(tmp) → rename(tmp, file)` with `tmp` a **same-dir sibling** (`resolvePersistencePaths`) → genuinely same-filesystem atomic rename; wrapped in `catchAll` so IO faults never fail teardown. Tests: corrupt-file boot (loop + service level), missing-file cold start, "no leftover `.tmp` after rename", round-trip fixed point. |
| 4 | **`resume_sessions:false` (default) == pre-#42 #41 behavior** | ✅ PASS | In `restoreFromCheckpoint`, `resumeEnabled = config.persistence.resume_sessions` gates `rec.sessionId`: when off, `rec.sessionId` stays `null` for both orphan-continuations and re-armed continuations, and `dispatch`'s `resume = isCont && rec.sessionId !== null ? … : null` is therefore always `null`. Test `resume_sessions OFF → restored continuation runs FRESH, session_id ignored` asserts `dispatched.resumed === false` and `resumeSessionId === null` even though the checkpoint carries a session id. Default is `false` (`workflow.ts:130`). |
| 5 | **Self-healing resume (stale `--resume` falls back, never strands)** | ✅ PASS | Test `resume_sessions ON but resume REJECTED → self-heals to a FRESH continuation`: the resumed turn fails (`TurnFailed: resume rejected`), `handleWorkerDone` increments `failureAttempts` and schedules a failure retry, which re-dispatches **fresh** (`resumeSessionId` null on the 2nd run) against the on-disk workspace and progresses. Resume can only help, never strand. |
| 6 | **Additive-only snapshot + persisted schema** | ✅ PASS | New fields are all `Schema.optional(...)`: `RunAttempt.{turn,failure_attempts,session_id}`, `RetryEntry.{kind,session_id}` (`scheduled_at`/`delay_ms` already optional from #37). `PersistenceConfig` is fully defaulted and `ServiceConfig.persistence` is `optionalWith` → an unchanged `WORKFLOW.md` still decodes. `toSnapshot` is unchanged and still serves `/api/v1/state` (no `/api/v2`); the new fields ride along additively and the defensive dashboard parser ignores them. An older daemon / older checkpoint decodes (absent optionals stay absent; `migrateToCurrent` is identity for V1). |
| 7 | **Security (§9): no secret leak; reasonable file location** | ✅ PASS (w/ minor hardening note) | No GitHub tokens or `$VAR` secret env values are written to the checkpoint or logs — only issue ids, identifiers, paths, counts, and (since #42) Copilot `session_id`s. Session ids are conversation-thread UUIDs, **not** §9-classified secrets. `load` logs only counts; `dispatch` logs `resumed: boolean`, not the id. The `.orchestra/` dotdir does not collide with per-issue workspace subdirs or `startupCleanup`. **Hardening gap (minor, filed #51):** the checkpoint is written with default file permissions and `workspace.root` defaults under the system temp dir, so session ids are world-readable at rest on shared hosts — defense-in-depth, not a §9 violation. |

**Success criteria (plan.md):** ✅ kill-mid-run/restart → bookkeeping intact, in-flight work
re-derived (orphan → due continuation) or resumed, no stranded/duplicated issues; ✅
corrupt/missing → clean start; ✅ `/api/v1/state` strictly additive, Sprint 2/3 dashboard
unaffected; ✅ all gates 0, core-loop edits minimal/additive, no suite regression.

---

## Edge cases I reasoned through (beyond the tests)

- **Claim integrity / stranded claims:** verified `claimed` is always a subset of
  `running ∪ retry_attempts` — every claim addition is via `setRunning`/`setRetry` (atomic with
  the running/retry map), and every `clearRunning` is in the same atomic update as a
  `setRetry`/`markCompleted`/`release`. So a checkpoint can never capture a `claimed`-without-backing
  entry, and the `restoreFromCheckpoint` early-return (`running/retry/completed` all empty) can
  never strand a claim. **No bug.**
- **Concurrent shutdown during a debounced write:** `runWriter` registers the final-flush
  finalizer **before** `forkScoped` (LIFO → the writer fiber is interrupted *first*, the flush
  runs *last*); both the debounced write and the flush serialize through a `Semaphore(1)`
  (`writeLock`), and Effect releases the permit on interruption, so the flush can always acquire
  it — no deadlock, no half-write, latest state durable. The mid-write-interruption *race* is
  not explicitly unit-tested (the final-flush test never advances the clock), but the mechanism
  is sound; noted as an observation, not a defect.
- **Restored issue whose workspace dir was deleted while down:** if terminal → `startupCleanup` /
  reconcile kills it before re-dispatch (no harm). If still active → the continuation re-dispatch
  recreates the workspace via `ensureWorkspace` and runs continuation guidance against an empty
  tree (minor progress loss). This is the same behavior as a mid-run deletion in steady state
  (pre-existing), so it is an inherent edge, not a Sprint-4 regression. Observation only.
- **A `running` entry's `workspace_path`:** `RunAttempt.workspace_path` is required (`Schema.String`),
  and `dispatch` recomputes the path deterministically from `root + identifier` anyway, so even a
  weird persisted value is harmless. **No bug.**
- **Clock skew on re-arm:** wall-clock derivation means a backward NTP correction defers a retry
  and a forward jump fires it immediately (`Math.max(…,0)`); reconcile gates either way. Inherent
  and acceptable per the spike. **No bug.**
- **Totals-only checkpoint (totals>0 but running/retry/completed all empty):** restore seeds the
  totals correctly but skips the synthetic `RestoredAfterRestart` event (early return). Cosmetic
  (the feed gap is only a few records); the authoritative totals survive. Observation only.
- **Enormous/old checkpoint:** restore forks one timer fiber per pending retry with no batching/limit
  — fine for realistic fleets, a theoretical scalability edge. Observation only.

---

## Issues filed

| # | Severity | Area | Title |
|---|----------|------|-------|
| [#50](https://github.com/martinthommesen/orchestra/issues/50) | **minor** | persistence (`area:orchestrator`) | `agent_rate_limits` encode fault skips the **whole** checkpoint write instead of degrading just that field (deviation from spike §2.2 field-level guard) |
| [#51](https://github.com/martinthommesen/orchestra/issues/51) | **minor** | persistence/security (`area:orchestrator`) | Checkpoint dir/file written with default permissions; session_ids land world-readable under the system temp dir |

No `severity:*` labels exist on the repo (as in Sprints 1 & 3); severity is encoded in the
title/body, with `bug` + `area:orchestrator` applied (no `area:persistence` label exists).

---

## On the `done.md` carry-forward list

The three listed follow-ups (resume unproven vs a live Copilot; checkpoint surface in the
dashboard/snapshot; migration is V1-only) are **honest and accurate**. The list is **not quite
complete** — it omits the two robustness/security gaps I filed as #50 (rate-limits write
granularity) and #51 (checkpoint file permissions / session-id at-rest exposure). Both are minor
and non-blocking; flagging them here so they are tracked rather than lost.

---

## What I exercised (beyond reading the code)

- **Gates** — typecheck / lint / test / build on the merged tree, all exit `0`; confirmed
  **291/291 across 25 files**, lint **101 files**.
- **Flake** — 12× full-suite parallel-load loop (12/12) + 6× durability-only stress (6/6),
  independently confirming the #43 fix.
- **Invariant audit** — traced the wall-clock re-arm guard, the boot-ordering exactly-once
  sequence, the corruption/atomic-write paths, the resume default-off and self-heal paths, and
  the additive snapshot/schema, each against the spike and its pinning test.
- **Edge-case reasoning** — claim integrity, shutdown-during-write, deleted workspace, clock skew,
  totals-only checkpoint, unbounded timer fork (above).

No source files, git state, or commits were modified by QA beyond this sign-off doc and GitHub
issues #50/#51 (verified `git status` clean apart from the doc). I did not push or open a PR.

---

## Out of scope (not tested)

- **Real-repo + real Copilot restart/resume** — `resume_sessions` against a live Copilot session
  across real daemon downtime is unverified (operator/integration step; `done.md` follow-up #1).
  Only the fake-agent self-heal path is exercised. Default-off contains the risk.
- **SIGKILL crash durability in practice** — covered by design (last-good atomic checkpoint;
  next-tick reconcile corrects drift) and unit tests, not by a real OS-level kill smoke.
