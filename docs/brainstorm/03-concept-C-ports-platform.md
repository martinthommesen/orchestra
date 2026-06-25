# Concept C — "Ports-First Platform"

> The extensible v1: invest early in clean ports and a monorepo so Orchestra becomes
> a _platform_ (multi-tracker, multi-agent, swappable surfaces), accepting more
> upfront structure.

## Description

A pnpm **monorepo** with sharp package boundaries from day one:

- `@orchestra/core` — domain model (`Schema`), ports, orchestrator state machine.
- `@orchestra/tracker-github` — GitHub Issues adapter (Linear adapter stubbed).
- `@orchestra/agent-copilot` — Copilot runner (subprocess **and** SDK behind the
  same port, chosen at config time).
- `@orchestra/workflow` — `WORKFLOW.md` loader + Liquid rendering + hot reload.
- `@orchestra/cli` — the daemon entrypoint and logging.
- `@orchestra/tui` — Ink dashboard (post-v1, but the package boundary exists now).

Every spec seam is an Effect `Layer`. Adapters are independently versioned and
testable. The "drop-in Symphony" story plus a credible multi-tracker future.

## Pros

- Best long-term architecture; adapters swap via layer, never rewrite.
- Forces the discipline Sage and Ivy want: orchestrator can't import an adapter.
- Makes the eventual Linear adapter and TUI _additive_, not disruptive.

## Cons

- Most upfront ceremony — package wiring, build graph, release config — before any
  user-visible behavior. Remy's scope alarm rings loudest here.
- Over-engineering risk if Orchestra never grows beyond GitHub + Copilot.
- Slower to first working loop than Concept A.

## Estimated effort

~3 sprints, front-loaded. Sprint 0 is heavier (monorepo + build graph + CI matrix).
