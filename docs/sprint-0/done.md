# Sprint 0 — Done

> Architecture & Foundations. Branch: `feature/sprint-0`. Committed locally (no push/PR
> — the Producer merges). All 11 tasks complete; every success criterion verified.

## TL;DR

A pnpm-workspace TypeScript monorepo on **Effect** is standing: strict tooling, the
full domain model as `Schema`, a tagged error per SPEC error class, the four ports as
`Context.Tag` services, a `WORKFLOW.md` loader with strict-Liquid rendering, a status
design system, an Effect onboarding guide, a Node 22+24 CI merge gate, a documented
example workflow, and a **Copilot integration spike** that pins the v1 mechanism. The
CLI boots and logs. Nothing is faked or stubbed past the deliberately impl-free ports.

## Verified commands

```bash
pnpm install                       # 127 pkgs, zero build scripts run, exit 0
pnpm install --frozen-lockfile     # CI mode — clean, exit 0
pnpm typecheck                     # tsc --noEmit — clean
pnpm lint                          # biome check . — 37 files, clean
pnpm test                          # vitest — 84 tests across 7 files, all pass
pnpm build                         # tsup → dist/cli/main.js
pnpm dev ./WORKFLOW.example.md     # boots, logs one logfmt "started" line, exit 0
pnpm dev                           # missing arg → CliUsageError, exit 1
```

`pnpm check` runs typecheck + lint + test together.

## What was built (per task)

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Scaffold | pnpm workspace, strict `tsconfig`, **Biome** (lint+format+import-sort), `tsup`, `vitest`. `src/`+`test/` per brief §5. |
| 2 | Effect run-loop | `src/cli/main.ts` (`Effect.gen` program, `Layer` graph seam `AppLive`, logfmt logger via `Logger.logFmt`, `NodeRuntime.runMain`) + `src/cli/args.ts` (testable `parseArgs`). |
| 3 | Domain `Schema` | `src/core/domain/` — Issue, AgentEvent (tagged union), ServiceConfig/WorkflowDefinition (SPEC §6.4 defaults baked in), Workspace, RunAttempt, LiveSession, RetryEntry, OrchestratorState. Normalization (label lowercasing) encoded as schema transforms. |
| 4 | Tagged errors | `src/core/errors.ts` — one `Data.TaggedError` per SPEC class (§5.5/§10.6/§11.4) + §9.4/§9.5 workspace-safety errors; unioned into `WorkflowError`/`AgentError`/`TrackerError`/`WorkspaceError`/`OrchestraError`. |
| 5 | Ports | `src/core/ports/` — `IssueTracker`, `AgentRunner`, `WorkspaceManager`, `Clock` as `Context.Tag` services, **signatures only**. |
| 6 | WORKFLOW loader | `src/core/workflow/` — split → YAML → `Schema` decode (defaults) → `$VAR` → path coercion; strict Liquid render (unknown var/filter = tagged error). Pure `parseWorkflow` + IO `loadWorkflow` (FileSystem). `src/core/workspace/safety.ts` encodes §9.5 invariants. |
| 7 | Copilot spike | `docs/sprint-0/spike-copilot.md` — live one-turn PoC, **subprocess** decision for v1, JSONL→`AgentEvent` mapping table, `Schema` sketch, ACP future path. |
| 8 | Design system | `src/core/observability/glyphs.ts` (5 status glyphs + ASCII fallbacks, semantic color tokens, NO_COLOR/TTY-aware, truncation helpers, phase→status rollup) + `docs/design-system.md`. |
| 9 | Effect guide | `docs/effect-guide.md` — 6 concepts (Effect, Layer/Context, Schema, tagged errors, Schedule, TestClock) with Orchestra examples. |
| 10 | CI | `.github/workflows/ci.yml` — pnpm install → typecheck → lint → test → build on Node 22+24 matrix. Harness proven (vitest + @effect/vitest + fast-check). |
| 11 | Example workflow | `WORKFLOW.example.md` (GitHub front matter + Liquid body) + `test/example-workflow.test.ts` (loads + strict-renders both attempt states). |

## Decisions (the two the plan asked for)

1. **Lint/format = Biome.** One fast tool for lint + format + import-sort; one config
   (`biome.json`); no ESLint+Prettier coordination overhead.
2. **Copilot integration = subprocess for v1.** Drive the headless `copilot` CLI
   (`copilot -p "<prompt>" --output-format json -C "<abs ws>" --allow-all-tools
   --no-color --log-level none`); stdout is JSONL, terminal `result` carries `exitCode`
   + `usage`. Chosen over the in-process `@github/copilot` SDK because the SDK's `./sdk`
   export was **removed** between `1.0.63` and the installed `1.0.64-3` (instability),
   and a subprocess gives a killable PID, `cwd` isolation, and a clean JSONL→`AgentEvent`
   mapping. ACP (`copilot --acp`) noted as the future in-process upgrade. Both stay
   behind the `AgentRunner` port. Full write-up: `docs/sprint-0/spike-copilot.md`.

