# PROJECT_BRIEF.md — Orchestra

> Last updated: 2026-06-24 | Sprint 5 complete · Sprint 6 (Web Cockpit) in planning | Status: Operator experience shipped; web cockpit + control plane next
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
| CLI / daemon entry | `src/cli/main.ts`, `src/cli/daemon.ts`, `src/cli/args.ts` | ✅ created | Single daemon CLI surface. `main.ts` = `runDaemon(process.argv.slice(2))`; `daemon.ts` = `runDaemon(argv)` + `appLayer` (logfmt logger, `AppLive` Layer → `runOrchestrator` fiber + forked **cockpit server** via `runCockpit`, `runMain`); `args.ts` parses the daemon's `--port`. |
| Web cockpit (SPA) | `src/cockpit/` | ✅ created (Sprint 6) | Vite + React + TS browser cockpit served by the daemon: views Fleet/Session-overview · Kanban · Events · Settings; plain-`fetch` typed API client (`api/client.ts`, token from injected `window.__ORCHESTRA_COCKPIT_TOKEN__`); pure mappers + column derivation in vitest-tested `model/*` modules (no Effect, no DOM in the browser test path). `vite build` → `dist/cockpit/` (served statically by the `HttpApi`). |
| Cockpit API + control plane | `src/core/cockpit/{api,auth,handlers,security,server,static,token}.ts`; `src/core/orchestrator/{command,messages}.ts`; `src/core/workflow/workflow-file.ts` | ✅ created (Sprint 6) | One `@effect/platform` `HttpApi` (`CockpitApi`, `api.ts`) exposing the read snapshot + mutating endpoints (DD-1) — `snapshot-server.ts` is **gone**, replaced by the pure `snapshot.ts` projection it now serves. `command.ts` = `CommandBus` service (`Queue` + per-command `Deferred` ack) delivering operator commands through the existing serial mailbox (`Msg.Command`); `workflow-file.ts` = `WorkflowFile` service doing the atomic, secret-safe settings read/persist + hot-reload (DD-2/DD-4). `auth.ts`/`security.ts` = bearer-token + loopback-Origin/Host middleware; `static.ts` = SPA serving + token injection; `server.ts` = `runCockpit(...)`. |
| Domain model | `src/core/domain/` | ✅ created | `Schema` types: Issue, AgentEvent (union), ServiceConfig + **front-matter schema** (`workflow.ts`), Workspace, RunAttempt, LiveSession, RetryEntry, OrchestratorState |
| Ports | `src/core/ports/` | ✅ created | `IssueTracker`, `AgentRunner`, `WorkspaceManager`, `Clock` as `Context.Tag` (signatures only) |
| Errors | `src/core/errors.ts` | ✅ created | Tagged error for every SPEC error class + workspace-safety errors; unioned |
| Workflow config | `src/core/workflow/` | ✅ created | WORKFLOW.md loader, `$VAR`, path resolution, strict Liquid render (front-matter `Schema` lives in `domain/workflow.ts`); watcher deferred |
| Workspace safety | `src/core/workspace/` | ✅ created | `safety.ts` — workspace-key sanitization + path-under-root checks (used by the adapter) |
| Observability | `src/core/observability/` | ✅ created | `glyphs.ts` status design system, `live-observer.ts` (logfmt + glyphs), `snapshot.ts` (pure `GET /api/v1/state` projection, served by the cockpit `HttpApi`) |
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

