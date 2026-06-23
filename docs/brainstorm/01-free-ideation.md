# Brainstorm — Phase 1: Free Ideation

> Project: **Orchestra** — an end-to-end type-safe TypeScript reimplementation of
> OpenAI Symphony, driving the GitHub Copilot SDK / headless CLI, built on Effect.
>
> The *what* is decided. This brainstorm debates the *how*: architecture, scope,
> and the riskiest design decisions. Phase 1 is raw ideas — no filtering.

Participants: **Remy** (Producer), **Kira** (Product/DX), **Milo** (Art/CLI
ergonomics), **Nova** (Frontend/runtime), **Sage** (Backend/orchestration),
**Dash** (DevOps), **Ivy** (QA).

---

### Kira (Product / Developer Experience)

1. **One file to rule it all.** Keep Symphony's `WORKFLOW.md` as the entire control
   surface — YAML front matter + a Liquid prompt body. A developer should be able to
   adopt Orchestra by dropping one file in their repo. That's the product.
2. **GitHub-native, not Linear.** Our agent *is* Copilot. The tracker should be
   GitHub Issues by default — `gh`-style auth, labels, project boards. Asking people
   to wire up Linear to use a GitHub-Copilot orchestrator feels backwards.
3. **"Manage work, not agents."** The headline promise. The default experience after
   `orchestra ./WORKFLOW.md` should be a calm status line that says *N running,
   M queued, here's what changed* — not a firehose of agent tokens.

### Milo (Art / CLI Ergonomics)

1. **A gorgeous TUI.** An [Ink](https://github.com/vadimdemedes/ink) dashboard:
   live session list, per-issue spinners, token counters, retry countdowns. The
   Elixir reference has a Phoenix LiveView dashboard — our equivalent delight is a
   first-class terminal UI.
2. **A real design system for the terminal** — consistent status glyphs
   (`▶ running`, `⏳ retrying`, `⏸ blocked`, `✓ done`), a restrained color palette,
   and truncation rules so logs never wrap into mush.
3. **Shareable run summaries** — at the end of a run, emit a clean Markdown
   "proof-of-work" digest (PR link, CI status, turns, tokens) like Symphony's demo.

### Nova (Frontend / Runtime)

1. **Effect, but with guardrails.** Effect is a great fit, but it's a steep curve.
   Pitch: adopt it for the orchestrator internals, but keep a thin Promise-friendly
   boundary at the CLI entry so contributors aren't forced to learn fibers on day 1.
2. **Stream the agent, don't poll it.** Model the Copilot session as an
   `Effect.Stream` of typed events. The orchestrator subscribes; back-pressure and
   cancellation come for free.
3. **Start ugly.** Logs to stderr for v1. A TUI is a separate package we add once
   the core loop is proven. Don't let the dashboard block the daemon.

### Sage (Backend / Orchestration)

1. **Typed errors end-to-end.** Symphony's spec literally enumerates error classes
   (`missing_workflow_file`, `turn_timeout`, `linear_graphql_errors`, …). Map every
   one to an Effect tagged error. This is where end-to-end type safety pays off.
2. **Ports everywhere the spec has a seam.** `IssueTracker`, `AgentRunner`,
   `WorkspaceManager`, `Clock` — all Effect services behind `Layer`s. Swapping
   GitHub↔Linear or Copilot-CLI↔Copilot-SDK becomes a layer swap, not a rewrite.
2.5. **The orchestrator is a single fiber owning all state**, exactly as the spec
   demands ("only component that mutates scheduling state"). Workers report back via
   a `Queue`. No shared mutable maps across fibers.
3. **Maybe go durable.** The spec is in-memory, but a small SQLite of retry state
   would survive restarts. Tempting.

### Dash (DevOps)

1. **Subprocess isolation for agents.** Launch Copilot as a child process per issue,
   in the issue's workspace, like the spec's `bash -lc` model. If an agent wedges, we
   kill a PID — we don't take down the daemon.
2. **CI from commit #1.** GitHub Actions: typecheck, lint, unit, and a fake-agent
   e2e. Matrix on Node 22/24. No green pipeline, no merge.
3. **Ship a container + a `systemd`/launchd recipe.** It's a daemon; treat it like
   one. Health endpoint, structured JSON logs, graceful shutdown on SIGTERM.

### Ivy (QA)

1. **Fakes for the two scary dependencies.** A `FakeTracker` and a `FakeAgentRunner`
   (scriptable event sequences) so we can test the whole orchestration state machine
   deterministically — no network, no real Copilot, in milliseconds.
2. **Property-test the scheduler.** Concurrency limits, backoff math, and "claimed
   issues are never double-dispatched" are exactly the invariants that break under
   load. Fast-check + `@effect/vitest`.
3. **Pin the protocol.** Whatever we use to talk to Copilot — SDK or CLI JSON — we
   snapshot its event shapes behind a `Schema` so an upstream change fails a test,
   not production at 3am.

### Remy (Producer)

1. **v1 = the loop, nothing else.** Poll → claim → workspace → one Copilot session →
   reconcile → retry. GitHub Issues only. Logs only. If it doesn't serve that loop,
   it's post-v1.
2. **Decide subprocess-vs-SDK with a spike, not a debate.** Timebox it in Sprint 0.
   Both sit behind `AgentRunner`, so the decision is reversible.
3. **The spec is our acceptance criteria.** SPEC.md sections map to issues. We're
   not inventing a product; we're porting one. That keeps scope honest.
