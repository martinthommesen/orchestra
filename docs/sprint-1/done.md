# Sprint 1 — Core Orchestrator Loop — DONE

Branch: `feature/sprint-1` · Issues: #1–#13 (all closed via commits) · Producer opens the PR.

## What was built

The heart of v1: a single state-owning orchestrator fiber that polls GitHub Issues,
selects and dispatches work within concurrency caps, runs GitHub Copilot sessions in
isolated per-issue workspaces, reconciles against tracker state, retries with exponential
backoff, and exposes structured logs + an optional JSON snapshot — all on Effect, with no
Promise escape hatch in the core.

### Phase 1 — pure state machine on fakes (tasks 1–6, 10)

- `src/core/orchestrator/state.ts` — `OrchestratorStore` service (`get`/`update`/`modify`
  over a `Ref`) + pure state transitions; single-writer invariant.
- `selection.ts` — eligibility predicate (active/not-terminal/labels/not-claimed/Todo-blocker)
  - stable sort (priority asc, created_at oldest, identifier tiebreak).
- `concurrency.ts` — global + per-state slot budgeting (`planDispatch`).
- `backoff.ts` — `10s · 2^(attempt-1)` capped failure backoff + fixed continuation delay.
- `reconcile.ts` — stall-kill (precedence) / terminal-kill / update-active / neither, with
  refresh-failure tolerance.
- `loop.ts` — `runOrchestrator(def)` assembles the single fiber: startup cleanup → immediate
  tick → interval polling; workers report back over an Effect `Queue`.
- `test/fakes/` — `FakeTracker`, `FakeAgentRunner`, `FakeWorkspaceManager`, `RecordingObserver`,
  and the `harness.ts` (`buildDef`/`makeIssue`/`loopLayer`/`waitFor`).

### Phase 2 — real adapters behind the ports (tasks 7–9)

- `src/adapters/tracker-github/` — Octokit `IssueTracker`; pure `normalize.ts` (GitHub →
  domain, status-label/open/closed → state per §11.3), drops PRs, paginates, 404-on-refresh
  ⇒ omit. `layerGitHubTracker(config)`.
- `src/adapters/workspace/` — `@effect/platform` `FileSystem`+`Command` `WorkspaceManager`:
  per-issue dirs under the sanitized root, lifecycle hooks (`sh -lc` + `timeout_ms`),
  enforcing the §9.5 safety invariants. `layerWorkspaceManager(config)`.
- `src/adapters/agent-copilot/` — headless `copilot` subprocess `AgentRunner` (`cwd ===
workspacePath`), pure `map.ts` JSONL → `AgentEvent`, env-only token (never logged), Command
  `Scope` finalizer SIGTERMs the PID. `layerCopilotRunner(config)`. Per the Sprint 0 spike.

### Phase 3 — observability, e2e, docs (tasks 11–13)

- `src/core/observability/live-observer.ts` — pure exhaustive `formatObservation` (logfmt
  annotations + glyphs + `issue_id`/`issue_identifier`/`session_id`) + `ObserverLive`.
- `src/core/observability/snapshot-server.ts` — pure `toSnapshot` + loopback `GET
/api/v1/state` via `@effect/platform` (`HttpServer.serveEffect` + `NodeHttpServer.layer`).
- `src/cli/args.ts` — `--port`/`--port=N` (1..65535) parsing.
- `src/cli/main.ts` — `AppLive` wired: load workflow → build Layer graph over `NodeContext`
  → run `runOrchestrator` (+ forked snapshot server when `--port` set).
- `test/orchestrator-pure.test.ts` — added the explicit no-double-dispatch property.
- `test/e2e-fake.test.ts` — combined fake end-to-end (two issues, no network, asserts store
  **and** snapshot projection).
- README — run/usage, configuration, and quality-gate sections.

## Verification (all un-piped, `; echo $?`)

