# Sprint 0 — Architecture & Foundations

> Sprint Goal: Stand up the Orchestra scaffold (pnpm + Effect + TypeScript), the
> typed domain model and ports, the WORKFLOW.md loader, green CI — and **pin the
> GitHub Copilot integration surface via a timeboxed spike** — so Sprint 1 can build
> the orchestrator loop on solid foundations.
> Branch: feature/sprint-0
> Estimated effort: ~1 sprint (front-loaded; the spike carries the unknowns)

## Prioritized Task List

| #   | Task                                   | Owner       | Est  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------- | ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | pnpm monorepo scaffold                 | Dash        | 1h   | `package.json` (workspace), `pnpm-workspace.yaml`, strict `tsconfig`, lint/format (ESLint+Prettier or Biome — decide & document), `src/` + `test/` layout per brief §5.                                                                                                                                                                                                                                                                                                                                                          |
| 2   | Effect baseline + run loop skeleton    | Nova        | 1.5h | Add `effect`. A `src/cli/main.ts` that parses a `WORKFLOW.md` path arg, builds an empty `Layer` graph, logs "started", and exits cleanly. No orchestration yet — prove the wiring + `Logger`.                                                                                                                                                                                                                                                                                                                                    |
| 3   | Domain model as Schema                 | Sage        | 2h   | `src/core/domain/`: `Issue`, `WorkflowDefinition`, `ServiceConfig`, `Workspace`, `RunAttempt`, `LiveSession`, `RetryEntry`, `OrchestratorState` as `Schema` types per SPEC §4. Include normalization rules (workspace-key sanitization, lowercase state/labels).                                                                                                                                                                                                                                                                 |
| 4   | Tagged errors                          | Sage        | 1h   | `src/core/errors.ts`: an Effect tagged error for **every** SPEC error class (§5.5, §10.6, §11.4) — `MissingWorkflowFile`, `WorkflowParseError`, `TemplateRenderError`, `TurnTimeout`, `TurnFailed`, `LinearGraphqlErrors`→`TrackerGraphqlErrors`, etc. Unit test that each constructs and is `_tag`-discriminable.                                                                                                                                                                                                               |
| 5   | Port interfaces                        | Sage        | 1h   | `src/core/ports/`: `IssueTracker`, `AgentRunner`, `WorkspaceManager`, `Clock` as `Context.Tag` services with method signatures only (no impls). These freeze the seams.                                                                                                                                                                                                                                                                                                                                                          |
| 6   | WORKFLOW.md loader + Schema validation | Nova        | 2h   | `src/core/workflow/`: read file → split YAML front matter / Markdown body → decode front matter with `Schema` (defaults per SPEC §5.3 cheat-sheet §6.4) → return `{config, prompt_template}`. Strict-Liquid render with **unknown var/filter = error** (SPEC §5.4). Resolve `$VAR` only where values reference it (§6.1). Errors map to the §4 tagged errors.                                                                                                                                                                    |
| 7   | **Copilot integration SPIKE**          | Sage + Dash | 3h   | **Timeboxed.** Determine how to drive GitHub Copilot headlessly for one turn in a target dir: evaluate (a) headless `copilot` CLI subprocess (flags, stdin prompt, JSON/stream output framing, exit codes) and (b) in-process `@github/copilot` SDK (if usable). Produce a tiny throwaway PoC that runs ONE prompt and captures the event/output shape. **Deliverable:** `docs/sprint-0/spike-copilot.md` recommending the v1 mechanism + a `Schema` sketch for `AgentEvent`. Decision recorded; both stay behind `AgentRunner`. |
| 8   | Status design system                   | Milo        | 1h   | `docs/design-system.md` + a tiny `src/core/observability/glyphs.ts`: status glyphs (`▶ running`, `⏳ retrying`, `⏸ blocked`, `✓ done`, `✗ failed`), color tokens, truncation rules. Used by logs in v1, reused by the post-v1 TUI.                                                                                                                                                                                                                                                                                               |
| 9   | Effect onboarding guide                | Nova        | 1h   | `docs/effect-guide.md`: the 6 Effect concepts a contributor needs here (Effect, Layer/Context, Schema, tagged errors, Schedule, TestClock) with one Orchestra-specific example each. (Concession from the brainstorm.)                                                                                                                                                                                                                                                                                                           |
| 10  | CI pipeline                            | Dash        | 1.5h | `.github/workflows/ci.yml`: install (pnpm), typecheck, lint, `vitest` run, on Node 22 + 24 matrix. Add `@effect/vitest` + `fast-check` to devDeps with one trivial passing property test to prove the harness. Merge gate.                                                                                                                                                                                                                                                                                                       |
| 11  | WORKFLOW.example.md                    | Kira        | 0.5h | A documented example workflow (GitHub-Issues tracker front matter + a sensible Liquid prompt body) developers copy to adopt Orchestra.                                                                                                                                                                                                                                                                                                                                                                                           |

## Work Schedule

### Phase 1: Scaffold (tasks 1–2)

- Monorepo + tooling + Effect run-loop skeleton boots and logs.
- Checkpoint commit.

### Phase 2: Typed Foundations (tasks 3–6)

- Domain `Schema`, tagged errors, ports, WORKFLOW loader + strict Liquid.
- Checkpoint commit.

### Phase 3: De-risk + Polish (tasks 7–11)

- Copilot spike (the critical unknown) → recommendation doc.
- Design system, Effect guide, CI green, example workflow.
- Final commit.

## Success Criteria

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` all pass locally and in CI.
- [ ] `pnpm dev ./WORKFLOW.example.md` boots, logs a structured "started" line, exits 0.
- [ ] Domain model + every SPEC error class exist as `Schema`/tagged types with tests.
- [ ] WORKFLOW.md loader parses front matter (with defaults) and strict-renders the
      Liquid body; unknown variable/filter fails with the correct tagged error.
- [ ] Ports exist as `Context.Tag` services (signatures only).
- [ ] `docs/sprint-0/spike-copilot.md` exists with a clear v1 recommendation +
      `AgentEvent` Schema sketch.
- [ ] CI is green on Node 22 + 24 and is required for merge.
- [ ] No secrets in code; `$VAR` indirection works in the loader.

## What's NOT in This Sprint

| Feature                               | Reason                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| Orchestrator poll/dispatch/retry loop | That's Sprint 1 — needs these foundations first                   |
| Real GitHub Issues network calls      | Sprint 1 (adapter); Sprint 0 only freezes the port                |
| Real Copilot run integration          | Sprint 0 only spikes + recommends; Sprint 1 implements the runner |
| Ink TUI / web dashboard               | Post-v1 (see ideas-backlog)                                       |
| Workspace hook execution              | Sprint 1 (manager impl); Sprint 0 freezes the port                |

## Agent Prompt

> Read PROJECT_BRIEF.md, then read docs/sprint-0/plan.md. Execute Sprint 0.
>
> First: git checkout -b feature/sprint-0
>
> Take your time, do it right — foundations gate every later sprint.
> Update docs/sprint-0/progress.md after each phase.
> The Copilot spike (task 7) is the critical unknown — start it early if blocked
> elsewhere. When done, push and open a PR. Follow Sections 12–14 of PROJECT_BRIEF.md.
