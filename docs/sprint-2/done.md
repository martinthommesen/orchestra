# Sprint 2 — Done (Live Ink Dashboard)

Handoff for the Producer. See `plan.md` for the original scope and `progress.md` for
the phase-by-phase log.

## Summary

Shipped a standalone, read-only **`orchestra dashboard`** — an Ink/React 19 terminal
UI that polls the daemon's loopback snapshot API (`GET /api/v1/state`) and renders a
live fleet view. The orchestrator core is **untouched**; the dashboard is a separate
CLI island behind a thin top-level dispatcher and reads the existing snapshot shape.

All six issues closed: **#29 → #34**.

## What was built

| #   | Issue                                   | Outcome                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #29 | Ink toolchain spike & gate              | ink@7.1.0 + react@19.2.7 + react-devtools-core, `@types/react`@19.2.x + ink-testing-library@4; `jsx: react-jsx`, vitest include widened to `{ts,tsx}`, 2nd tsup entry. **Producer-approved.**                                                                                                                                                            |
| #30 | CLI dispatcher + `dashboard` subcommand | Extracted `src/cli/daemon.ts` (`runDaemon` + `appLayer`); `main.ts` is now a thin dispatcher (`argv[0]==="dashboard"` → dashboard, else daemon). Separate dashboard arg parser (`--port/--host/--interval-ms/--ascii/--help`); the daemon's `parseArgs` is untouched.                                                                                    |
| #31 | Snapshot client + polling hook          | Defensive `parseSnapshot` (typed `Snapshot` view, throws `SnapshotParseError`), injectable `makeFetchSnapshot(timeoutMs)` (combines caller signal with `AbortSignal.timeout`). Framework-agnostic `SnapshotPoller` (non-overlapping, `connecting/live/stale`, keeps last good snapshot, `stop()` aborts + clears timer) + thin `useSnapshot` React hook. |
| #32 | View-model + Ink rendering              | Pure `toViewModel(snapshot, now, opts)` + Ink `<Box>` components reusing `glyphs.ts`. Honest rendering (see below). `q`/Ctrl-C unmount + abort + clear timer.                                                                                                                                                                                            |
| #33 | Tests (Ivy shape)                       | view-model state matrix (13), fake-timer poller (5), light ink-testing-library render (4).                                                                                                                                                                                                                                                               |
| #34 | License + docs + handoff                | Apache-2.0 `LICENSE` + `NOTICE`, `package.json` `"license"`, README Dashboard + License sections, this handoff, `PROJECT_BRIEF.md` §5/§7/§8, backlog License item resolved.                                                                                                                                                                              |

### Honest rendering (#32)

- **running**: identifier, status badge (glyph + label), **client-calculated** elapsed
  from `started_at` (not server-trusted), workspace, attempt label (`—` for first run,
  `#n` for retries). Phase → operator status via the core `PHASE_TO_STATUS` map; unknown
  phases degrade to `running`.
- **retrying**: identifier / attempt / error with **no countdown** — `due_at_ms` is a
  monotonic clock value, so a wall-clock countdown would be wrong.
- **completed**: count + a few most-recent **IDs only** (newest first, `…` when more) —
  the API carries no rich completion data.
- **totals** and **rate-limits**: rate-limits are rendered **defensively** — `null` →
  "unavailable", unknown shape → a one-line `JSON.stringify`; never assumes a schema.
- Colors map `ColorToken` → Ink `<Text color>` and honor `NO_COLOR`/non-TTY via
  `shouldUseColor`; glyphs honor `--ascii`.

## Success criteria — verified

1. ✅ `orchestra dashboard --port 4317` renders a live fleet view; counts match the
   snapshot; polls on an interval **without overlapping requests** (verified by the
   poller fake-timer test and a live PTY smoke showing N polls over the window).
2. ✅ Daemon stopped → **stale** banner with the last good data retained (never blanks,
   never crashes); `q`/Ctrl-C exits cleanly (aborts fetch + clears timer).
