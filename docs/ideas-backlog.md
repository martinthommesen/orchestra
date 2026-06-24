# Ideas Backlog

Deferred ideas and feature candidates. Not committed to any sprint. Promote to a
sprint plan (or a GitHub Issue) when ready.

## Deferred from v1 scope (see docs/brainstorm/05-summary.md)

- **Linear tracker adapter.** v1 ships the GitHub Issues adapter only. The tracker
  port stays Linear-shaped so a Linear adapter can drop in later (Symphony parity).
- **Web dashboard (HTML/LiveView equivalent).** v1 ships structured logs + an
  optional JSON API. A richer web UI is post-v1.
- **SSH / remote workers.** Symphony's `make e2e` exercises SSH workers. Orchestra
  v1 runs workers locally only.
- **Durable orchestrator state.** Spec is intentionally in-memory; a persistent
  store (resume retry timers across restart) is a future option.
- **`max_concurrent_agents_by_state`.** Per-state concurrency limits — nice-to-have
  after global concurrency lands.
- **Humanized agent-event summaries.** Observability sugar, post-v1.

## Open questions

- **Bun vs Node.** v1 targets Node 24 + pnpm; revisit Bun for faster cold starts.

## Resolved

- **License → Apache-2.0** (Sprint 2). Matches Symphony's license; `LICENSE` +
  `NOTICE` added at the repo root, `package.json` set to `Apache-2.0`. Orchestra
  ships no Symphony source — the SPEC is a behavioral reference only.
- **Copilot SDK vs headless CLI subprocess → subprocess.** Pinned by the Sprint 0
  spike (`docs/sprint-0/spike-copilot.md`); implemented in Sprint 1.

## Wild ideas (parked)

- Multi-agent "fleet" view: visualize all running Copilot sessions live in a TUI.
- Auto-generated walkthrough videos as proof-of-work (Symphony demo parity).
- Cost guardrails: pause dispatch when token spend crosses a budget.
