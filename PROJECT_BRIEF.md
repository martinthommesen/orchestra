# PROJECT_BRIEF.md — Orchestra

> Last updated: 2026-06-23 | Sprint 0 complete | Status: Foundations ready for Sprint 1
>
> **This file is the single source of truth across all team chats.** Each chat is a
> fresh context — this file and `docs/sprint-N/progress.md` are the only things that
> survive. Keep it accurate.

## 1. Project Overview

Orchestra is an end-to-end type-safe TypeScript reimplementation of OpenAI's
[Symphony](https://github.com/openai/symphony). It is a long-running daemon that
continuously reads work from an issue tracker, creates an isolated workspace per
issue, and runs a **GitHub Copilot** coding-agent session for that issue with
bounded concurrency, exponential-backoff retries, tracker reconciliation, and
operator observability. The goal: let a team **manage the work** instead of
supervising coding agents. Where Symphony drives Codex app-server in Elixir/OTP,
Orchestra drives the **GitHub Copilot SDK / headless CLI** in TypeScript on
**[Effect](https://effect.website)**.

## 2. Concept / Product Description

A developer adopts Orchestra by dropping a single `WORKFLOW.md` file (YAML front
matter + a Liquid prompt body) into their repo and running `orchestra ./WORKFLOW.md`.
Orchestra then:

1. **Polls** the tracker (GitHub Issues in v1) on a fixed cadence for candidate
   issues in active states.
2. **Claims** eligible issues (respecting required labels, blockers, and global +
   per-state concurrency limits) so they are never double-dispatched.
3. **Creates** a deterministic per-issue workspace under `workspace.root`, running
   lifecycle hooks (`after_create`, `before_run`, …).
4. **Runs** a GitHub Copilot session in that workspace, rendering the per-issue
   prompt from the `WORKFLOW.md` body, streaming normalized agent events back to the
   orchestrator, and continuing additional turns (up to `max_turns`) while the issue
   stays active.
5. **Reconciles** every tick: stalls are killed and retried; issues that move to a
   terminal tracker state stop their worker and clean their workspace.
6. **Retries** failures with exponential backoff; schedules short continuation
   retries after clean exits.
7. **Surfaces** structured logs and an optional JSON snapshot of runtime state.

Ticket writes (comments, state transitions, PR links) are performed by the Copilot
agent via its tools — Orchestra is a scheduler/runner and tracker *reader*. A
successful run ends at a workflow-defined handoff state (e.g. `Human Review`), not
necessarily `Done`.

## 3. Tech Stack

- **Language:** TypeScript (strict), Node.js 24 (CI matrix 22 + 24).
- **Core runtime:** **Effect** — typed errors, `Layer` DI, fibers/structured
  concurrency, `Schedule` retries, `Scope` resource lifecycle, `Schema` validation,
  `TestClock` for time-travel tests.
- **Package manager / build:** **pnpm workspace** monorepo; `tsc` for builds;
  `tsup`/`tsx` for bundling/running as needed.
- **Coding agent:** GitHub Copilot — **subprocess** (headless `copilot`) by default;
  in-process `@github/copilot` SDK evaluated by the Sprint 0 spike. Both behind the
  `AgentRunner` port.
- **Tracker:** GitHub Issues via Octokit (`@octokit/*`), behind the `IssueTracker`
  port (spec-normalized `Issue`).
- **Config/templating:** YAML front matter (validated by `Schema`) + strict
  **Liquid** prompt rendering (`liquidjs`, strict variables/filters).
- **Testing:** `vitest` + `@effect/vitest` + `fast-check` (property tests).
- **Lint/format:** ESLint + Prettier (or Biome — finalize in Sprint 0).
- **CI/CD:** GitHub Actions (typecheck, lint, unit, fake e2e).

## 4. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                          CLI / Daemon                          │
│  orchestra ./WORKFLOW.md   → builds Effect Layers, runs loop    │
│  Structured logs (Logger) + OPTIONAL GET /api/v1/state snapshot │
└───────────────┬───────────────────────────────────────────────┘
                │ provides Layers
┌───────────────▼───────────────────────────────────────────────┐
│                    Orchestrator (single fiber)                  │
│  Poll tick: reconcile → preflight validate → fetch candidates   │
│  → sort → dispatch within concurrency slots                     │
│  Owns OrchestratorState (running/claimed/retry/totals)          │
│  Workers report outcomes via Effect Queue                       │
└───┬───────────────┬───────────────┬───────────────┬────────────┘
    │ port          │ port          │ port          │ port
┌───▼──────┐  ┌─────▼───────┐  ┌────▼─────────┐  ┌──▼──────────┐
│IssueTrack│  │ AgentRunner │  │ Workspace    │  │ WorkflowCfg │
│(GitHub)  │  │ (Copilot    │  │ Manager      │  │ loader +    │
│Octokit → │  │ subprocess  │  │ per-issue    │  │ Schema +    │
│normalized│  │ → AgentEvent│  │ dirs, hooks, │  │ Liquid +    │
│Issue     │  │ Schema      │  │ path safety  │  │ hot reload  │
└──────────┘  └─────────────┘  └──────────────┘  └─────────────┘
                        │ launches (cwd = workspace)
                ┌───────▼────────┐
                │ GitHub Copilot  │  per-issue session, ≤ max_turns
                │ (child process) │  turns stream → normalized events
                └────────────────┘
```

## 5. Key Files Map

| Area | Path | Status | Contents |
|------|------|--------|----------|
| CLI / daemon entry | `src/cli/main.ts`, `src/cli/args.ts` | ✅ created | Arg parsing (`args.ts`, incl. `--port`), `AppLive` Layer wiring → `runOrchestrator` fiber (+ forked snapshot server), logfmt logger, `runMain`. |
| Domain model | `src/core/domain/` | ✅ created | `Schema` types: Issue, AgentEvent (union), ServiceConfig + **front-matter schema** (`workflow.ts`), Workspace, RunAttempt, LiveSession, RetryEntry, OrchestratorState |
| Ports | `src/core/ports/` | ✅ created | `IssueTracker`, `AgentRunner`, `WorkspaceManager`, `Clock` as `Context.Tag` (signatures only) |
| Errors | `src/core/errors.ts` | ✅ created | Tagged error for every SPEC error class + workspace-safety errors; unioned |
| Workflow config | `src/core/workflow/` | ✅ created | WORKFLOW.md loader, `$VAR`, path resolution, strict Liquid render (front-matter `Schema` lives in `domain/workflow.ts`); watcher deferred |
| Workspace safety | `src/core/workspace/` | ✅ created | `safety.ts` — workspace-key sanitization + path-under-root checks (used by the adapter) |
| Observability | `src/core/observability/` | ✅ created | `glyphs.ts` status design system, `live-observer.ts` (logfmt + glyphs), `snapshot-server.ts` (loopback `GET /api/v1/state`) |
| Util | `src/core/util/` | ✅ created | Small shared helpers (e.g. `errorMessage`) |
| Orchestrator | `src/core/orchestrator/` | ✅ created | Single state-owning fiber: state service, selection, concurrency, backoff, reconciliation, preflight, poll loop, `Observer` |
| GitHub adapter | `src/adapters/tracker-github/` | ✅ created | Octokit client + pure `normalize.ts` (GitHub→domain), `layerGitHubTracker(config)` |
| Workspace adapter | `src/adapters/workspace/` | ✅ created | FileSystem+Command `WorkspaceManager`: dir lifecycle + hooks (`sh -lc`, timeouts), `layerWorkspaceManager(config)` |
| Copilot runner | `src/adapters/agent-copilot/` | ✅ created | Subprocess runner → `AgentEvent` stream (pure `map.ts` JSONL→event), `layerCopilotRunner(config)`; per `docs/sprint-0/spike-copilot.md` |
| Test fakes | `test/fakes/` | ✅ created | `FakeTracker`, `FakeAgentRunner`, `FakeWorkspaceManager`, `RecordingObserver`, harness |
| CI | `.github/workflows/ci.yml` | ✅ created | typecheck + lint + test + build on Node 22+24 |
| Sprint docs | `docs/sprint-N/` | ✅ | Plans, progress, done, spike |
| Brainstorm | `docs/brainstorm/` | ✅ | Architecture debate that set these decisions |
| Reference spec | (external) | — | https://github.com/openai/symphony/blob/main/SPEC.md |

> Layout reflects the **actual** Sprint 1 state. Deviations from the original plan:
> the front-matter `Schema` lives in `core/domain/workflow.ts` (not `core/workflow/`),
> a small `core/util/` was added, and the real `WorkspaceManager` lives under
> `adapters/workspace/` (the `core/workspace/` dir holds only the pure safety helpers).

## 6. Team Roles

| Agent | Name | Role |
|-------|------|------|
| Producer | Remy | Sprint plans, coordination, merging, issue triage. **Never writes code.** |
| Product | Kira | DX, WORKFLOW.md ergonomics, feature specs |
| Art/CLI | Milo | Status-glyph + color design system, log/TUI ergonomics |
| Frontend/Runtime | Nova | Effect core wiring, CLI, `docs/effect-guide.md` |
| Backend | Sage | Orchestrator state machine, ports, tracker + agent adapters, errors |
| DevOps | Dash | CI/CD, containerization, subprocess isolation, daemon ops |
| QA | Ivy | Fakes, property tests, fake e2e, sign-off |

## 7. Sprint Status

| Sprint | Name | Status | Scope |
|--------|------|--------|-------|
| 0 | Architecture & Foundations | ✅ Done | pnpm monorepo scaffold, Effect setup, domain `Schema` types, ports, WORKFLOW.md loader, tagged errors, CI, **Copilot integration spike** |
| 1 | Core Orchestrator Loop | ✅ Done | Poll/dispatch/concurrency/retry/reconcile state machine, GitHub Issues adapter, Copilot subprocess runner, workspace manager, fakes + property/e2e tests, observability (logs + `--port` snapshot) |

## 8. Current State (rewrite every sprint)

**What works (Sprint 1 complete — core orchestrator loop):**
- Everything from Sprint 0 (monorepo, Effect, strict `tsconfig` + **Biome**, domain `Schema`,
  ports, tagged errors, WORKFLOW.md loader, glyph design system, CI on Node 22+24).
- **Single state-owning orchestrator fiber** (`src/core/orchestrator/`): startup terminal
  cleanup → immediate tick → poll every `interval_ms`. Each tick: reconcile (stall + tracker
  refresh) → preflight validate → fetch candidates → eligibility filter + stable sort →
  dispatch within global/per-state slots → notify observers. Workers report back over an
  Effect `Queue`; no mutable state is shared across fibers. Pure cores (selection §8.2,
  concurrency §8.3, backoff §8.4, reconciliation §8.5) are property-tested.
- **Real adapters behind the Sprint 0 ports:**
  - **GitHub Issues** (`src/adapters/tracker-github/`) via Octokit — pure `normalize.ts`
    maps GitHub issues → domain (status-label / open / closed → state per §11.3), drops PRs,
    paginates, 404-on-refresh ⇒ omit. `layerGitHubTracker(config)`.
  - **Workspace manager** (`src/adapters/workspace/`) over `@effect/platform`
    `FileSystem`+`Command` — per-issue dirs under the sanitized workspace root, lifecycle
    hooks (`after_create`/`before_run`/`after_run`/`before_remove`) as `sh -lc` with
    `timeout_ms`, enforcing the §9.5 safety invariants. `layerWorkspaceManager(config)`.
  - **Copilot subprocess runner** (`src/adapters/agent-copilot/`) — spawns the headless
    `copilot` CLI with `cwd === workspacePath`, maps stdout JSONL → `AgentEvent` stream (pure
    `map.ts`), token via env (never logged); the Command `Scope` finalizer SIGTERMs the PID
    on interrupt/stall. `layerCopilotRunner(config)`. Per `docs/sprint-0/spike-copilot.md`.
- **CLI wired** (`src/cli/main.ts`): `pnpm dev ./WORKFLOW.md [--port N]` loads the workflow,
  builds the Layer graph over `NodeContext`, announces startup, and runs the loop until
  interrupted (clean teardown of workers, timers, server).
- **Observability** (`src/core/observability/`): one structured logfmt line per event with
  `issue_id`/`issue_identifier`/`session_id` context + status glyphs; optional loopback-only
  `GET /api/v1/state` JSON snapshot (running/retrying/completed/totals/rate_limits) behind
  `--port`.
- **Tests:** **178 passing** across 15 files (vitest + @effect/vitest + fast-check) — pure
  unit + property (no-double-dispatch, concurrency caps, backoff monotonic/capped), full-loop
  fake scenarios under `TestClock`, adapter integration tests, and a combined fake e2e.
  `pnpm typecheck/lint/test/build` and `pnpm install --frozen-lockfile` all green.

**What doesn't work yet (Sprint 2+):**
- No live PR creation / branch push flow, no GitHub status write-back beyond reading issues.
- WORKFLOW.md hot-reload (watcher) still deferred.
- Snapshot API is read-only and single endpoint; no control plane, auth, or metrics export.
- Not yet exercised against a real GitHub repo + live Copilot in CI (adapters are unit-tested;
  the loop is proven against fakes). Manual real-repo validation is the operator's step.

**What's next:**
- Producer to open the PR for `feature/sprint-1`, verify CI green on Node 22+24, and merge.
- Plan Sprint 2 on these foundations (real-repo hardening, PR/branch flow, richer observability).

## 9. Security Rules

1. **Secrets live in environment variables only** — never in code or git. `WORKFLOW.md`
   supports `$VAR` indirection; resolve at use, validate presence without printing.
2. **Never log tokens or secret env values.** Truncate hook output in logs.
3. **Workspace path safety (mandatory, spec §9.5/§15.2):**
   - The Copilot subprocess `cwd` MUST equal the per-issue `workspace_path`.
   - `workspace_path` MUST stay under the normalized absolute `workspace.root`.
   - Workspace keys MUST be sanitized: allow `[A-Za-z0-9._-]`, replace others with `_`.
4. **Hooks are fully trusted shell** from `WORKFLOW.md`; enforce `hooks.timeout_ms`
   so a hook can never hang the orchestrator; truncate hook output in logs.
5. **Document the trust posture.** v1 targets trusted environments and must state its
   approval/sandbox policy (mirrors spec §15.1) in the README before any public push.
6. **Least-privilege GitHub auth** — a token scoped to the target repo's Issues/PRs.

## 10. How to Run Locally

> ⚠️ Scaffold is created in Sprint 0. Commands below are the **planned** interface;
> Sprint 0's `done.md` will confirm the exact commands.

```bash
pnpm install
cp WORKFLOW.example.md WORKFLOW.md     # then edit for your repo/project
export GITHUB_TOKEN=...                 # least-privilege repo token
pnpm dev ./WORKFLOW.md                  # run the daemon against your WORKFLOW.md
pnpm test                               # unit + property tests
pnpm typecheck && pnpm lint
```

## 11. How to Deploy

Orchestra is a daemon, deployed as a long-running process:

- Build: `pnpm build` → `dist/`.
- Run `node dist/cli/main.js ./WORKFLOW.md` under a supervisor (systemd/launchd) or
  in a container (Sprint 0/Dash provides a `Dockerfile` + recipe).
- Provide secrets via environment (`GITHUB_TOKEN`, any `$VAR`s referenced in
  `WORKFLOW.md`).
- Structured JSON logs to stdout/stderr; optional `--port` enables the JSON snapshot
  API (`GET /api/v1/state`), loopback-bound by default.
- Graceful shutdown on SIGTERM; in-memory scheduler state is intentionally not
  persisted (restart recovery is tracker- + filesystem-driven per spec §14.3).

## 12. Cross-Chat Handoff Protocol

Every sprint chat MUST do these before finishing:

1. Write `docs/sprint-N/done.md` — what was built, what's not done, what needs manual
   setup, and files changed/created.
2. Update this brief: **Section 7** (mark sprint status) + **Section 8** (rewrite
   current state). Update **Section 5** if the source layout changed.
3. Commit all changes with a descriptive message: `sprint-N: <summary>`.

This is how context survives across chats. If skipped, the next chat starts blind and
may overwrite or duplicate work. **The repo is the shared memory — keep it accurate.**

## 13. Bug & Fix Tracking

Bugs are tracked as **GitHub Issues** on the repo — the single source of truth for
all teams. (Until the remote is created, track in `docs/sprint-N/progress.md` and
migrate to Issues when the remote exists.)

**For QA (Ivy):** File bugs as GitHub Issues with labels (`bug`,
`severity:blocker/major/minor`). Include: component, steps to reproduce, expected vs
actual. When no blockers found, write `docs/qa/sprint-N-signoff.md` with test count,
pass rate, and an explicit "no blockers" statement.

**For Dev Team (Nova/Sage/Milo):** Check GitHub Issues before starting. Fix blockers
and majors before polish. Use closing keywords in commits: `fix: description
(Fixes #42)`. For reference-only, use `Refs #42`. One commit per fix.

**For DevOps (Dash):** File infrastructure issues with label `infra`.

**For feature ideas:** add to `docs/ideas-backlog.md`.

> **Issue-tracker discipline:** never weaken or silently close a `ready-for-human`
> gate issue or soften its acceptance criteria; capture extra value as new,
> separately-numbered issues instead.

## 14. Multi-Repo Setup

Each team works in its own separate clone of the repo. No worktrees. Everyone works
on their own branch, pushes to origin, and opens PRs.

**Teams:**
- Producer (Remy) on `main` — coordination hub.
- Dev Team on `feature/sprint-N`.
- QA on `feature/qa-N`.
- DevOps on `feature/devops-N` (only when needed).

**Setup:**
```bash
git clone <repo> orchestra-dev      # or orchestra-qa / orchestra-devops
cd orchestra-dev
git checkout -b feature/sprint-N
pnpm install
```

**Branch strategy:** Feature branch → PR → **regular merge** to main. Never push
directly to main. Never squash. **Never rebase** feature branches (causes commit
loss when multiple chats contribute).

> Remote not yet created. The Producer offers to create it and seed Issues from the
> Sprint 1 task list at the end of bootstrap. Until then, `main` is local-only.