3. ✅ Honest rendering (running rich w/ elapsed; retrying no countdown; completed
   count + recent IDs; rate-limits defensive).
4. ✅ Reuses `glyphs.ts` (no hand-rolled status/colors); honors `NO_COLOR` + `--ascii`.
5. ✅ **Core orchestrator unchanged** — `git diff --name-only main...HEAD` touches no
   `src/core/**`; only `src/cli/*`, the dashboard module, build/test config, docs, license.
6. ✅ All prior tests green + new dashboard tests: **224 passing** (188 at #29 → −1 spike
   +37 dashboard). `pnpm typecheck/lint/test/build` and `pnpm install --frozen-lockfile`
   all exit 0 locally.

## A bug found & fixed during the sprint

A live PTY smoke (not just ink-testing-library) caught that Ink's `useInput` calls
`setRawMode`, which **throws on a non-TTY stdin** (`stdin.isTTY` is `undefined`, not
`false`). Fixed by gating the key handler with `isActive: isRawModeSupported === true`
(via `useStdin()`), so a piped/redirected invocation renders instead of crashing; the
terminal still exits on SIGINT/SIGTERM. This is the only behavioral surprise we hit.

## Files changed / created

**New (dashboard module):** `src/cli/dashboard.tsx` (tsup entry), `src/cli/daemon.ts`,
`src/cli/dashboard/{args,snapshot-client,poller,use-snapshot,view-model}.ts`,
`src/cli/dashboard/{components,app,run}.tsx`.
**New (tests):** `test/dashboard/{fixtures,args,snapshot-client,view-model,poller}.test.ts`

- `test/dashboard/render.test.tsx`.
  **New (license/docs):** `LICENSE`, `NOTICE`, `docs/sprint-2/done.md`.
  **Modified:** `src/cli/main.ts` (dispatcher), `package.json` (deps + `license` +
  `dev:dashboard`), `pnpm-lock.yaml`, `tsconfig.json` (`jsx`), `tsup.config.ts` (2nd entry),
  `vitest.config.ts` (`{ts,tsx}`), `README.md`, `PROJECT_BRIEF.md` (§5/§7/§8),
  `docs/ideas-backlog.md`, `docs/sprint-2/progress.md`.
  **Removed:** `test/dashboard-spike.test.tsx` (the #29 spike served its purpose).

## How to run / verify

```bash
pnpm install --frozen-lockfile     # exits 0, no third-party build scripts
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # all exit 0; 224 tests

# Live, two terminals:
pnpm dev ./WORKFLOW.md --port 4317  # daemon + snapshot API
orchestra dashboard                 # (or: pnpm dev:dashboard) live view on 127.0.0.1:4317
```

## Dependency / config notes (for the Producer's CI check)

- Runtime deps are real `dependencies` (we build with `skipNodeModulesBundle: true`):
  `ink`, `react`, `react-devtools-core`. Dev: `@types/react`, `ink-testing-library`.
- `tsup.config.ts` has a **single** config object with two `entry` items
  (`main.ts` + `dashboard.tsx`) — `clean: true` would otherwise wipe the other output.
- The strict TS settings were honored without relaxing them: `jsx: react-jsx` (no bare
  `import React`), type-only imports for `verbatimModuleSyntax`, and conditional
  prop-spreads (`color ? {color} : {}`) for `exactOptionalPropertyTypes`. We did **not**
  add `"react"` to `tsconfig` `types` — typecheck passed without it.
- gitleaks flagged a false positive on a React prop literally named `token`; renamed it
  to `tone` (a design-system color tone) — clearer and clean, no `--no-verify` needed.

## Not in scope (deferred to backlog, per plan)

Event feed / log stream / ring buffer; in-process `--tui` mode; control plane / auth /
metrics export; PR/branch write-back. The dashboard renders operational **state**, not
history.

## Handoff to Producer

Branch `feature/sprint-2` is pushed with one commit per issue (#29–#34). CI should be
green on Node 22 + 24; please verify CodeQL + Socket on the new react/ink deps, then
open and merge the PR. Core orchestrator is untouched.
