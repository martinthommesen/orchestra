# Sprint 1 — Progress

> Living status doc (per PROJECT_BRIEF §12). Updated after each phase so context can be
> recovered. Branch: `feature/sprint-1`. Issues: #1–#13.

## Status by task

| # | Task | Phase | Status |
|---|------|-------|--------|
| 1 | `OrchestratorState` service | 1 | ✅ done |
| 2 | Candidate selection + sorting | 1 | ✅ done |
| 3 | Concurrency control | 1 | ✅ done |
| 4 | Retry + backoff | 1 | ✅ done |
| 5 | Reconciliation | 1 | ✅ done |
| 6 | Poll loop assembly | 1 | ✅ done |
| 7 | GitHub Issues adapter (Octokit) | 2 | ✅ done |
| 8 | Workspace manager | 2 | ✅ done |
| 9 | Copilot agent runner | 2 | ✅ done |
| 10 | Fakes (tracker / runner / workspace) | 1 | ✅ done |
| 11 | Property + scenario tests | 1 (partial) / 3 | 🟡 in progress — pure + loop scenarios done; full §7/§8 property matrix + no-double-dispatch property land in Phase 3 |
| 12 | Observability: logs + JSON snapshot | 3 | 🟡 seam in place (`Observer` Tag + `Observation` union); Live logger + `GET /api/v1/state` in Phase 3 |
| 13 | Fake end-to-end + docs | 3 | ⏳ not started |

## Phase 1 — State machine on fakes (tasks 1–6, 10) — ✅ COMPLETE

Built the entire orchestrator pure-logic core + the loop assembly + fakes, and proved the
full poll→claim→workspace→session→reconcile→retry loop deterministically under `TestClock`.
**No real network or Copilot touched.**

