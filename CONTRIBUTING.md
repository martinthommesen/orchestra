# Contributing to Orchestra

Thank you for contributing! This guide covers setup, the development workflow, quality
gates, commit conventions, and the PR process.

## Prerequisites

- **Node.js ≥22** (the CI matrix runs 22 and 24).
- **pnpm ≥11.8.0** — install with `npm install -g pnpm` or
  [follow the official guide](https://pnpm.io/installation).
- A GitHub account and a fine-grained token with _Issues_ + _Pull Requests_ read access
  for any repo you point Orchestra at.

## Setup

```bash
git clone https://github.com/martinthommesen/orchestra.git
cd orchestra
pnpm install          # zero third-party postinstall scripts — supply-chain safe
cp WORKFLOW.example.md WORKFLOW.md   # edit for your target repo
export GITHUB_TOKEN=ghp_...          # least-privilege Issues + PRs token
```

## Development workflow

```bash
pnpm dev ./WORKFLOW.md               # run daemon from source (tsx, hot-reload)
pnpm dev ./WORKFLOW.md --port 4317   # daemon + cockpit on http://127.0.0.1:4317
pnpm dev:cockpit                     # Vite HMR server for the cockpit SPA
```

## Quality gate

Run **`pnpm check`** before every commit:

```bash
pnpm check   # = pnpm typecheck && pnpm lint && pnpm test && pnpm doctor:score
```

Individual gates:

```bash
pnpm typecheck    # tsc --noEmit (strict, both tsconfigs)
pnpm lint         # biome check . && prettier --check "**/*.{md,yml,yaml,html}"
pnpm lint:fix     # auto-fix lint + format issues
pnpm test         # vitest run (429 tests, 39 files)
pnpm doctor:score # react-doctor health-check (must stay 100/100)
pnpm build        # tsup (CLI) + vite build (cockpit) — also run in CI
```

All gates must be green before a PR can merge.

## Commit convention

Orchestra uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short imperative title (≤72 chars)

Optional body explaining why the change was made and its user impact.
```

**Types:** `feat` · `fix` · `chore` · `docs` · `refactor` · `test` · `build` · `ci`

**Examples:**

```
feat(tracker): add required_labels filter for candidate selection
fix(retry): cap exponential backoff at max_retry_backoff_ms
chore(deps): upgrade effect to 3.21.4
docs(effect-guide): add TestClock gotcha for wall-clock bypass
```

Append `BREAKING CHANGE:` in the footer for any incompatible config/API change.
For AI-assisted changes add a trailer: `Assisted-by: Claude:Sonnet-4.6`.

## Effect conventions

Orchestra's core is Effect all the way through — no bare `async`/`Promise`. Before
editing `src/core/`, read **`docs/effect-guide.md`** for the six key concepts (Effect,
Layer/Tag, Schema, TaggedError, Schedule, TestClock) with real Orchestra examples.

Key rules:

- Wrap all throwing/I-O calls in `Effect.try` or `Effect.tryPromise`.
- Every failure mode is a `Data.TaggedError` (see `src/core/errors.ts`).
- Services are `Context.Tag`s; tests provide fake `Layer`s — no direct instantiation.
- Never put secrets (tokens, resolved `$VAR` values) in error payloads or logs.

## Project structure

```
src/
  cli/          CLI entry (bin: orchestra)
  core/         Orchestrator logic — domain, ports, errors, workflow
  adapters/     Real I/O adapters (GitHub/Octokit, Copilot runner, workspace)
  cockpit/      React 19 + Vite operator SPA
test/           Vitest suite (fake adapters, TestClock)
docs/           Effect guide, architecture, sprint history
```

## Pull request process

1. Branch from `main`: `git checkout -b feat/my-thing`.
2. Run `pnpm check` — all gates must pass.
3. Open a PR with the PR template filled in.
4. Address all review comments; re-run `pnpm check` after each update.
5. A maintainer merges once CI is green and the review is approved.

Keep PRs focused: one logical change per PR makes review and bisection easier.

## Reporting bugs and security issues

- **Bugs:** open a GitHub Issue.
- **Security vulnerabilities:** see [SECURITY.md](./SECURITY.md) — report privately via
  GitHub Security Advisories, not a public issue.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE) (the same license as the project).
