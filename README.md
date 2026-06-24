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

> [!NOTE]
> Active development. The core orchestrator loop is implemented (Sprint 1): polling,
> candidate selection, bounded-concurrency dispatch, per-issue workspaces, Copilot
> sessions, tracker reconciliation, exponential-backoff retries, and structured
> observability — all on Effect, proven end-to-end against fakes under `TestClock`.
> A standalone live **dashboard** (Sprint 2) renders the daemon's snapshot in your
> terminal.

## Quickstart

```bash
pnpm install                       # install workspace deps (no third-party build scripts run)
cp WORKFLOW.example.md WORKFLOW.md  # then edit for your repo (see Configuration)
export GITHUB_TOKEN=...             # least-privilege repo token (Issues + PRs); $VAR-resolved, never written to the file

pnpm dev ./WORKFLOW.md             # run the daemon from source (tsx)
pnpm dev ./WORKFLOW.md --port 4317 # also expose the read-only JSON snapshot API on 127.0.0.1:4317
```

The daemon runs until interrupted (Ctrl-C / SIGTERM); interrupting it tears down every
worker, retry timer, and the snapshot server cleanly. It emits one structured
`key=value` (logfmt) line per event, each carrying `issue_id` / `issue_identifier` /
`session_id` context where applicable.

When `--port N` is set, a loopback-only endpoint serves the live state:

```bash
curl -s http://127.0.0.1:4317/api/v1/state | jq
# { "poll_interval_ms": ..., "counts": { "running": N, "retrying": N, "completed": N, ... },
#   "running": [...], "retrying": [...], "completed": [...], "totals": {...}, "rate_limits": ... }
```

## Dashboard

`orchestra dashboard` is a standalone, read-only terminal UI (Ink) that polls the
daemon's loopback snapshot API and renders a live fleet view — running agents (with
client-side elapsed time, status, workspace, attempt), scheduled retries, recent
completions, token/runtime totals, and rate limits. It owns no orchestrator state; it
only reads the snapshot, so you can start and stop it freely without touching the run.

Start the daemon with a snapshot port, then run the dashboard in a second terminal:

```bash
pnpm dev ./WORKFLOW.md --port 4317   # terminal 1: daemon + snapshot API on 127.0.0.1:4317
orchestra dashboard                  # terminal 2: live view (defaults to 127.0.0.1:4317)
# from source instead of the built bin:
pnpm dev:dashboard                   # tsx src/cli/dashboard.tsx
```

Flags (parsed independently of the daemon):

| Flag | Default | Meaning |
|------|---------|---------|
| `--port <n>` | `4317` | Snapshot API port to poll |
| `--host <host>` | `127.0.0.1` | Snapshot API host |
| `--interval-ms <n>` | `1000` | Poll interval in milliseconds |
| `--ascii` | off | ASCII status glyphs instead of Unicode |
| `--help` | — | Show usage and exit |

Color is automatic: it honors `NO_COLOR` and disables on a non-TTY. Polls never
overlap (the next request is scheduled only after the previous resolves), and a
failed poll keeps the last good snapshot on screen while the header flips to
`stale` — the view never blanks on a transient blip. Press `q` or Ctrl-C to quit;
the in-flight fetch is aborted and timers are cleared on exit.

## Configuration

`WORKFLOW.md` is YAML front matter (configuration) plus a Liquid body (the per-issue
prompt template). Every block is optional with sensible defaults; secrets use `$VAR`
indirection resolved from the environment at load and are never written to the file.
See [`WORKFLOW.example.md`](./WORKFLOW.example.md) for the fully annotated reference.

## Build & quality gates

```bash
pnpm typecheck   # tsc --noEmit (strict)
pnpm lint        # biome check
pnpm test        # vitest + @effect/vitest + fast-check
pnpm build       # tsup → dist/
```

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

Orchestra is licensed under the [Apache License 2.0](./LICENSE) — the same license
as Symphony, the reference architecture it reimplements. Orchestra contains no
Symphony source code; it follows the public SPEC as a behavioral reference. See
[`NOTICE`](./NOTICE) for attribution.
