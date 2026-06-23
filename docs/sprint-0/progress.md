# Sprint 0 — Progress Tracker

> If context overflows, start a new chat:
> "Read PROJECT_BRIEF.md and docs/sprint-0/progress.md. Continue from where it left off."

## Task Status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | pnpm monorepo scaffold | ✅ Done | pnpm workspace + strict tsconfig + Biome. `src/`+`test/` per brief §5. |
| 2 | Effect baseline + run loop skeleton | ✅ Done | `src/cli/main.ts` boots, logs one logfmt "started" line, exits 0; missing arg → exit 1. |
| 3 | Domain model as Schema | ✅ Done | `src/core/domain/`: Issue (+IssueStateRef), AgentEvent union, ServiceConfig/WorkflowDefinition, Workspace, RunAttempt, LiveSession, RetryEntry, OrchestratorState. Normalization baked in (label lowercasing transform). |
| 4 | Tagged errors | ✅ Done | `src/core/errors.ts`: every §5.5/§10.6/§11.4 class + §9.4/§9.5 workspace-safety errors. PascalCase `_tag`, snake_case category in doc comments. 29 unit tests (each constructs + `_tag`-discriminable + exhaustive switch). |
| 5 | Port interfaces | ✅ Done | `src/core/ports/`: IssueTracker, AgentRunner, WorkspaceManager, Clock as `Context.Tag` services (signatures only). |
| 6 | WORKFLOW.md loader + Schema validation | ✅ Done | `src/core/workflow/`: split → YAML → Schema decode (defaults) → `$VAR` → path coercion; strict Liquid (unknown var/filter = error). Pure `parseWorkflow` + IO `loadWorkflow` (FileSystem). 16 tests. |
| 7 | Copilot integration SPIKE | 🔄 In progress | Investigation + live PoC DONE; decision = subprocess. Spike doc written in Phase 3. |
| 8 | Status design system | ⬜ Not started | Phase 3 |
| 9 | Effect onboarding guide | ⬜ Not started | Phase 3 |
| 10 | CI pipeline | ⬜ Not started | Phase 3. Harness proven early: `test/harness.test.ts` (vitest + @effect/vitest + fast-check) passes. |
| 11 | WORKFLOW.example.md | 🔄 In progress | Placeholder stub committed in Phase 1; fleshed out in Phase 3 against the loader. |

## Bugs Found

| # | Description | Severity | Status | Fix |
|---|-------------|----------|--------|-----|
| — | none yet | | | |

## Decisions

- **Lint/format (Task 1): Biome** — single fast tool (lint + format + import sort),
  zero plugin churn, one config. Avoids the ESLint+Prettier coordination overhead.
  Config: `biome.json` (2-space, lineWidth 100, double quotes, semicolons, import sort).
- **Copilot integration (Task 7): subprocess for v1** — drive the installed `copilot`
  CLI headlessly: `copilot -p "<prompt>" --output-format json -C "<abs workspace>"
  --allow-all-tools --no-color --log-level none`. stdout is JSONL; terminal `result`
  event carries `exitCode` + `usage`. Chosen over the in-process `@github/copilot`
  SDK because the SDK's `./sdk` export was REMOVED in the installed 1.0.64-3 prerelease
  (present in 1.0.63) — too unstable to depend on — and subprocess gives a killable PID,
  cwd isolation, and a clean JSONL→AgentEvent mapping. ACP mode (`--acp`) noted as a
  future in-process upgrade path. Both stay behind the `AgentRunner` port. Full
  write-up + live PoC event capture → `docs/sprint-0/spike-copilot.md` (Phase 3).

## Phase Log

- **Phase 1 (Tasks 1–2) — complete.** Scaffold + Effect run-loop skeleton.
  Verified green: `pnpm typecheck`, `pnpm lint` (biome check), `pnpm test`
  (5 passing, harness proof), `pnpm build` (tsup), `pnpm dev ./WORKFLOW.example.md`
  (exit 0, one logfmt line), missing-arg (exit 1). Checkpoint commit made.
- **Phase 2 (Tasks 3–6) — complete.** Domain Schema, tagged errors, ports, WORKFLOW
  loader + strict Liquid. Verified green: typecheck, lint, 67 tests pass. Decisions
  noted: spec `codex` block → `copilot`; spec `linear`/`project_slug` → GitHub
  `github`/`repo`; `codex_*` domain/error fields → `agent_*`/`Agent*`; `Tracker*`
  generalization of `linear_*` errors. Schema decode failures map to
  `WorkflowParseError` (no dedicated SPEC class for config-validation). Checkpoint commit.

## Decisions (Phase 2 adaptations of the Symphony spec → Orchestra)

- **GitHub tracker, not Linear:** `tracker.kind` default value `github`; spec's
  `project_slug` → `repo` (`owner/name`); canonical api-key env `GITHUB_TOKEN`;
  endpoint default `https://api.github.com`. Supported-kind / repo / api-key presence
  are validated at dispatch preflight (Sprint 1), not at parse (decode stays lenient
  per §5.5) — they surface as `UnsupportedTrackerKind` / `MissingTrackerRepo` /
  `MissingTrackerApiKey`.
- **Copilot agent, not Codex:** spec `codex` front-matter block → `copilot`
  (`command` default `copilot`, `+model`); Codex-only sandbox/approval fields dropped.
  `LiveSession.codex_*` / `OrchestratorState.codex_*` fields → `agent_*`.
- **Workspace default root:** `<system-temp>/orchestra_workspaces` (spec
  `symphony_workspaces`).
- **Error names generalized:** `linear_*` → `Tracker*`, `codex_*` → `Agent*`
  (e.g. `port_exit` → `AgentProcessExit`). Spec snake_case kept in doc comments.

## Notes

- Bootstrap chat created the planning artifacts (brainstorm, brief, sprint plans).
  Sprint 0 is the first chat to write code.
- Toolchain verified at bootstrap: Node v24.16, pnpm 11.8, gh authed
  (martinthommesen), Copilot CLI 1.0.64-3 present at `~/.local/bin/copilot`.
- Decision recorded: lint/format = **Biome** (see Decisions above).
- Decision recorded: Copilot = **subprocess** for v1 (see Decisions above).
