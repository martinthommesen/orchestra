# Concept B — "SDK-Native Studio"

> The delightful v1: lead with the GitHub Copilot **SDK in-process** and a gorgeous
> **Ink TUI**, optimizing for demo wow-factor and developer experience.

## Description

Same Effect core, but two bold bets up front:

- **In-process Copilot SDK** instead of a subprocess. The `AgentRunner` calls the
  `@github/copilot` SDK directly and receives structured turn/tool/usage events —
  no stdout parsing.
- **First-class Ink TUI** as the default surface: live session table, per-issue
  spinners, token meters, retry countdowns, blocked-state callouts, and an
  end-of-run Markdown "proof-of-work" digest.
- Everything else mirrors Concept A (GitHub Issues tracker, `WORKFLOW.md`, Effect
  services, in-memory state), but the dashboard is a headline feature, not post-v1.

## Pros

- Maximum delight and demo value — matches Symphony's polished LiveView reference.
- Structured SDK events remove the brittlest part of the subprocess approach.
- Strong DX: a developer *sees* the ensemble working, not a log scroll.

## Cons

- **Bets the v1 on an unproven, possibly-churning SDK surface** before the spike.
- In-process agent shares our heap/env → weaker isolation, larger blast radius;
  harder to honor the spec's sandbox/`cwd` safety guarantees.
- TUI is the hardest thing to unit-test (Ivy's concern) and risks blocking the
  daemon if coupled to the core loop.
- Two big risks land in the same sprint — schedule risk compounds.

## Estimated effort

~3 sprints. The SDK integration and TUI each carry real unknowns; either can slip.
