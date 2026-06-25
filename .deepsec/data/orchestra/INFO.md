# orchestra

## What this codebase does

Orchestra is a Node 22+ TypeScript/Effect daemon that reads GitHub Issues, creates one isolated workspace per issue, and runs headless GitHub Copilot sessions with bounded concurrency, retries, durable state, and operator observability. It also serves a loopback-only React cockpit and typed HTTP API when started with `--port`.

## Auth shape

- `CockpitAuthLive` gates every mutating cockpit endpoint; reads remain token-free but still pass through the loopback host guard.
- `parseBearer`, `tokenMatches`, `originIsLoopback`, and `hostIsLoopbackHeader` are the pure security primitives for bearer auth, CSRF, and DNS-rebinding checks.
- `resolveToken` reads `ORCHESTRA_COCKPIT_TOKEN` or mints a per-process CSPRNG token; `injectToken` places it into same-origin cockpit HTML for browser mutations.
- `WorkflowFile` is the only cockpit settings write path. It exposes only whitelisted knobs and must never serialize tracker secrets or resolved `$VAR` values.
- `makeOctokit` is the GitHub auth boundary. `tracker.api_key` is handed only to Octokit and the Copilot child environment, not logs or API responses.

## Threat model

Highest-impact risks are cross-origin or DNS-rebinding access to cockpit mutations, leakage of `GITHUB_TOKEN` or `ORCHESTRA_COCKPIT_TOKEN`, filesystem escape from per-issue workspaces, and unsafe execution of workflow hooks or Copilot subprocesses. GitHub issue title/body/labels are untrusted prompt input that can influence the coding agent, but they should not affect daemon control flow beyond the typed issue model. `WORKFLOW.md` is operator-controlled configuration, yet the cockpit settings editor must preserve secret-bearing fields byte-for-byte and only hot-apply safe orchestration knobs.

## Project-specific patterns to flag

- Cockpit mutating endpoints must remain inside the `control` API group and use `CockpitAuth`; adding a new mutation to the read group is a security bug.
- Static asset serving must keep `resolveAssetPath` path-under-root checks and token injection confined to `index.html`; never serve arbitrary filesystem paths from request URLs.
- Workspace paths must go through `sanitizeWorkspaceKey` plus `computeWorkspacePath`; direct concatenation of issue identifiers into paths is suspect.
- Shell hooks are intentionally `sh -lc` in the workspace with captured/truncated output and `hooks.timeout_ms`; inherited stdout/stderr or missing timeout changes are risky.
- Copilot runs with `cwd === workspacePath`, `-C workspacePath`, scoped teardown, and token-only env injection; broadening cwd, logging prompts/env, or removing finalizers is high risk.

## Known false-positives

- `test/**` and `test/fakes/**` contain literal test tokens, fake workflow files, and deliberate malformed payloads.
- `docs/**` and `PROJECT_BRIEF.md` describe historical designs and may mention removed APIs, tokens, or insecure examples as prose.
- `WORKFLOW.example.md` intentionally shows `$GITHUB_TOKEN`, sample shell hooks, and operator-facing config examples.
- `src/core/cockpit/token.ts` logs a generated cockpit token once by design so a local operator can use the UI; env-pinned tokens are not logged.
- `src/adapters/workspace/workspace-manager.ts` intentionally executes trusted operator hook strings; flag only changes that weaken cwd confinement, timeout, or output handling.
