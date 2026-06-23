# Brainstorm — Phase 5: Summary

> The decisions that flow into `PROJECT_BRIEF.md` and the sprint plans.

## Winning direction

**Concept A — "The Faithful Loop"**, hardened with **Concept C's ports discipline**.
Build the Symphony control loop correctly and minimally, end-to-end type-safe on
Effect, with every spec seam behind an Effect `Layer` so future surfaces (Copilot
SDK, Ink TUI, Linear adapter) are additive swaps rather than rewrites.

## Ratified architecture decisions

1. **Language/runtime:** TypeScript on **Effect** — *all the way through* the core
   and the CLI (no Promise escape hatch in the core). Pay down the learning curve
   with `docs/effect-guide.md` (owned by Nova).
2. **Tracker:** **GitHub Issues** adapter for v1, behind an `IssueTracker` port
   shaped to the spec's normalized `Issue` model. Linear is a future adapter.
3. **Agent runner:** Copilot driven as a **subprocess** by default (isolation,
   killable PID, spec-aligned safety). A **Sprint 0 spike** pins the exact Copilot
   surface (headless CLI JSON vs in-process `@github/copilot` SDK); both live behind
   the `AgentRunner` port. The runner normalizes raw output into a `Schema`-typed
   `AgentEvent` stream — the orchestrator never sees raw stdout.
4. **Config:** `WORKFLOW.md` = YAML front matter (validated by `Schema`) + a
   strict-Liquid prompt body. Hot reload on file change (spec §6.2).
5. **State:** **in-memory** (per spec) behind an `OrchestratorState` service;
   durability is an additive layer later. Orchestrator is a **single state-owning
   fiber**; workers report outcomes via an Effect `Queue`.
6. **Errors:** **every** SPEC.md error class → an Effect **tagged error**.
   End-to-end typed error channel.
7. **Observability:** structured logs (Effect `Logger`) + an **optional** JSON
   snapshot API (`GET /api/v1/state`, spec §13.3/§13.7). **Ink TUI is post-v1.**
   Milo builds the status glyph + color **design system now** for use in logs.
8. **Safety invariants (mandatory, spec §9.5/§15.2):** `cwd == workspace_path`
   before launch; workspace path stays under `workspace.root`; sanitized workspace
   keys (`[A-Za-z0-9._-]`, others → `_`); never log secrets; `$VAR` indirection.
9. **Packaging:** **pnpm workspace** monorepo, lean package set in v1 (don't split
   into six packages until a second adapter justifies it).
10. **Testing:** `FakeTracker` + `FakeAgentRunner` + Effect `TestClock`;
    property-test scheduler invariants (concurrency caps, backoff math, no
    double-dispatch of claimed issues) with fast-check + `@effect/vitest`. CI green
    (typecheck + lint + unit + fake e2e) is a **merge gate from commit #1**.

## v1 scope (in)

- WORKFLOW.md loader + Schema validation + strict-Liquid rendering + hot reload.
- GitHub Issues tracker adapter (candidate fetch, state refresh, terminal fetch).
- Orchestrator: poll tick, reconciliation, bounded dispatch, exponential backoff +
  continuation retries, claim/running state machine.
- Workspace manager: per-issue dirs, sanitized keys, path-safety, lifecycle hooks.
- Copilot agent runner (subprocess) → normalized `AgentEvent` stream; continuation
  turns up to `max_turns`.
- Structured logs + optional JSON snapshot API.
- Fakes + property tests + CI.

## v1 scope (out → `docs/ideas-backlog.md`)

- Linear adapter, Ink TUI/web dashboard, SSH/remote workers, durable state,
  `max_concurrent_agents_by_state`, humanized event summaries.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Copilot integration surface unknown/churning | Sprint 0 spike, pinned behind `AgentRunner` + `Schema` snapshot tests |
| Effect learning curve for contributors | `docs/effect-guide.md`, small obvious service interfaces, "good first issue" path |
| Subprocess stdout framing brittleness | Runner owns parsing; orchestrator consumes typed events only; snapshot tests |
| GitHub↔Linear model mismatch | Port shaped to spec's normalized Issue; document GitHub field mapping in brief |
| Scope creep toward the dashboard | Dashboard reads a snapshot, never gates the daemon; TUI is a separate post-v1 package |

## Immediate next steps

1. Write `PROJECT_BRIEF.md` (all 14 sections) from these decisions.
2. `docs/sprint-0/plan.md` — Architecture & Foundations (+ the Copilot spike).
3. `docs/sprint-1/plan.md` — the core orchestrator loop, for dev-team handoff.
