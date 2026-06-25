# Sprint 1 — QA Sign-off (Core Orchestrator Loop)

> QA: Ivy · Date: 2026-06-23 · Branch under test: `main` @ `d957588`
> (merge of `feature/sprint-1`, PR #16) · Node v24.16.0 · pnpm 11.8.0

## Verdict: ✅ SHIP WITH FOLLOW-UPS

Sprint 1 is substantially complete and high quality. All five quality gates are green
from a clean checkout, the full control loop is proven on fakes under `TestClock`, the
real adapters are unit-tested, the safety invariants hold (verified statically **and**
empirically), and the CLI/daemon behaves correctly including loopback-only snapshot
binding and degraded-mode looping.

**No blockers.** One **major** correctness bug (concurrency cap can be exceeded via the
retry/continuation re-dispatch path) and one **major** state-mapping edge case (a closed
issue with a lingering active label is treated as active) should be fixed early in
Sprint 2. Four minor issues are tracked. None prevent building on these foundations.

> Calibration note for the Producer: the "concurrency never exceeds caps" property is a
> Sprint 1 success criterion. It is **proven at the pure-function level** (tick dispatch)
> but **violated at the live-loop level** through retry/continuation re-dispatch (#17).
> If you treat cap-adherence as strictly release-gating, treat this as a BLOCK and
> hot-fix #17; my QA judgment is major + fast-follow since the loop is otherwise correct
> and does not crash or corrupt state.

---

## Verification matrix

| #   | Success criterion / check                                  | Result                | Evidence                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile` from clean `node_modules` | ✅ PASS               | `rm -rf node_modules && pnpm install --frozen-lockfile; echo $?` → **0**                                                                                                                                                                                   |
| 1   | `pnpm typecheck`                                           | ✅ PASS               | `tsc --noEmit` → exit **0**                                                                                                                                                                                                                                |
| 1   | `pnpm lint`                                                | ✅ PASS               | `biome check .` → "Checked 72 files… No fixes applied", exit **0**                                                                                                                                                                                         |
| 1   | `pnpm test`                                                | ✅ PASS               | **178 passed / 178**, **15 files**, exit **0** (matches done.md claim)                                                                                                                                                                                     |
| 1   | `pnpm build`                                               | ✅ PASS               | `tsup` → `dist/cli/main.js` 68.35 KB, exit **0**                                                                                                                                                                                                           |
| 2   | CLI boots + emits logfmt `started` line                    | ✅ PASS               | `…message="orchestra started" event=started snapshot_port=4317 pid=… version=0.0.0 workflow_path=…`                                                                                                                                                        |
| 2   | Missing/invalid args exit non-zero w/ clear message        | ✅ PASS               | no-args → `CliUsageError: usage: orchestra <path…>` exit **1**; `--port abc/0/99999` → `--port must be an integer in 1..65535` exit **1**                                                                                                                  |
| 2   | `--port N` exposes `GET /api/v1/state` on 127.0.0.1        | ✅ PASS               | curl loopback → full JSON snapshot (200); unknown path → **404**                                                                                                                                                                                           |
| 2   | Snapshot NOT reachable on non-loopback interface           | ✅ PASS               | `lsof` shows `TCP 127.0.0.1:4317 (LISTEN)` only; curl `http://<LAN-IP>:4317` → **connection refused (exit 7)**                                                                                                                                             |
| 2   | Daemon keeps looping in degraded mode when tracker errors  | ✅ PASS               | refused endpoint → repeating `event=tracker_error` WARN + `tick_start`/`reconciled`/`tick_end` every interval; no crash; graceful exit on SIGTERM                                                                                                          |
| 3   | Full loop on fakes via TestClock, no real timers/network   | ✅ PASS               | `orchestrator-loop.test.ts` (6 scenarios) + `e2e-fake.test.ts`                                                                                                                                                                                             |
| 3   | dispatch → success + continuation                          | ✅ PASS               | scenarios "dispatch → success", "dispatch → continuation" (resume `s1`)                                                                                                                                                                                    |
| 3   | failure → backoff retry                                    | ✅ PASS               | scenario asserts `delayMs == 10_000` then retry attempt `1` succeeds                                                                                                                                                                                       |
| 3   | issue→terminal mid-run → kill + clean                      | ✅ PASS               | scenario asserts `WorkerKilled reason=terminal` + `WorkspaceCleaned` + removed workspace                                                                                                                                                                   |
| 3   | stall → kill + retry                                       | ✅ PASS               | scenario asserts `WorkerKilled reason=stall` + failure retry + success                                                                                                                                                                                     |
| 3   | slots-full → requeue                                       | ⚠️ PASS (with caveat) | scenario covers requeue via **reconciliation**, not via retry; see #17 — retry/continuation requeue can exceed the cap                                                                                                                                     |
| 3   | Property: no double-dispatch of a claimed issue            | ✅ PASS (pure)        | `orchestrator-pure.test.ts`; proven on pure `selectCandidates` (claim set incl. retrying). Live-loop never double-dispatches the _same_ issue                                                                                                              |
| 3   | Property: concurrency never exceeds global/per-state caps  | ⚠️ PARTIAL            | pure `planDispatch` proven; **live loop can exceed caps** via retry/continuation → **#17 (major)**                                                                                                                                                         |
| 3   | Property: backoff monotonic & capped                       | ✅ PASS               | `failureBackoffMs` property: non-decreasing, ≤ cap, ≥ min(base,cap); `10s·2^(n-1)`                                                                                                                                                                         |
| 4   | Workspace cwd == workspace                                 | ✅ PASS               | runner sets both `Command.workingDirectory` and `-C`; integration test writes `cwd.txt` at workspace path                                                                                                                                                  |
| 4   | path-under-root enforced                                   | ✅ PASS               | `computeWorkspacePath` + `isPathUnderRoot`; separators→`_`, `.`/`..`/equal-path rejected with `PathOutsideWorkspaceRoot`                                                                                                                                   |
| 4   | sanitized workspace key                                    | ✅ PASS               | `sanitizeWorkspaceKey` allows `[A-Za-z0-9._-]`, else `_`                                                                                                                                                                                                   |
| 4   | No secret/token logging                                    | ✅ PASS               | tracker `mapError` never embeds token; Observer logs only ids/identifier/sessionId/truncated msgs; degraded-mode logs showed only `ECONNREFUSED 127.0.0.1:59999`, **no token**. (Caveat: untruncated hook output is the one plausible leak path → **#20**) |
| 5   | JSONL parsing robust to partial/malformed lines            | ✅ PASS (1 gap)       | `mapCopilotLine` never throws: blank→[], unparseable/typeless→`Malformed`; gap: no test for final result line w/o trailing newline → **#22**                                                                                                               |
| 5   | Child process killed on scope close (no orphans)           | ✅ PASS (verified)    | **Empirically verified:** hanging fake `copilot` child got `Terminated: 15` and `process.kill(pid,0)` threw after `Fiber.interrupt`. No automated test → **#22**                                                                                           |
| 5   | GitHub state-mapping edge cases                            | ⚠️ PASS (1 edge)      | open/closed + `state_reason` + status-label mapping correct **except** closed-issue-with-active-label → **#18 (major)**                                                                                                                                    |
| 5   | Reconciliation refresh-failure keeps workers               | ✅ PASS               | `planReconciliation(refreshed=null)` → `[]`; pure + scenario coverage                                                                                                                                                                                      |
| 5   | Retry timer cancel-on-reschedule (no double-fire)          | ✅ PASS               | `scheduleRetry` interrupts existing `timerFiber` before scheduling; single-fiber mailbox serializes handling                                                                                                                                               |
| 6   | Node 22 + 24 CI                                            | ➖ NOT RE-RUN         | CI config present (`.github/workflows/ci.yml`, Node 22+24); verified locally on Node 24 only                                                                                                                                                               |
| 6   | Live real-repo + real Copilot run                          | ➖ DEFERRED           | Out of scope to run (cost/noise). Runbook documented below                                                                                                                                                                                                 |

Legend: ✅ pass · ⚠️ pass with caveat / partial · ➖ not run / deferred.

---

## Issues filed

| #                                                             | Severity  | Area          | Title                                                                                                                        |
| ------------------------------------------------------------- | --------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [#17](https://github.com/martinthommesen/orchestra/issues/17) | **major** | orchestrator  | Concurrency cap exceeded: retry/continuation re-dispatch bypasses `planDispatch` (§8.3) — **reproduced** (cap=1 → 2 running) |
| [#18](https://github.com/martinthommesen/orchestra/issues/18) | **major** | tracker       | Closed GitHub issue with a lingering active status label is normalized as active (worker not stopped on close)               |
| [#19](https://github.com/martinthommesen/orchestra/issues/19) | minor     | observability | Octokit default request logging emits unstructured lines into the logfmt stream                                              |
| [#20](https://github.com/martinthommesen/orchestra/issues/20) | minor     | workspace     | Hook stdout/stderr inherited untruncated (contradicts §9.2/§9.4 "truncate hook output")                                      |
| [#21](https://github.com/martinthommesen/orchestra/issues/21) | minor     | observability | CLI: missing/unreadable WORKFLOW file surfaces generic "An error has occurred"                                               |
| [#22](https://github.com/martinthommesen/orchestra/issues/22) | minor     | testing       | Test gaps: live concurrency invariant, real subprocess kill-on-interrupt, JSONL final-line-no-newline                        |

> No `severity:*` labels exist on the repo; severity is encoded in each title/body and the
> `bug` + `area:*` labels are applied. (#22 is test-debt, labelled `area:testing` only.)

---

## What I exercised (beyond reading the code)

- **Clean-state gates** — wiped `node_modules`, re-installed frozen, ran typecheck/lint/test/build; all exit `0` (un-piped `; echo $?`). Test count confirmed **178/178 across 15 files**.
- **CLI error paths** — no args, `--port abc|0|99999`, nonexistent workflow; all exit `1`.
- **Network-free daemon smoke** — ran the built bundle against a refused loopback endpoint (`http://127.0.0.1:59999`) with `--port 4317`; observed the `started` line, repeating degraded-mode ticks, **no token leakage**, and clean SIGTERM shutdown.
- **Snapshot binding** — confirmed via `lsof`/`netstat` it binds `127.0.0.1:4317` only; refused on the host's LAN IP (curl exit 7); 404 on unknown paths; valid JSON on `/api/v1/state`.
- **Concurrency-cap reproduction** — wrote a focused `@effect/vitest` scenario (cap=1, retry path); it fails the running-count invariant (`running=["i2","i1"] cap=1`). Throwaway test removed; shared tree left clean.
- **Orphan / scope-finalizer probe** — spawned a hanging fake `copilot`, interrupted the worker fiber, confirmed the child received `Terminated: 15` and was gone. Throwaway probe removed.

No source files, git state, or commits were modified by QA (verified `git status` clean before and after).

---

## Live-repo validation runbook (deferred follow-up, not run)

A real GitHub-repo + real Copilot run remains an **operator step** (Sprint 1 success
criterion #3). I did **not** run it to avoid real Copilot cost and repo noise. A safe
runbook:

1. **Disposable repo** with GitHub Issues enabled; create labels for `required_labels`
   (e.g. `orchestra`) and your status labels (`Todo`, `In Progress`, …).
2. **Least-privilege token**: a fine-grained PAT scoped to that one repo's Issues + PRs.
   `export GITHUB_TOKEN=…`.
3. **WORKFLOW.md**: `cp WORKFLOW.example.md WORKFLOW.md`; set `tracker.repo`, your labels
   and states, a small `agent.max_concurrent_agents` (1) and small `agent.max_turns`
   (1–2) to bound cost; `workspace.root` to a scratch dir.
4. **Install + auth the headless `copilot` CLI** on the host.
5. **Cheap smoke:** one issue, open + labeled, `max_turns: 1`. Run
   `node dist/cli/main.js ./WORKFLOW.md --port 4317`. Verify: pickup → workspace created
   under root → Copilot session runs in `cwd=workspace` → curl the snapshot shows it
   running → close the issue → next tick stops + cleans the worker.
   - **Heads-up:** while validating the close→stop path, do **not** leave an active status
     label on the issue when you close it, or you'll hit **#18** (worker won't stop).
6. **Cost guardrails:** keep `max_turns` low; watch `agent_totals` in the snapshot;
   tear down with SIGTERM.

A _cheap, safe_ live smoke is feasible (one issue, 1 turn). I did not run it without an
explicit go-ahead. Give the word and I'll execute it against a throwaway repo.

---

## Recommended follow-ups for Sprint 2

1. **Fix #17 first (major).** Make retry/continuation re-dispatch respect the concurrency
   budget (re-check in `handleRetryDue`, or count `retry_attempts` as occupying a slot).
   Add the **live-loop** concurrency invariant property test from #22 to prevent
   regression. This is the highest-value fix.
2. **Decide #18 (major).** Should GitHub `closed` take precedence over a lingering active
   status label? Recommend: a closed issue maps terminal regardless of active labels (or,
   at minimum, document the footgun loudly). Affects the "closed stops the worker"
   guarantee.
3. **Observability cleanliness (#19, #21).** Route/silence Octokit's logger so the logfmt
   stream stays single-line-per-event; give workflow-load errors an actionable top-line
   message.
4. **Honor the hook-output truncation policy (#20).** Capture + truncate hook
   stdout/stderr instead of inheriting fds (closes the one plausible token-to-log path).
5. **Close the test gaps (#22).** Live concurrency/no-double-dispatch property test, an
   automated subprocess kill-on-interrupt test, and a JSONL no-trailing-newline test.
6. **CI parity.** Re-confirm green on the Node 22 + 24 matrix in Actions (QA verified Node
   24 locally only).

---

## Bottom line

Solid sprint. The core loop, adapters, safety invariants, and observability are
well-built and well-tested, and the daemon behaves correctly under failure. Two majors
(#17 cap-bypass, #18 closed+label) want fixing early in Sprint 2; the rest is polish and
test debt. **Sign-off: ✅ SHIP WITH FOLLOW-UPS — no blockers.**

— Ivy (QA)
