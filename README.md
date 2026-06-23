# Orchestra

> Conduct a section of coding agents — don't supervise them.

**Orchestra** is an end-to-end type-safe TypeScript reimplementation of OpenAI's
[Symphony](https://github.com/openai/symphony). It is a long-running daemon that
reads work from an issue tracker, creates an isolated workspace per issue, and runs
a **GitHub Copilot** coding-agent session for that issue with bounded concurrency,
exponential-backoff retries, tracker reconciliation, and operator observability.

Where Symphony drives **Codex app-server**, Orchestra drives the **GitHub Copilot
SDK / headless Copilot CLI**. Where the reference implementation is Elixir/OTP,
Orchestra is **TypeScript on [Effect](https://effect.website)** — typed errors,
dependency injection, structured concurrency (fibers), `Schedule`-based retries,
`Scope`-based resource lifecycle, and `Schema` for validated, end-to-end-typed
config and protocol boundaries.

> [!WARNING]
> Pre-bootstrap. This repo currently contains planning artifacts only (brainstorm,
> project brief, sprint plans). No application code has been written yet — that
> begins in Sprint 0.

## Why "Orchestra"?

Symphony spawns agents to play the score. Orchestra is the ensemble and the
conductor: the orchestrator coordinates many autonomous Copilot agents so a team
can *manage the work* instead of babysitting the agents.

## Project artifacts

| Path | Purpose |
|------|---------|
| `PROJECT_BRIEF.md` | Single source of truth across all team chats |
| `docs/brainstorm/` | Team design debate that set the architecture |
| `docs/sprint-N/` | Per-sprint `plan.md`, `progress.md`, `done.md` |
| `docs/qa/` | QA sign-off reports |
| `docs/ideas-backlog.md` | Deferred feature ideas |

## Reference

- Symphony spec: https://github.com/openai/symphony/blob/main/SPEC.md
- GitHub Copilot CLI: https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli
- Effect: https://effect.website

## License

TBD (Symphony itself is Apache-2.0; a derived reimplementation should pick a
compatible license — see `docs/ideas-backlog.md`).
