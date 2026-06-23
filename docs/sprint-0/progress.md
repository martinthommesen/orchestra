# Sprint 0 — Progress Tracker

> If context overflows, start a new chat:
> "Read PROJECT_BRIEF.md and docs/sprint-0/progress.md. Continue from where it left off."

## Task Status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | pnpm monorepo scaffold | ✅ Done | pnpm workspace + strict tsconfig + Biome. `src/`+`test/` per brief §5. |
| 2 | Effect baseline + run loop skeleton | ✅ Done | `src/cli/main.ts` boots, logs one logfmt "started" line, exits 0; missing arg → exit 1. |
| 3 | Domain model as Schema | ⬜ Not started | Phase 2 |
| 4 | Tagged errors | ⬜ Not started | Phase 2 |
| 5 | Port interfaces | ⬜ Not started | Phase 2 |
| 6 | WORKFLOW.md loader + Schema validation | ⬜ Not started | Phase 2 |
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

## Notes

- Bootstrap chat created the planning artifacts (brainstorm, brief, sprint plans).
  Sprint 0 is the first chat to write code.
- Toolchain verified at bootstrap: Node v24.16, pnpm 11.8, gh authed
  (martinthommesen), Copilot CLI 1.0.64-3 present at `~/.local/bin/copilot`.
- Decision recorded: lint/format = **Biome** (see Decisions above).
- Decision recorded: Copilot = **subprocess** for v1 (see Decisions above).