Spec→Orchestra adaptations (recorded in `progress.md`): GitHub tracker (not Linear) —
`tracker.kind: github`, `project_slug`→`repo`, env `GITHUB_TOKEN`; Copilot agent (not
Codex) — `codex` block→`copilot`, `codex_*`→`agent_*`, `linear_*`/`codex_*` errors →
`Tracker*`/`Agent*`; workspace default root `<temp>/orchestra_workspaces`.

## What's NOT done (out of scope — Sprint 1+)

- **Orchestrator loop** (poll/claim/dispatch/concurrency/retry/reconcile state machine).
  The single state-owning fiber is *designed for* (ports + `OrchestratorState` + tagged
  errors) but not built.
- **Real adapters:** GitHub Issues (Octokit) `IssueTracker` and the Copilot
  `AgentRunner` are ports only — no network/subprocess calls yet. The spike pins how the
  runner will work; it does not implement it.
- **Workspace manager impl** (dir lifecycle + hook execution) — port + safety helpers
  only.
- **Test fakes** (`FakeTracker`, `FakeAgentRunner`) and property/e2e suites beyond the
  harness proof — Sprint 1/QA.
- TUI, web dashboard, Dockerfile/daemon ops — post-v1.

## Manual setup needed

- **Node ≥ 22 + pnpm 11** (repo pins `pnpm@11.8.0` via `packageManager`). `pnpm install`.
- **For Sprint 1's live runs (not needed for Sprint 0 tests):**
  - GitHub Copilot CLI authenticated (`copilot` login under `~/.copilot`) **or** a
    `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` in the environment.
  - `GITHUB_TOKEN` (least-privilege repo Issues/PRs scope) for the tracker adapter; the
    example references it via `$GITHUB_TOKEN` indirection.
- **CI:** `.github/workflows/ci.yml` runs on push to `main` + all PRs. After the first
  push, mark the `check` job **required** in branch protection so it gates merges.
- Adopters: `cp WORKFLOW.example.md WORKFLOW.md` and edit `tracker.repo` etc.

## Notes for the next chat

- The throwaway spike sandbox (`.spike-copilot/`, ~665 MB of extracted tarballs + PoC
  workspace) was **deleted**. Its `.gitignore` entry is kept as a guard for future
  spikes. Everything learned is in `docs/sprint-0/spike-copilot.md`.
- Actual file layout differs slightly from the brief §5 *planned* table — see the
  updated §5. Notably: the front-matter `Schema` lives in `core/domain/workflow.ts`
  (not `core/workflow/`), and a small `core/util/` was added. Updated in the brief.
- **Supply-chain hygiene / build scripts:** third-party install scripts are denied via
  `pnpm-workspace.yaml` → `allowBuilds: { '@parcel/watcher': false, esbuild: false,
  msgpackr-extract: false }`. This is pnpm 11.8's real decision key — `false` means "do not
  run this build script." `pnpm install --frozen-lockfile` exits **0** with no notice.
  (Note: `ignoredBuiltDependencies` is **not** honored in pnpm 11.8 and an *undecided*
  `allowBuilds` entry makes install exit 1 — see progress.md Bug #1. pnpm is pinned to
  11.8.0 via `package.json` `packageManager` so local == CI.)

## Files created / changed

**Tooling/config:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`tsconfig.json`, `biome.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`,
`.github/workflows/ci.yml`.

**Source (`src/`):** `cli/{main,args}.ts`; `core/domain/{issue,agent-event,workflow,
workspace,run-attempt,live-session,retry-entry,orchestrator-state,index}.ts`;
`core/errors.ts`; `core/ports/{issue-tracker,agent-runner,workspace-manager,clock,
index}.ts`; `core/workflow/{loader,render,var,paths,index}.ts`;
`core/workspace/safety.ts`; `core/observability/glyphs.ts`; `core/util/error.ts`.

**Tests (`test/`):** `harness`, `errors`, `domain`, `workspace-safety`, `workflow`,
`glyphs`, `example-workflow` `.test.ts`; `fixtures/workflow-basic.md`.

**Docs:** `docs/sprint-0/{progress,spike-copilot,done}.md`, `docs/design-system.md`,
`docs/effect-guide.md`; `WORKFLOW.example.md`; `PROJECT_BRIEF.md` (§5/§7/§8).

## Commits (on `feature/sprint-0`, atop bootstrap `1cb0d5d`)

- `b3613e3` — Phase 1: pnpm + Effect + TypeScript scaffold and run-loop skeleton.
- `5c992fc` — Phase 2: domain Schema, tagged errors, ports, WORKFLOW loader.
- `05291fe` — Phase 3: Copilot spike, design system, Effect guide, CI, example workflow.
- `48ef5cf` — sprint-0 handoff: done.md + PROJECT_BRIEF §5/§7/§8.
- (fix) — CI: `pnpm install --frozen-lockfile` exit 0 via `allowBuilds: false` (unblocks PR #14).

Every commit carries `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