> Layout reflects the **actual** Sprint 2 state. Deviations from the original plan:
> the front-matter `Schema` lives in `core/domain/workflow.ts` (not `core/workflow/`),
> a small `core/util/` was added, and the real `WorkspaceManager` lives under
> `adapters/workspace/` (the `core/workspace/` dir holds only the pure safety helpers).
> Sprint 2 split the CLI entry into a thin `main.ts` dispatcher + `daemon.ts`. Sprint 6
> removed the standalone Ink dashboard island entirely (the web cockpit under
> `src/cockpit/` + `src/core/cockpit/` supersedes it) and reduced `main.ts` to the single
> daemon path (the daemon core is unchanged).

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
| 1 | Core Orchestrator Loop | ✅ Done | Poll/dispatch/concurrency/retry/reconcile state machine, GitHub Issues adapter, Copilot subprocess runner, workspace manager, fakes + property/e2e tests, observability (logs + `--port` snapshot). Hardened in a post-merge QA pass (`fix/sprint-1-qa`, issues #17–#22). |
| 2 | Live Ink Dashboard | ✅ Done | Standalone `orchestra dashboard` (Ink/React 19) polling the loopback snapshot API: thin CLI dispatcher, defensive snapshot client + non-overlapping poller, pure view-model + honest Ink rendering (reuses the glyph design system), `connecting/live/stale` resilience, `--ascii`/`NO_COLOR`. Apache-2.0 license added. Core orchestrator untouched. |
| 3 | Observability v2 + Durability Spike | ✅ Done | Strictly-additive snapshot enrichment + new dashboard panels: live **event feed**, per-session **activity**, rich **completed/retry** (`recent_events`, `recent_completed`, `running[].last_activity`, retry wall-clock `scheduled_at`+`delay_ms`). New `RecentEvents`/`LiveActivity`/`RecentCompletions` services via a tee observer; exactly two sanctioned `loop.ts` edits. Plus the **#39 durability design spike** (`docs/sprint-3/durability-spike.md`). **Phase B durability build (#40–#43) rolled to Sprint 4** at the #39 gate. QA: SHIP-WITH-FOLLOW-UPS (#45 fixed). |
| 4 | Durable Orchestrator | ✅ Done | The daemon survives a restart. Versioned (`Schema.parseJson`) **atomic** temp+rename checkpoint at `<workspace.root>/.orchestra/state.json`, written by a scoped **debounced** writer (default 500 ms, coalesced) with a **guaranteed final flush**; corrupt/missing → rename-aside + clean start, never crashes (#40). On boot: restore bookkeeping intact, **orphaned `running` → due-immediately continuation retry** (rides existing reconcile/dispatch, exactly-once is structural), **wall-clock retry re-arm** (`scheduled_at + delay_ms`, never monotonic `due_at_ms`), one synthetic `RestoredAfterRestart` (#41). Additive `RunAttempt.{turn,failure_attempts,session_id}` + `RetryEntry.{kind,session_id}`; **opt-in self-healing session resume** (`persistence.resume_sessions`, default off) (#42). Snapshot stayed **strictly additive** (no `/api/v2`); core-loop edits minimal. #43 stabilized the pre-existing #40 debounce `TestClock` flake (deterministic, 20/20 loop), filled audited coverage gaps, and shipped the docs/handoff. Post-merge QA (Ivy) verdict **SHIP, no blockers**; two minor follow-ups fixed (#50 rate-limit field degradation, #51 `0700`/`0600` checkpoint perms). |
| 5 | Operator Experience | ✅ Done | Make spend controllable and the daemon legible. **Budget guardrails** (#53): additive optional `budget.max_total_tokens`; a pure pre-`planDispatch` guard pauses **new** dispatch at the token ceiling (in-flight work, retries, and reconcile provably untouched — no kills), emits `BudgetExceeded` once per transition, and projects a strictly-additive snapshot `budget` block + dashboard `BUDGET` panel. **Durability/restore visibility** (#54): a set-once `RestoreStatus` context service promotes #41's one-shot `RestoredAfterRestart` fact to a display-only, strictly-additive snapshot `restore` block (omitted on cold start) + dashboard `RESTORED` indicator — #41's restore stays byte-identical. **Humanized agent-event summaries** (#55): a pure, compile-checked-table `humanizeAgentEvent` renders friendly one-liners in the logfmt line and the dashboard last-activity line (unknown tags fall back to the raw label; maps by tag only, never payload; deliberately not flooded into `recent_events`). #56 audited/filled cross-feature coverage (3 new co-occurrence tests, no duplication) and shipped docs/handoff. Snapshot stayed **strictly additive** (no `/api/v2`); only #53 touched the dispatch path. Post-merge QA (Ivy) verdict **✅ SHIP** after two determinism fixes the sign-off surfaced — #60 (humanizer prototype-key own-property guard) and #61 (the residual #40 debounce flake, re-fixed in the `awaitFileExists` test helper); the `pnpm test` gate is now deterministic (117 clean full-suite runs). |
| 6 | The Web Cockpit | ✅ Done | A **daemon-served Vite+React SPA** (`src/cockpit/`) with **full operator control**, replacing the read-only Ink TUI. Backend on one `@effect/platform` `HttpApi` (`CockpitApi`) that **replaced** the hand-rolled snapshot router — `snapshot-server.ts` is gone, its read `GET /api/v1/state` re-served byte-compatibly from the pure `snapshot.ts` projection; new mutating endpoints (`POST /control/{pause,resume}`, `POST /issues/:id/{retry,cancel}`, `PUT /settings`) added (#65). Mutations reach the single state-owning fiber via a new `CommandBus` (`Queue` + per-command `Deferred` ack) through the **same serial mailbox** (`Msg.Command`) — exactly-once stays structural; operator **pause/resume** gate beside the budget gate (additive `control` block, in-flight work untouched), **retry-now**, **cancel** (interrupts only the named worker) (#64). `WorkflowFile` service live-edits + persists a **whitelisted** subset of `WORKFLOW.md` front-matter via an **atomic** write keeping the Liquid body + every `$VAR`/`api_key` **byte-identical** (resolved secrets NEVER serialized), then **hot-reloads** the safe knobs (#66). SPA: scaffold + plain-`fetch` typed client (#67), design-system parity + app shell (#68), Fleet + Events views (#69), Kanban with actionable cards (#70), Settings + global pause/resume (#71). Security: loopback bind, read token-free, mutating endpoints need a bearer token (`ORCHESTRA_COCKPIT_TOKEN` or CSPRNG, logged once; injected same-origin) + loopback-Origin/Host allowlist. Forward-only close-out (#72): the **Ink dashboard removed entirely** (`ink`/`ink-testing-library`/`react-devtools-core` dropped; `vite`/`@vitejs/plugin-react`/`react-dom` added). Issues #64–#72 (`docs/sprint-6/plan.md`, `done.md`). |

## 8. Current State (rewrite every sprint)

**What works (Sprint 6 complete — the web cockpit operator surface on the durable Sprint 4 orchestrator + Sprint 3 observability v2 + Sprint 5 budget/restore/humanize):**
- Everything from Sprint 0 (monorepo, Effect, strict `tsconfig` + **Biome**, domain `Schema`,
  ports, tagged errors, WORKFLOW.md loader, glyph design system, CI on Node 22+24).
- **Single state-owning orchestrator fiber** (`src/core/orchestrator/`): startup terminal
  cleanup → immediate tick → poll every `interval_ms`. Each tick: reconcile (stall + tracker
  refresh) → preflight validate → fetch candidates → eligibility filter + stable sort →
  dispatch within global/per-state slots → notify observers. Workers report back over an
  Effect `Queue`; no mutable state is shared across fibers. Pure cores (selection §8.2,
  concurrency §8.3, backoff §8.4, reconciliation §8.5) are property-tested. Hardened by the
  QA pass (`fix/sprint-1-qa`): retry/continuation backoff counts toward the concurrency cap,
  reconcile sees retrying issues, and `closed` issues map terminal over a lingering label.
- **Real adapters behind the Sprint 0 ports:**
  - **GitHub Issues** (`src/adapters/tracker-github/`) via Octokit — pure `normalize.ts`
    maps GitHub issues → domain (status-label / open / closed → state per §11.3; `closed`
    takes precedence over any active label), drops PRs, paginates, 404-on-refresh ⇒ omit.
    `layerGitHubTracker(config)`; Octokit's default request logger is silenced.
  - **Workspace manager** (`src/adapters/workspace/`) over `@effect/platform`
    `FileSystem`+`Command` — per-issue dirs under the sanitized workspace root, lifecycle
    hooks (`after_create`/`before_run`/`after_run`/`before_remove`) as `sh -lc` with
    `timeout_ms`; hook stdout/stderr are captured + truncated (not inherited), enforcing the
    §9.5 safety invariants. `layerWorkspaceManager(config)`.
  - **Copilot subprocess runner** (`src/adapters/agent-copilot/`) — spawns the headless
    `copilot` CLI with `cwd === workspacePath`, maps stdout JSONL → `AgentEvent` stream (pure
    `map.ts`), token via env (never logged); the Command `Scope` finalizer SIGTERMs the PID
    on interrupt/stall. `layerCopilotRunner(config)`. Per `docs/sprint-0/spike-copilot.md`.
- **CLI** = a single daemon entry (`src/cli/main.ts` → `runDaemon(process.argv.slice(2))` →
  `src/cli/daemon.ts`). `pnpm dev ./WORKFLOW.md [--port N]` loads the workflow,
  builds the Layer graph over `NodeContext`, announces startup, and runs the loop until
  interrupted (clean teardown of workers, timers, cockpit server). Workflow-load failures surface an
  actionable top-line message with the real cause (no secrets).
- **Web cockpit** (`src/cockpit/` SPA + `src/core/cockpit/` server, Sprint 6): with `--port N`
  the daemon serves a **Vite+React SPA** plus a typed `@effect/platform` `HttpApi` (`CockpitApi`)
  on loopback — the operator surface that **replaced** the read-only Ink TUI. Four views over a
  non-overlapping 2 s poll of `GET /api/v1/state` (last-good-on-error, never blanks): **Fleet**
  (running sessions with client-side elapsed/status/workspace/attempt + humanized last-activity,
  totals, budget, restore, rate-limits, and the `control` banner), **Events** (the `recent_events`
  feed, newest-first, filterable), **Kanban** (Candidate/Claimed → Running → Retrying → Completed
  via a **pure, unit-tested** derivation, with **Cancel**/**Retry-now** buttons reflecting the
  `CommandResult` and reverting on error), and **Settings** (a form over the whitelisted editable
  knobs + a prominent global **Pause/Resume** toggle). Absent snapshot field → panel omitted (the
  additive contract holds). The browser bundle is plain `fetch` + pure `model/*` mappers (no Effect,
  no DOM test stack); the token is injected as `window.__ORCHESTRA_COCKPIT_TOKEN__` and attached to
  mutating calls. **Control plane** (`src/core/orchestrator/command.ts`): every mutation reaches the
  single state-owning fiber via a `CommandBus` (`Queue` + per-command `Deferred` ack) drained into
  the **same serial mailbox** (`Msg.Command`) — exactly-once stays structural; no HTTP fiber ever
  touches the store. Operator **pause/resume** is a runtime gate beside the budget gate (`(budget.paused
  || operatorPaused) ? [] : planDispatch(...)`; additive `control: { dispatch_paused, paused_by }`
  block; in-flight work untouched), **retry-now** re-arms a backing-off issue, **cancel** interrupts
  only the named worker. **Settings** (`src/core/workflow/workflow-file.ts`): `GET /api/v1/settings`
  returns a whitelisted, secret-free subset of the raw front-matter; `PUT` validates a typed patch,
  applies it to **only** the whitelisted RAW keys, re-serializes the Liquid body **verbatim**, writes
  **atomically** (semaphore-serialized temp+rename), then issues `ReloadConfig` to hot-apply the safe
  knobs next tick **without killing in-flight work**. Secrets (`$VAR`, `tracker.api_key`) never reach
  the wire or the disk-write path. **Security:** loopback bind; read endpoints token-free; mutating
  endpoints require an `Authorization: Bearer <token>` (`ORCHESTRA_COCKPIT_TOKEN` or a CSPRNG hex token
  logged once at INFO) **and** a loopback `Origin`/`Host` (401 missing token, 403 cross-origin).
- **Observability** (`src/core/observability/`): one structured logfmt line per event with
  `issue_id`/`issue_identifier`/`session_id` context + status glyphs. **Observability v2** adds a
  bounded **`RecentEvents`** ring (cap 200, display-safe, monotonic `seq`), **`LiveActivity`**
  (per-issue last agent activity, cap 256), and **`RecentCompletions`** (rich finished ring, cap
  50) — all fed by a **tee observer** that preserves the logfmt output byte-for-byte AND appends
  to the rings (high-volume `AgentEvent` + loop-cadence ticks are dropped from the feed). The
  loopback-only `GET /api/v1/state` snapshot (a pure `snapshot.ts` projection served by the cockpit
  `HttpApi` behind `--port`) is **strictly additive**: existing
  fields byte-compatible (`completed` IDs-only, monotonic `due_at_ms` unchanged) plus
  `recent_events`, `recent_completed`, `running[].last_activity`, and retry `scheduled_at`+`delay_ms`.
- **Durability** (`src/core/persistence/`, Sprint 4): the daemon **survives a restart**. State is
  checkpointed to `<workspace.root>/.orchestra/state.json` by a scoped **debounced** writer
  (default 500 ms, bursts coalesced via a `Queue.sliding(1)` dirty signal) using an **atomic**
  temp-file + `rename`, with a **guaranteed final flush** on shutdown; the payload is **versioned**
  (`Schema.parseJson`, ISO `Date`s, forward-only `migrateToCurrent` seam). A transparent
  `layerDurableOrchestratorStore` is a drop-in for `layerOrchestratorStore`, so `loop.ts`/the
  snapshot projection are unedited. On boot the loop restores the full state then reconciles:
  bookkeeping (completed/totals/rate-limits) survives intact; each **orphaned `running` issue
  becomes a due-immediately continuation retry** that rides the existing retry → reconcile →
  dispatch path (tracker reconcile gates terminal/vanished first — exactly-once is **structural**,
  not best-effort); **retries re-arm from wall-clock** (`scheduled_at + delay_ms`, never the
  monotonic `due_at_ms`); a **corrupt or missing** file → rename-aside (`state.json.corrupt-<ts>`)
  + clean start, **never a crash**. Observability rings are not persisted — they boot empty and
  emit one synthetic `RestoredAfterRestart` so the feed gap is honest. Agent **session resume** is
  **opt-in** (`persistence.resume_sessions`, default off) and **self-healing** — a stale session
  falls back to a fresh turn against the on-disk workspace (the true record of progress). All
  persisted continuity fields (`RunAttempt.{turn,failure_attempts,session_id}`,
  `RetryEntry.{kind,session_id}`) are optional/additive; `/api/v1/state` stayed strictly additive.
- **Operator experience** (Sprint 5): the daemon's spend is controllable and its state legible.
  - **Budget guardrails** (`src/core/orchestrator/budget.ts`, #53): an additive optional
    `budget.max_total_tokens` config. A **pure** `evaluateBudget` runs once per tick as a
    pre-`planDispatch` guard — when cumulative agent spend (`agent_totals.total_tokens`)
    reaches the ceiling the loop plans **zero** fresh dispatches (`toDispatch = paused ? [] :
    planDispatch(...)`). It pauses **NEW** dispatch only: in-flight workers, pending retries
    (the separate `handleRetryDue` path), and reconcile are provably untouched — no kills, no
    change to concurrency/retry math. A runtime latch emits one `BudgetExceeded` observation
    per pause/resume transition (no per-tick spam), rendered in the feed + logfmt. Absent
    ceiling → inert. The optional USD cost ceiling was intentionally deferred; the runtime
    *resume* path is unreachable in production today (spend only grows, config loads once) but
    stays correct for a future config-reload.
  - **Durability/restore visibility** (`src/core/observability/restore-status.ts`, #54): a
    set-once `RestoreStatus` context service (same family as `LiveActivity`/`RecentCompletions`)
    holds #41's boot-time `RestoreSummary`, written **once** by the loop on the same path that
    emits `RestoredAfterRestart` (cold start → never recorded). Display-only; #41's restore stays
    byte-identical.
  - **Humanized agent-event summaries** (`src/core/observability/humanize.ts`, #55): a pure,
    total, never-blank `humanizeAgentEvent` maps each `AgentEvent` tag to a friendly one-liner
    via a compile-checked `Record<AgentEventTag, string>` table (a new variant trips a type
    error; unknown tags fall back to the raw label). It maps by **tag only** — never agent
    payload — so it can't leak issue content. Wired into the logfmt line and per-issue
    `LiveActivity.message` (which flows onto `running[].last_activity`); deliberately **not**
    pushed into `recent_events` (per-turn chatter would flood the feed).
  - All three are **strictly additive** on `/api/v1/state` — the `budget` block appears only
    when a ceiling is configured, the `restore` block only after a real boot-time restore, and
    the humanized `last_activity.message` rides an already-existing field — so a pre-Sprint-5
    the humanized `last_activity.message` rides an already-existing field — so a pre-Sprint-5
    client renders identically. The cockpit adds a `BUDGET` panel (active vs. paused), a
    `RESTORED` indicator (`⟳ restored after restart · n running · n retrying · n completed ·
    restored Xs ago`), and prefers the humanized message over the raw tag on each running issue's
    last-activity line (falling back to the tag for older daemons).
- **License:** Apache-2.0 (`LICENSE` + `NOTICE`; `package.json` `"license": "Apache-2.0"`).
- **Tests:** **347 passing** (vitest + @effect/vitest + fast-check) — pure
  unit + property (no-double-dispatch, concurrency caps incl. retry-backoff, backoff
  monotonic/capped), full-loop fake scenarios under `TestClock`, adapter integration tests,
  a combined fake e2e, the `RecentEvents` ring + snapshot-enrichment suites, the **durability suites**
  — persisted-state codec fixed-point + additive-field
  survival, atomic save/load + corruption rename-aside, debounce gating/coalescing/final-flush
  under `TestClock` (deterministic — the #40 debounce flake was narrowed in #43 and fully closed in
  **#61**, whose `awaitFileExists` test helper now bounds on a real wall-clock deadline rather than a
  `setImmediate`-iteration count), and the
  restore/reconcile/re-arm + opt-in-resume scenarios, **the
  Sprint 5 operator suites** — the pure budget evaluator + config decode + additive snapshot
  projection (`budget-pure`), the loop-level dispatch gate proving in-flight work is untouched
  (`budget-gate`), the set-once restore holder + projection (`restore-pure`) and its real-loop
  capture (`restore-reconcile`), the compile-checked humanizer table + fallback (`humanize`), and a
  **cross-feature** suite pinning all three additive blocks co-occurring on one snapshot (now decoded
  through the cockpit's `toFleetView`), **plus the Sprint 6 cockpit suites** — the command-control
  loop test (operator-pause withholds new dispatch only; cancel scoped to one fiber; the `RetryNow`↔
  firing-backoff race proven exactly-once), the cockpit `HttpApi` auth matrix (401/403/200) +
  read-wire byte-compatibility round-trip, the secret-safe settings read/persist (`tracker.api_key`
  + Liquid body byte-identical across a write; invalid patch rejected before the write lands;
  overlapping PUTs both land via the `Semaphore(1)`), the token-bootstrap injection (incl. a
  `</script>`-bearing token escaped), and the pure cockpit `model/*` mappers (poller, fleet, events,
  kanban, settings, client, design). `pnpm typecheck` (both tsconfigs) `/lint/test/build` and
  `pnpm install --frozen-lockfile` all green; a live e2e smoke confirmed the built daemon serves the
  cockpit (HTML token injection, read snapshot, secret-free settings, the 401/403/200 pause matrix,
  and operator-pause reflected in the snapshot `control` block).

**What doesn't work yet (Sprint 7+):**
- **Session resume is unproven against a live Copilot.** `persistence.resume_sessions` is
  default-off and self-healing by design; enabling it for real workloads needs an integration
  validation that Copilot honors `--resume` across daemon downtime (today only the fake-agent
  self-heal path is tested). Sprint 5 surfaces *that* a restore happened (#54), not whether session
  resume itself works. Schema migration is V1-only (the `migrateToCurrent` seam awaits its first
  real bump).
- **Budget is token-only.** The optional USD cost ceiling (`max_cost_usd` +
  `usd_per_million_tokens`) was intentionally deferred — a clean, separately-addable follow-up.
- No live PR creation / branch push flow, no GitHub status write-back beyond reading issues.
- WORKFLOW.md hot-reload is now driven by the cockpit's `PUT /api/v1/settings` (the whitelisted,
  safe-knob subset); a general file-watcher for out-of-band edits is still deferred.
- **Cockpit known/intentional limitations (Sprint 6, accepted):** the Kanban **Claimed** column is
  **count-only** — the snapshot wire emits `counts.claimed` but not claimed issue IDs, so real
  Claimed cards would need an additive backend change (out of scope); the UI poll cadence is fixed
  at 2 s (`COCKPIT_POLL_MS`); and cockpit test coverage is **pure-module unit only** (no jsdom/DOM
  test stack, per the dependency budget). The event feed is still a **bounded recent ring**, not a
  long-term forensic timeline / raw-stdout log tail.
- Not yet exercised against a real GitHub repo + live Copilot in CI (adapters are unit-tested;
  the loop is proven against fakes). Manual real-repo validation is the operator's step.

**What's next:**
- **Sprint 7 — TBD.** The web cockpit is the live operator surface; remaining carry-forwards are a
  live-Copilot session-resume validation, the optional USD budget ceiling, the PR write-back flow,
  and a general WORKFLOW.md file-watcher (`docs/sprint-5/done.md` + `docs/sprint-6/done.md`
  carry-forwards).

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
- Structured JSON logs to stdout/stderr; optional `--port` serves the **web cockpit** + JSON
  API (`GET /api/v1/state` + control endpoints), loopback-bound by default.
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