- `pnpm typecheck` → 0 · `pnpm lint` → 0 · `pnpm test` → 0 (**178 tests, 15 files**) ·
  `pnpm build` → 0 · `pnpm install --frozen-lockfile` → 0.
- Daemon smoke (network-free): built bundle against a refused-loopback endpoint emitted the
  logfmt `started` line + Live Observer tick lines (degraded mode keeps looping), and
  `curl 127.0.0.1:PORT/api/v1/state` returned the JSON snapshot. Safe CLI error paths exit non-zero.

## Decisions / risks

- **Copilot integration = subprocess** (pinned in Sprint 0 spike) — kept behind the
  `AgentRunner` port; the SDK remains a swappable alternative.
- **GitHub state mapping is a documented convention** (issues are only open/closed): a
  status-label matching a configured state wins; else open→`active_states[0]`, closed→terminal.
- **`HttpServer.serveEffect` returns after install** — the listener lives for the layer scope,
  so the server is kept alive with `Effect.zipRight(Effect.never)` for the orchestrator's
  lifetime; a bind failure is caught/logged (non-fatal).
- **Not yet validated against a live GitHub repo + real Copilot** — adapters are unit-tested
  and the loop is proven on fakes; the real-repo success criterion is an operator step.

## Manual setup needed

- `cp WORKFLOW.example.md WORKFLOW.md`, edit `repo`/labels/states, and `export GITHUB_TOKEN=...`
  (least-privilege repo token; `$VAR`-resolved, never written to the file).
- The headless `copilot` CLI must be installed and authenticated for live runs.
- Run: `pnpm dev ./WORKFLOW.md` (add `--port 4317` for the snapshot API).

## Files created / changed

- **Created:** `src/core/orchestrator/{state,selection,concurrency,backoff,reconcile,preflight,loop,observer}.ts`,
  `src/core/observability/{live-observer,snapshot-server}.ts`,
  `src/adapters/tracker-github/*`, `src/adapters/workspace/*`, `src/adapters/agent-copilot/*`,
  `test/fakes/*`, `test/{orchestrator-pure,orchestrator-loop,tracker-github,workspace-manager,agent-copilot,live-observer,snapshot-server,e2e-fake}.test.ts`,
  `docs/sprint-1/done.md`.
- **Changed:** `src/cli/{main,args}.ts`, `package.json` + lockfile (`@octokit/rest`),
  `README.md`, `PROJECT_BRIEF.md` (§5/§7/§8), `docs/sprint-1/progress.md`,
  `test/harness.test.ts`.

## Commits (15, newest first)

```
bbc5c65 feat(cli): wire orchestrator + snapshot server; fake e2e + README (Closes #13)
e891854 test(orchestrator): no-double-dispatch property (Closes #11)
9af58ee feat(observability): live observer logs + JSON snapshot API (Closes #12)
91e4df2 docs(sprint-1): Phase 2 checkpoint — adapters done
15c4458 feat(agent): Copilot subprocess AgentRunner (Closes #9)
c868b5c feat(workspace): filesystem WorkspaceManager + hooks (Closes #8)
839f05b feat(tracker): GitHub Issues adapter via Octokit (Closes #7)
6dac64a test(orchestrator): pure unit/property + full-loop scenario tests (refs #11)
b5e38c5 test(fakes): scriptable tracker/runner/workspace fakes + harness (Closes #10)
bb54a60 feat(orchestrator): single-fiber poll loop assembly (Closes #6)
65ce95f feat(orchestrator): reconciliation planner (Closes #5)
ee609b0 feat(orchestrator): retry + backoff timing (Closes #4)
8229212 feat(orchestrator): concurrency control with per-state caps (Closes #3)
bb90828 feat(orchestrator): candidate selection + stable sort (Closes #2)
1b31f61 feat(orchestrator): OrchestratorState service + pure transitions (Closes #1)
```

(+ the sprint-close docs commit that adds this file.)
