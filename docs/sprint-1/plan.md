# Sprint 1 — Core Orchestrator Loop

> Sprint Goal: Implement the Symphony control loop end-to-end — poll → claim →
> workspace → one Copilot session (with continuation turns) → reconcile → retry —
> against GitHub Issues, proven first on fakes and then wired to real GitHub +
> Copilot.
> Branch: feature/sprint-1
> Estimated effort: ~1 sprint (the heart of v1)
> Depends on: Sprint 0 (scaffold, domain Schema, ports, errors, WORKFLOW loader,
> Copilot spike recommendation).

## Prioritized Task List

| #   | Task                                    | Owner       | Est  | Description                                                                                                                                                                                                                                                                                                                                                                                                                   | SPEC           |
| --- | --------------------------------------- | ----------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `OrchestratorState` service             | Sage        | 1.5h | In-memory authoritative state behind a service: `running`, `claimed`, `retry_attempts`, `completed`, `codex_totals`, `rate_limits`, effective `poll_interval_ms`/`max_concurrent_agents`. All mutations serialized through one fiber.                                                                                                                                                                                         | §4.1.8, §7     |
| 2   | Candidate selection + sorting           | Sage        | 1.5h | Eligibility predicate (active state, not terminal, required labels, not running/claimed, slots available, Todo-blocker rule) + stable sort (priority asc, created_at oldest, identifier tiebreak). Pure, property-tested.                                                                                                                                                                                                     | §8.2           |
| 3   | Concurrency control                     | Sage        | 1h   | Global `available_slots = max(limit - running, 0)` + per-state limits (`max_concurrent_agents_by_state`, normalized keys, fallback to global). Property tests for caps.                                                                                                                                                                                                                                                       | §8.3           |
| 4   | Retry + backoff                         | Nova        | 1.5h | Continuation retry = fixed 1000ms after clean exit; failure retry = `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`. Timer mgmt via Effect `Schedule`/`Clock`; cancel existing timer on reschedule. `TestClock` tests.                                                                                                                                                                                                     | §8.4           |
| 5   | Reconciliation                          | Sage        | 2h   | Each tick: (A) stall detection — kill+retry when `elapsed > stall_timeout_ms` (skip if ≤0); (B) tracker state refresh — terminal → kill+clean workspace, active → update snapshot, neither → kill without cleanup; refresh failure → keep workers.                                                                                                                                                                            | §8.5           |
| 6   | Poll loop assembly                      | Sage        | 1.5h | Startup: validate config, startup terminal cleanup, immediate tick, then every `interval_ms`. Tick: reconcile → preflight validate → fetch candidates → sort → dispatch within slots → notify observers. Per-tick validation failure skips dispatch but still reconciles.                                                                                                                                                     | §6.3, §8.1     |
| 7   | GitHub Issues adapter                   | Sage        | 2.5h | Implement `IssueTracker` with Octokit: `fetchCandidateIssues` (active states, pagination), `fetchIssuesByStates` (startup cleanup), `fetchIssueStatesByIds` (reconciliation). Normalize GitHub issue → spec `Issue` (number→identifier, labels lowercased, open/closed+project status→state, blocked-by from linked issues, priority from label convention). Map errors to tagged tracker errors. Document the field mapping. | §11            |
| 8   | Workspace manager                       | Dash        | 2h   | Implement `WorkspaceManager`: sanitized per-issue dir under `workspace.root`, `created_now` gating, hooks (`after_create`/`before_run`/`after_run`/`before_remove`) via `sh -lc` with `hooks.timeout_ms`, **safety invariants** (cwd==workspace, path under root, sanitized key), startup terminal cleanup.                                                                                                                   | §9             |
| 9   | Copilot agent runner                    | Sage + Dash | 3h   | Implement `AgentRunner` per the Sprint 0 spike recommendation (subprocess default): create/reuse workspace → build prompt from WORKFLOW template (`issue`, `attempt`) → launch Copilot in `cwd=workspace` → stream → normalize to `AgentEvent` → forward to orchestrator `Queue`. First turn = full prompt; continuation turns = guidance only, same thread, up to `max_turns`. Map timeouts/exit to tagged errors.           | §10, §12, §7.1 |
| 10  | Fakes                                   | Ivy         | 1.5h | `FakeTracker` (scriptable candidate/state responses) + `FakeAgentRunner` (scriptable `AgentEvent` sequences incl. failure/stall/continuation). Enable deterministic full-loop tests with `TestClock`.                                                                                                                                                                                                                         | —              |
| 11  | Orchestration property + scenario tests | Ivy         | 2.5h | Property tests: never double-dispatch a claimed issue; concurrency never exceeds caps; backoff monotonic & capped. Scenario tests on fakes: dispatch → success+continuation; failure → backoff retry; issue→terminal mid-run → kill+clean; stall → kill+retry; slots full → requeue.                                                                                                                                          | §7, §8         |
| 12  | Observability: logs + JSON snapshot     | Nova + Milo | 1.5h | Structured `key=value` logs with `issue_id`/`issue_identifier`/`session_id` context (using Milo's glyphs). Optional `GET /api/v1/state` snapshot (running, retrying, totals, rate_limits) per §13.3/§13.7 when `--port` set; loopback-bound.                                                                                                                                                                                  | §13            |
| 13  | Fake end-to-end + docs                  | Ivy + Nova  | 1.5h | One e2e wiring `FakeTracker` + `FakeAgentRunner` through the real orchestrator proving the whole loop without network. Update README run section.                                                                                                                                                                                                                                                                             | —              |

## Work Schedule

### Phase 1: State machine on fakes (tasks 1–6, 10)

- Build the orchestrator pure-logic core + fakes; full loop runs deterministically
  with `TestClock`. **Do not touch real network/Copilot yet.**
- Checkpoint commit.

### Phase 2: Real adapters (tasks 7–9)

- GitHub Issues adapter, workspace manager, Copilot runner. Wire behind the ports.
- Checkpoint commit.

### Phase 3: Observability + verification (tasks 11–13)

- Property/scenario tests, logs + snapshot API, fake e2e, docs.
- Final commit.

## Success Criteria

- [ ] Full loop runs against fakes via `TestClock` with no real timers/network.
- [ ] Property tests pass: no double-dispatch; concurrency caps respected; backoff
      monotonic and capped.
- [ ] Against a real test repo: an open, labeled issue is picked up, a workspace is
      created, a Copilot session runs in `cwd=workspace`, and the issue moving to
      closed stops + cleans the worker.
- [ ] Continuation turns run up to `max_turns`; first turn uses full prompt,
      continuations use guidance only.
- [ ] Reconciliation handles terminal/active/neither + refresh-failure correctly.
- [ ] Structured logs carry required context fields; `--port` exposes
      `GET /api/v1/state`.
- [ ] All Sprint 0 safety invariants enforced (cwd, path-under-root, sanitized key,
      no secret logging).
- [ ] CI green on Node 22 + 24.

## What's NOT in This Sprint

| Feature                          | Reason                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| Linear adapter                   | v1 is GitHub-only (ideas-backlog)                              |
| Ink TUI / web HTML dashboard     | Post-v1; v1 = logs + JSON snapshot                             |
| Durable scheduler state          | Spec is in-memory; durability is additive later                |
| SSH/remote workers               | Post-v1                                                        |
| Hot-reload of in-flight sessions | Spec doesn't require restarting live sessions on config change |

## Agent Prompt

> Read PROJECT_BRIEF.md, then read docs/sprint-1/plan.md. Execute Sprint 1.
>
> First: git pull origin main && git checkout -b feature/sprint-1
>
> Take your time, do it right. Build Phase 1 entirely on fakes with TestClock before
> touching real GitHub or Copilot. The orchestrator is a single state-owning fiber;
> workers report via a Queue — never share mutable state across fibers.
> Close GitHub Issues in commits: "fix: description (Fixes #NN)". One commit per fix.
> Update docs/sprint-1/progress.md after each phase.
> When done, push and open a PR. Follow Sections 12–14 of PROJECT_BRIEF.md.

## Suggested GitHub Issues (seed from this plan)

Each task above → one issue, labeled by area: `area:orchestrator` (1–6), `area:tracker`
(7), `area:workspace` (8), `area:agent` (9), `area:testing` (10,11,13),
`area:observability` (12). Add `sprint:1`. Blockers: 9 depends on the Sprint 0 spike;
6 depends on 1–5; 11/13 depend on 10.
