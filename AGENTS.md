# Orchestra — Agent Instructions

Orchestra is a TypeScript daemon that orchestrates GitHub Copilot coding-agent sessions.
It reads work from GitHub Issues, creates isolated per-issue workspaces, and runs headless
Copilot CLI sessions with bounded concurrency, exponential-backoff retries, and durable
state checkpointing. An optional React web cockpit surfaces the live fleet state.

## Repository layout

```
src/
  cli/          CLI entry-point (orchestra binary, src/cli/main.ts)
  core/         Effect-based orchestrator: domain, ports, errors, workflow logic
    domain/     Schema-validated types (Issue, Config, AgentEvent, …)
    ports/      Dependency-injection seams (IssueTracker, AgentRunner, WorkspaceManager)
    errors.ts   Every tagged error class (TurnTimeout, TurnInputRequired, …)
  adapters/     Real implementations: GitHub tracker (Octokit), Copilot runner, workspace
  cockpit/      React 19 + Vite SPA — operator UI (Fleet, Events, Kanban, Settings)
test/           Vitest test suite with fake adapters and TestClock
docs/           Architecture docs, Effect guide, sprint progress
```

## Tech stack

- **Runtime:** Node.js ≥22; TypeScript (strict).
- **Core:** [Effect](https://effect.website) (`effect`, `@effect/platform`,
  `@effect/platform-node`) — typed errors, Layer DI, fibers, Schedule retries, Schema.
  See `docs/effect-guide.md` for the six key concepts with real Orchestra examples.
- **CLI build:** tsup → `dist/cli/main.js` (bin `orchestra`).
- **Cockpit build:** Vite → `dist/cockpit/`.
- **GitHub integration:** `@octokit/rest` behind the `IssueTracker` port.
- **Templating:** `liquidjs` — strict Liquid rendering for per-issue prompts.
- **Lint/format:** Biome (`biome.json`) for TS/JS; Prettier for `.md/.yml/.yaml/.html`.
- **Tests:** Vitest + `@effect/vitest` + `fast-check` (property tests). 429 tests, 39 files.
- **React quality gate:** `react-doctor` (`doctor.config.json`).
- **Package manager:** pnpm@11.8.0; Node ≥22; `pnpm-workspace.yaml`.

## Commands

```bash
pnpm install          # install all dependencies
pnpm dev ./WORKFLOW.md                  # run daemon from source (tsx)
pnpm dev ./WORKFLOW.md --port 4317      # daemon + cockpit on http://127.0.0.1:4317
pnpm dev:cockpit                        # Vite hot-reload dev server for cockpit UI

pnpm build            # tsup (CLI) + vite build (cockpit) → dist/
pnpm typecheck        # tsc --noEmit (strict) on both tsconfig.json + tsconfig.cockpit.json
pnpm lint             # biome check . && prettier --check "**/*.{md,yml,yaml,html}"
pnpm lint:fix         # auto-fix lint + format issues
pnpm test             # vitest run (all 429 tests)
pnpm doctor:score     # react-doctor health check (must stay 100/100)
pnpm check            # full quality gate: typecheck + lint + test + doctor:score
```

Run `pnpm check` before every commit. The CI merge gate runs the same suite.

## Effect conventions

Everything that can fail, block, or touch I/O is an `Effect`. No bare `async`/`Promise`
in the core. Key patterns:

- Wrap throwing calls in `Effect.try` / `Effect.sync`; use `Effect.tryPromise` only at
  the outermost edge adapters.
- Every failure mode is a `Data.TaggedError` (see `src/core/errors.ts`). Never put
  secrets (tokens, resolved `$VAR` values) in an error payload.
- Services are `Context.Tag` instances; implementations are `Layer`s.
  `main.ts` wires layers; tests provide fakes — never instantiate services directly.
- Use `Schema.decodeUnknown` at trust boundaries (WORKFLOW.md YAML, agent JSON events).
  Defaults live in the schema, not scattered around caller code.
- Retry/repeat policies use `Schedule`; the poll loop is `Effect.repeat(Schedule.spaced(…))`.
- Time-sensitive tests use `TestClock` from `@effect/vitest` — no real `Date.now()` in core.

## Architecture rules

- The orchestrator owns a single `OrchestratorState` fiber; the cockpit never modifies state
  directly — all mutations go through the command channel.
- Secrets (`$VAR` references, tokens) are resolved at config load and never serialized,
  logged, or exposed through the cockpit API or error messages.
- Per-issue workspaces are isolated; the agent's `cwd` IS that workspace (Safety Invariant 1).
- Two credentials are deliberately separate: tracker API key (issue polling) vs.
  agent GitHub token (Copilot session) — they are never merged.

## Commit convention

```
type(scope): short imperative title (≤72 chars)

Body: what changed and why (user impact).

Assisted-by: Claude:Sonnet-4.6
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Examples:
`feat(tracker): add label-filter for required_labels` · `fix(retry): cap backoff at max_retry_backoff_ms`.

## Do not

- Edit `.impeccable/`, `.claude/`, `.deepsec/`, `.cockpit-shots/`, or `WORKFLOW.md` (gitignored operator config).
- Hard-code tokens or resolved `$VAR` values anywhere.
- Use `async`/`Promise` in `src/core/` — use Effect primitives throughout.
- Skip `pnpm check` before committing.
