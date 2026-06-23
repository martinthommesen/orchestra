# Concept A — "The Faithful Loop"

> The pragmatic v1: a faithful, minimal Symphony port. Build the orchestration loop
> correctly, ship nothing else.

## Description

A single daemon package plus a small set of Effect services. It implements exactly
the Symphony control loop — poll → reconcile → dispatch (bounded) → run one Copilot
session per issue → retry with backoff — against **GitHub Issues**, driving Copilot
as a **subprocess**, surfacing **structured logs** (and an optional JSON snapshot).

- **Runtime:** Effect end-to-end. Orchestrator is one state-owning fiber; workers
  report via a `Queue`.
- **Tracker:** `IssueTracker` port, GitHub Issues adapter (Octokit). Port shaped to
  the spec's normalized `Issue`.
- **Agent:** `AgentRunner` port, headless `copilot` subprocess; raw output normalized
  into a `Schema`-typed `AgentEvent` stream.
- **Config:** `WORKFLOW.md` loader → YAML front matter validated by `Schema` →
  Liquid-strict prompt rendering. Hot reload via filesystem watch (spec §6.2).
- **Workspaces:** per-issue dirs under `workspace.root`, sanitized keys, path-safety
  invariants, lifecycle hooks.
- **Observability:** Effect `Logger` structured logs; optional `GET /api/v1/state`
  snapshot. No TUI.
- **State:** in-memory behind an `OrchestratorState` service.

## Pros

- Lowest risk; closest to "port the spec" — SPEC.md sections map 1:1 to tasks.
- Smallest surface to test → strong scheduler property tests are achievable in v1.
- Subprocess isolation satisfies the spec's safety model cleanly.
- Reversible everywhere it matters (tracker/agent/state are all ports).

## Cons

- Minimal delight — no dashboard, no TUI (Milo & Kira underserved in v1).
- Subprocess JSON parsing is brittle until the spike pins the format.
- "Just logs" may feel underwhelming for a demo.

## Estimated effort

~2 sprints. Sprint 0 (foundations + spike) + Sprint 1 (the loop end-to-end on fakes,
then real GitHub + Copilot).
