# Architecture

Orchestra is a TypeScript daemon that orchestrates GitHub Copilot coding-agent sessions.
It reads work from GitHub Issues, manages isolated per-issue workspaces, and drives the
headless `copilot` CLI with bounded concurrency, retries, and durable checkpointing.

## High-level topology

```
┌────────────────────────────────────────────────────────────────────┐
│                         CLI / Daemon                               │
│  orchestra ./WORKFLOW.md [--port N]                                │
│  Structured logfmt logs · optional GET /api/v1/state snapshot      │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ Effect Layers
┌─────────────────────────────▼──────────────────────────────────────┐
│                   Orchestrator (single fiber)                       │
│  Poll tick: reconcile → preflight → fetch candidates               │
│             → sort → dispatch within concurrency slots              │
│  OrchestratorState (running / claimed / retry / totals)            │
│  Workers report outcomes via Effect Queue                          │
└──────┬──────────────┬──────────────┬──────────────┬───────────────┘
       │ port         │ port         │ port         │ port
  ┌────▼────┐   ┌─────▼──────┐  ┌───▼──────────┐  ┌▼──────────────┐
  │IssueTrack│  │AgentRunner │  │WorkspaceMgr  │  │WorkflowConfig │
  │GitHub   │  │Copilot sub-│  │per-issue dirs│  │YAML+Liquid    │
  │(Octokit)│  │process →   │  │hooks, path   │  │Schema+hot-    │
  │→Issue   │  │AgentEvent  │  │safety        │  │reload         │
  └─────────┘  └────────────┘  └──────────────┘  └───────────────┘
                      │ spawns (cwd = workspace)
               ┌──────▼──────────┐
               │ GitHub Copilot  │  per-issue session, ≤ max_turns
               │ (child process) │  streams normalized AgentEvent
               └─────────────────┘
```

When `--port N` is passed, the daemon also serves a React SPA (the _cockpit_) and a
typed HTTP API on `127.0.0.1:N`.

```
Cockpit SPA (React 19 + Vite)
  Fleet · Kanban · Events · Settings
    │ fetch (bearer token, loopback-only)
    ▼
CockpitApi (@effect/platform HttpApi)
  GET  /api/v1/state         → OrchestratorSnapshot (no auth, loopback)
  GET  /api/v1/settings      → editable settings subset (no auth, loopback)
  POST /api/v1/control/pause  \
  POST /api/v1/control/resume  > bearer + loopback
  POST /api/v1/issues/:id/retry
  POST /api/v1/issues/:id/cancel
  PUT  /api/v1/settings
    │ CommandBus (Queue + Deferred ack)
    ▼
Orchestrator state fiber (single source of truth)
```

## Source layout

```
src/
  cli/
    main.ts          CLI entry — passes argv to runDaemon
    daemon.ts        Builds Effect Layers, forks orchestrator + cockpit fibers
    args.ts          Parses --port flag
  core/
    domain/          Schema-validated types
      issue.ts       Issue, NormalizedLabel
      workflow.ts    ServiceConfig, PollingConfig, AgentConfig, … (all with defaults)
      agent-event.ts AgentEvent tagged union (Schema)
      state.ts       OrchestratorState, RunAttempt, RetryEntry, LiveSession
    ports/
      agent-runner.ts    Context.Tag: AgentRunner
      issue-tracker.ts   Context.Tag: IssueTracker
      workspace-mgr.ts   Context.Tag: WorkspaceManager
    errors.ts        All Data.TaggedError classes (TurnTimeout, TurnInputRequired, …)
    orchestrator/    Single-fiber orchestrator: state, selection, concurrency, backoff,
                     reconciliation, preflight, poll loop
    cockpit/         HttpApi, auth middleware, token service, static SPA server
    observability/   Logfmt observer, snapshot projection, status glyphs
    workflow/        WORKFLOW.md loader ($VAR resolver, Liquid renderer, hot-reload)
    workspace/       Path-safety helpers
    util/            Shared utilities (errorMessage, …)
  adapters/
    tracker-github/  Octokit client + GitHub→Issue normalizer
    agent-copilot/   Copilot subprocess runner → AgentEvent stream
    workspace/       FileSystem+Command WorkspaceManager (dir lifecycle, hooks)
  cockpit/           React 19 + Vite SPA (Fleet, Kanban, Events, Settings views)
test/
  fakes/             FakeTracker, FakeAgentRunner, FakeWorkspaceManager, harness
  *.test.ts          Vitest + @effect/vitest + fast-check (property tests)
```

## Core concepts

### Effect runtime

Every operation that can fail or touch I/O is an `Effect<A, E, R>`. Key patterns:

- **Layer / Context.Tag** — DI seam. The orchestrator depends on port tags, never on
  concrete implementations. `main.ts` wires layers; tests swap in fakes.
- **Schema** — parse/validate at trust boundaries (WORKFLOW.md YAML, agent JSONL).
  Defaults and normalization live in the schema itself.
- **Data.TaggedError** — every failure mode is a typed discriminated class. Retry logic
  `catchTag`s on retryable tags only.
- **Schedule** — exponential-backoff retries and the fixed-cadence poll loop are both
  composable `Schedule`s; no manual timers.
- **TestClock** — time-sensitive tests advance virtual time; no real `Date.now()` in core.

### Durability

State is checkpointed to `<workspace.root>/.orchestra/state.json` via a debounced
atomic writer (temp-file + rename). On restart: bookkeeping survives intact; orphaned
running issues become due-immediately continuation retries (no bespoke resumption code);
bad/missing checkpoint → clean start (renamed `.corrupt-<ts>`).

### Security model

- Agents run unsandboxed with `--allow-all-tools`; treat dispatched issues as arbitrary
  code execution.
- Two credentials are deliberately separate: tracker API key (issue polling) vs. agent
  GitHub token (Copilot session).
- Cockpit binds to loopback and requires a per-process bearer token; cross-origin
  requests are rejected. Secrets are never serialized or exposed through the API.

## Quality gates

Run `pnpm check` (typecheck + lint + test + doctor:score) before every PR.
CI enforces the same on Node 22 and 24.

See `docs/effect-guide.md` for the six Effect concepts with real Orchestra examples.
See `PROJECT_BRIEF.md` for the full specification, sprint history, and decision log.