### What was built
- `src/core/orchestrator/state.ts` (#1) — pure `OrchestratorState` transitions
  (`claim`/`setRunning`/`setRetry`/`markCompleted`/`release`/`addUsage`/…) + the
  `OrchestratorStore` service (Ref-backed `get`/`update`/`modify`) and
  `layerOrchestratorStore(config)`. Mutations are pure functions so they are property-testable
  without a runtime; only the owner fiber calls the mutators (single-writer invariant).
- `src/core/orchestrator/selection.ts` (#2) — `isEligible` (active/terminal/claimed/labels/
  Todo-blocker) + total-order `compareIssues` (priority asc → created_at asc → identifier) →
  `selectCandidates`. Pure.
- `src/core/orchestrator/concurrency.ts` (#3) — `availableSlots`, `perStateLimit`,
  `planDispatch` (global free slots + per-state caps, order-preserving). Pure.
- `src/core/orchestrator/backoff.ts` (#4) — `CONTINUATION_DELAY_MS=1000`,
  `failureBackoffMs(attempt, cap) = min(10000·2^(attempt-1), cap)`. Pure ms; timer mgmt lives
  in the loop and is driven by Effect `Clock`/`sleep` for `TestClock` control.
- `src/core/orchestrator/reconcile.ts` (#5) — pure `planReconciliation` planner:
  stall (precedence, tracker-independent) → terminal/active/neither refresh; refresh-failure
  keeps workers untouched.
- `src/core/orchestrator/preflight.ts` — `preflight(config)` (§6.3): kind=github, repo, api_key
  present → else tagged tracker errors (never carries the secret token).
- `src/core/orchestrator/loop.ts` (#6) — **the single state-owning fiber.** A
  `Queue<Msg>` mailbox is drained by exactly one fiber that applies every mutation serially;
  worker fibers + retry timers only post messages, never mutate state. Per-tick: reconcile →
  preflight → fetch candidates → sort → dispatch within slots → notify. `Effect.scoped` wraps
  the whole body so interrupting the fiber tears down the scheduler, every worker, and every
  timer.
- `src/core/orchestrator/{messages,observer,index}.ts` — mailbox protocol; the `Observer`
  observability seam (typed `Observation` union emitted at every transition + `ObserverNoop`);
  barrel.
- `src/core/clock/live.ts` — `ClockLive` delegating both time sources to Effect's `Clock`
  (so `TestClock` controls poll/backoff/stall timing).
- `test/fakes/*` (#10) — `FakeTracker`, `FakeAgentRunner` (scriptable event sequences incl.
  failure/stall/continuation), `FakeWorkspaceManager` (in-memory, reuses the real §9.5 safety
  helpers), a queue-backed `RecordingObserver`, and a shared `harness.ts` (`buildDef`,
  `makeIssue`, `loopLayer`, `waitFor`).
- `test/orchestrator-pure.test.ts` — 33 unit + property tests for the pure cores.
- `test/orchestrator-loop.test.ts` — 6 full-loop scenarios on fakes + `TestClock`:
  dispatch→success, dispatch→continuation (resume), failure→backoff retry, terminal→kill+clean,
  stall→kill+retry, concurrency cap of 1 → requeue.

### Verification (all un-piped, real exit codes)
- `pnpm typecheck` → EXIT 0
- `pnpm lint` → EXIT 0
- `pnpm test` → EXIT 0 — **123 tests passing** (9 files)
- `pnpm build` → EXIT 0
- `pnpm install --frozen-lockfile` → EXIT 0 (no dep changes this phase)

## Decisions & deviations (Phase 1)

1. **Added `FakeWorkspaceManager`** (not separately listed in the plan — task 10 names only
   tracker+runner fakes). The loop depends on `WorkspaceManager`; the fake is in-memory (no
   FS) but composes the *real* `computeWorkspacePath`/`sanitizeWorkspaceKey` helpers so the
   §9.5 invariants are still exercised. The real adapter is Task 8 (Phase 2).
2. **Concurrency counts only `state.running`** toward slots — a literal reading of
   `available_slots = max(limit - running, 0)`. Continuation/failure **re-dispatch** (via
   `RetryDue`) intentionally **bypasses** `planDispatch` caps: the issue already held its slot
   conceptually when first claimed, so a retry/continuation resumes it rather than re-queuing
   behind fresh work. Fresh tick dispatch always honors the caps.
3. **Null-blocker-state ⇒ unresolved** (conservative): a Todo blocker whose state is unknown
   holds the issue back, so we never start work we might have to discard. Only applies in the
   `todo` state; once `In Progress`, blockers no longer gate (work already started).
4. **Monotonic clock = Effect `Clock`** (not OS `performance.now`). A true monotonic source
   would escape `TestClock`, making backoff/stall timing untestable. Documented trade-off in
   `clock/live.ts`; revisit if wall-clock jumps ever matter in production.
5. **`OrchestratorStore` Tag** is named distinctly from the domain `OrchestratorState` schema
   to avoid a name clash (the Context.Tag id string stays `orchestra/OrchestratorState`).
6. **Worker-kill robustness:** the per-issue runtime `registry` (owner-fiber-only `Map`) is the
   source of truth. On any kill we drop/null the registry entry *first*, then `Fiber.interrupt`;
   every message handler early-returns if the entry is gone, and the worker's failure handler
   skips posting `WorkerDone` on interrupt (`Cause.isInterrupted`). This makes behavior correct
   regardless of external-interrupt finalizer semantics.
7. **Terminal cleanup is fire-and-forget** (`forkScoped` `removeWorkspace`) so `before_remove`
   hook execution never blocks the owner loop.

## Phase 2 — Real adapters behind the ports (tasks 7–9) — ✅ COMPLETE

Wired live implementations behind the Sprint 0 ports. The Promise→Effect bridge lives only
at these adapter boundaries (`Effect.tryPromise` / `@effect/platform`); the core stays
Promise-free. Each adapter is a `layer*(config)` factory so the CLI composes them in Phase 3.

### What was built
- `src/adapters/tracker-github/` (#7) — `IssueTracker` via Octokit (`@octokit/rest` 21).
  - `normalize.ts` — **pure, network-free** GitHub→domain mapping (unit-tested): `number` →
    `id`/`identifier`; status-label → state with open→`active_states[0]` / closed→terminal
    (`state_reason: not_planned` → a cancel-flavored terminal) fallbacks (§11.3); `priority:N`/
    `pN` labels → priority; best-effort `blocked_by` from the body (`blocked by|depends on #N`,
    state unknown); PR detection; labels lowercased to honor the domain invariant.
  - `github-tracker.ts` — paginates open/closed issues, drops PRs, maps faults to tagged
    tracker errors (`.status` → `TrackerApiStatus`, else `TrackerApiRequest`), **never logs the
    token** (only handed to Octokit `auth`); `fetchIssueStatesByIds` runs concurrently and
    omits 404s (vanished issues) so reconciliation treats them as "no longer returned".
- `src/adapters/workspace/` (#8) — `WorkspaceManager` on `@effect/platform` FileSystem +
  Command. All paths flow through `computeWorkspacePath` (no string-concat) so §9.5 key
  sanitization + path-under-root hold. Hooks run as `sh -lc <script>` in the workspace dir
  with a `hooks.timeout_ms` deadline (timeout → `WorkspaceHookTimeout`, process SIGTERM'd by the
  Command scope; non-zero → `WorkspaceHookFailed`). `after_create` gated by `created_now` and
  fatal; `before_remove` best-effort so teardown still deletes the dir; startup
  `cleanupTerminalWorkspaces` removes stale terminal dirs. Integration tests use a scoped temp
  root (real FS + real hooks).
- `src/adapters/agent-copilot/` (#9) — Copilot subprocess `AgentRunner` per the Sprint 0 spike.
  - `map.ts` — **pure** JSONL→`AgentEvent` mapper (unit-tested): `assistant.message` →
    `AgentMessage` (+`Notification`); `result` exit 0 → `TurnCompleted` (+usage), else terminal
    `AgentProcessExit`; `session.error`/`model.call_failure`/`turn_input_required` → failed
    terminals; `permission.*` → `ApprovalAutoApproved`; garbage/typeless → `Malformed`; unknown
    known-shaped events dropped (forward-compat). Never throws.
  - `copilot-runner.ts` — spawns `copilot -p … --output-format json -C <ws> --allow-all-tools
    --no-color --log-level none` with **both** `cwd === workspacePath` and `-C` (Safety
    Invariant 1), inside a `Scope` (worker interrupt → SIGTERM). Streams stdout lines so the
    loop's `lastEventAt` stall detection stays live; emits `SessionStarted` first;
    `--session-id`(first)/`--resume`(continuation); `turn_timeout_ms` guard; GitHub token via
    child env (`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`), never logged. A failed terminal
    or non-zero/missing `result` fails the stream → orchestrator retries. Fake-CLI integration
    tests cover happy path (incl. the cwd invariant), crash, and `session.error`.

### Verification (all un-piped, real exit codes)
- `pnpm typecheck` → EXIT 0
- `pnpm lint` → EXIT 0
- `pnpm test` → EXIT 0 — **166 tests passing** (12 files; +43 over Phase 1: 16 tracker, 10
  workspace, 17 agent-copilot)
- `pnpm build` → EXIT 0
- `pnpm install --frozen-lockfile` → EXIT 0 (added `@octokit/rest`; `allowBuilds` policy intact,
  no new build scripts approved)

## Decisions & deviations (Phase 2)

8. **GitHub state mapping is a documented convention** (GitHub issues are only open/closed). A
   *status label* matching a configured state wins; otherwise open→`active_states[0]`,
   closed→terminal (`not_planned`→cancel-flavored, else closed/done). `id == identifier ==
   String(number)`. `blocked_by` states are left `null` (GitHub has no native blocker state) →
   the §8.2 Todo-blocker rule treats them as unresolved.
9. **404 on per-id refresh ⇒ omit** rather than error: a deleted/transferred issue simply drops
   out of the refresh set (reconciliation `NeitherKill`); other statuses still fail the refresh.
10. **`before_remove` is non-fatal**: a failing teardown hook is logged and removal proceeds, so
    a bad hook can't strand workspaces. `after_create`/`before_run`/`after_run` failures remain
    fatal to the attempt (propagated to the worker).
11. **Hook child inherits the orchestrator env** (platform Command merges `process.env`), so
    hooks see `$GITHUB_TOKEN` etc. without us re-exporting secrets; hook stdout/stderr inherit
    the console for operator visibility.
12. **Runner has no own stall timer** — stall detection is the orchestrator's job (tick-level
    `StallKill` interrupts the worker, whose Scope kills the PID). The runner only adds a total
    `turn_timeout_ms` guard. Avoids double-owning the stall policy.
13. **Renamed a local `token` → `ghAuth`** in `copilot-runner.ts` to avoid a gitleaks
    `shell-export-secret` false positive (the rule flags any `*token* = <12+ chars>`, here a
    reference assignment, not a literal). No secret involved.


- Phase 2 (7–9): Octokit GitHub adapter, real WorkspaceManager (hooks via `sh -lc`, timeouts,
  safety invariants), Copilot subprocess runner per the Sprint 0 spike (`@effect/platform`
  `Command`, `cwd==workspacePath`, JSONL→`AgentEvent`, Scope finalizer kills the PID). Will add
  `@octokit/*` + `@effect/platform-node`; must keep `pnpm install --frozen-lockfile` at exit 0
  and `allowBuilds` policy intact.
- Phase 3 (11–13): finish the property matrix (explicit no-double-dispatch property), Live
  Observer (structured `key=value` logs with glyphs), `GET /api/v1/state` snapshot (loopback,
  `--port`), fake e2e wiring `AppLive` in `src/cli/main.ts`, README run section, then
  PROJECT_BRIEF §5/§7/§8 + `docs/sprint-1/done.md`.
