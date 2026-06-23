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
| 7 | Copilot integration SPIKE | ✅ Done | Subprocess for v1. Live one-turn PoC captured (26-event JSONL, terminal `result` w/ exitCode+usage). `docs/sprint-0/spike-copilot.md`: findings, decision+rationale, JSONL→`AgentEvent` mapping table, Schema sketch, ACP future path. |
| 8 | Status design system | ✅ Done | `src/core/observability/glyphs.ts` (5 statuses `▶⏳⏸✓✗` + ASCII fallbacks, semantic color tokens, NO_COLOR/TTY aware, truncation helpers, phase→status rollup) + `docs/design-system.md`. 14 tests (incl. 2 fast-check props). |
| 9 | Effect onboarding guide | ✅ Done | `docs/effect-guide.md`: 6 concepts (Effect, Layer/Context, Schema, tagged errors, Schedule, TestClock) each with a real Orchestra example. |
| 10 | CI pipeline | ✅ Done | `.github/workflows/ci.yml`: pnpm install (frozen) → typecheck → lint → test → build on Node 22+24 matrix. Concurrency cancel, least-priv `contents: read`. Harness (vitest+@effect/vitest+fast-check) proven. |
| 11 | WORKFLOW.example.md | ✅ Done | Fully documented GitHub front matter + Liquid prompt body (issue vars, attempt branch, `default`/`!= empty`, blocked-by loop). Validated by `test/example-workflow.test.ts` (loads + strict-renders both attempt states, 3 tests). |

## Bugs Found

| # | Description | Severity | Status | Fix |
|---|-------------|----------|--------|-----|
| 1 | **CI red on PR #14 (blocker):** `pnpm install --frozen-lockfile` exits **1** on a clean runner (both Node 22 & 24) with `[ERR_PNPM_IGNORED_BUILDS]`, before typecheck/test even run. Two compounding mistakes: (a) my Phase-3 "removal" of the placeholder `allowBuilds` block did **not** stick — the very next `pnpm install` **rewrites** `pnpm-workspace.yaml`, re-inserting `allowBuilds:` with literal `set this to true or false` placeholders; an *undecided* entry makes pnpm 11.8 exit 1. (b) `ignoredBuiltDependencies` is **not honored** by pnpm 11.8 (verified: it does not suppress the error). I also reported it green locally via a false positive — `pnpm install 2>&1 \| tail` captured `tail`'s exit code (0), not pnpm's, and node_modules was already populated. | **blocker** | ✅ Fixed | `allowBuilds` IS the real pnpm 11.8 key — set each entry to **`false`** (explicit "don't run this build script"). Removed the dead `ignoredBuiltDependencies`. Verified the REAL exit code un-piped on a clean tree: `rm -rf node_modules && pnpm install --frozen-lockfile; echo $?` → **EXIT=0**, zero build scripts run, pnpm no longer rewrites the file. Then `typecheck`/`lint`/`test` (84)/`build` all **0** (esbuild works via its prebuilt @esbuild/<platform> binary despite the skipped script). **Lesson: never validate success through a pipe (`\| tail`/`\| head`) — it hides the real exit code; use `; echo $?` / `${PIPESTATUS[0]}`.** |

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
- **Phase 3 (Tasks 7–11) — complete.** Copilot spike doc (live PoC re-captured for
  exact event shapes), status design system (`glyphs.ts` + `design-system.md`), Effect
  guide, CI workflow (Node 22+24), and a fully fleshed-out `WORKFLOW.example.md` with a
  loader+render validation test. Minor cleanup: removed a stray `allowBuilds` block from
  `pnpm-workspace.yaml`. Verified green end-to-end: `pnpm typecheck`, `pnpm lint`
  (37 files), `pnpm test` (**84 tests, 7 files**), `pnpm build` (tsup), `pnpm dev
  ./WORKFLOW.example.md` (exit 0, one logfmt line), missing-arg (exit 1). Checkpoint commit.
- **Post-review fix (PR #14 CI red) — Bug #1.** CI failed at the `pnpm install
  --frozen-lockfile` step on Node 22 + 24 (`ERR_PNPM_IGNORED_BUILDS`, exit 1). Root cause:
  pnpm 11.8's `allowBuilds` decision map had unresolved placeholder values (pnpm rewrites
  the file to re-add them every install), and `ignoredBuiltDependencies` is not honored in
  11.8. Fix: set `allowBuilds` entries to `false` (deny all third-party build scripts) and
  drop the dead `ignoredBuiltDependencies`. Verified the **real** exit code un-piped on a
  clean tree (`rm -rf node_modules && pnpm install --frozen-lockfile; echo $?` → **0**),
  then `typecheck`/`lint`/`test`(84)/`build` all exit 0; lockfile unchanged so
  `--frozen-lockfile` still valid. pnpm version stays pinned to 11.8.0 via the
  `packageManager` field (CI's `pnpm/action-setup@v4` reads it) so local == CI, no drift.
  Pushed to re-run CI on PR #14.

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
