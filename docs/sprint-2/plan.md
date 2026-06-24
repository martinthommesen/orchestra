# Sprint 2 — Live Ink Dashboard (operational status TUI)

Branch: `feature/sprint-2` · Issues: #29–#34 · Producer opens the PR.

## Goal

Ship the headline observability feature: **"glance and know what the orchestra is
doing right now."** A standalone Ink (React-for-terminals) dashboard —
`orchestra dashboard` — that polls the existing loopback snapshot API
(`GET /api/v1/state`) and renders a live fleet view of running / retrying /
completed workers, token+runtime totals, rate limits, and connection state.

This is **operational status, not forensic history** (decided in the Sprint 2
design review). The current snapshot is sufficient for status; it is NOT a
telemetry/event subsystem and we will not turn it into one this sprint.

## Non-negotiable constraints

1. **The QA-hardened core orchestrator loop is untouched.** No changes to
   `src/core/orchestrator/{loop,state,reconcile,selection,concurrency,backoff}.ts`
   or the snapshot/observer **shape**. The dashboard is a pure, read-only client
   of the existing `/api/v1/state` contract. The only CLI-layer change is a thin
   top-level dispatcher (below).
2. **Reuse the design system.** All status glyphs, ASCII fallbacks, semantic
   colors, `NO_COLOR`/TTY handling, and truncation come from
   `src/core/observability/glyphs.ts`. Do **not** hand-roll glyphs or ANSI.
3. **Render the snapshot honestly** (see "Snapshot contract" — don't promise data
   the API doesn't carry).
4. All prior 187 tests stay green; new tests are added. Gates green on Node 22+24
   + CodeQL + Socket (react/ink supply-chain).

## Snapshot contract (what we can honestly render)

`GET /api/v1/state` → `toSnapshot(state)`:

- `running: RunAttempt[]` — **rich**: `issue_id`, `issue_identifier`, `attempt`
  (null|int), `workspace_path`, `started_at` (ISO), `status` (1 of 11 phases →
  map through `phaseStatus()` to the 5 operator statuses), `error?`.
  → elapsed is **client-calculated** from `started_at` (loopback = same host, fine;
  label it "elapsed").
- `retrying: RetryEntry[]` — `issue_id`, `identifier`, `attempt` (1-based),
  `due_at_ms` (**monotonic clock — NOT wall-clock**), `error` (null|string).
  → show identifier / attempt / error. **No live countdown** (due_at_ms is
  monotonic; the client cannot turn it into "retry in 12s").
- `completed: string[]` — **issue IDs only**. → show count + a few recent IDs, not
  a rich table.
- `totals: { input_tokens, output_tokens, total_tokens, runtime_seconds }`.
- `rate_limits: null | unknown` (vendor passthrough). → render defensively;
  "unavailable" when null; never assume a schema.
- `counts`, `poll_interval_ms`, `max_concurrent_agents` for the header.

## Tasks (priority order)

### #29 — Ink toolchain spike & gate  **(BLOCKING — do first)**
Stand up React 19 + Ink 7 in this strict ESM/Effect repo and prove the toolchain
end-to-end with a throwaway component before any UI is written.
- Add **dependencies**: `ink@^7`, `react@^19.2`, `react-devtools-core` (ink peer).
  Add **devDependencies**: `@types/react@^19.2`, `ink-testing-library@^4`.
  (`skipNodeModulesBundle:true` ⇒ runtime deps must be real `dependencies`.)
- `tsconfig.json`: add `"jsx": "react-jsx"`; add `"react"` to `types` only if the
  spike proves it's needed. Keep `verbatimModuleSyntax`/`isolatedModules`/
  `exactOptionalPropertyTypes` — work *with* them (type-only imports; no bare
  `import React`; conditional prop spreads instead of `prop={maybeUndefined}`).
- `vitest.config.ts`: widen `include` to `test/**/*.test.{ts,tsx}` (today it's
  `*.test.ts`, so `.test.tsx` would be silently skipped).
- `tsup.config.ts`: add the dashboard entry **in the same config** (a second
  config with `clean:true` would wipe the other output).
- Throwaway `src/cli/dashboard.tsx` rendering `<Text>orchestra dashboard</Text>` +
  one `ink-testing-library` assertion.
- **Acceptance / gate**: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
  `pnpm lint`, `pnpm test`, `pnpm build` all exit 0, and the built dashboard runs
  from `dist`. **If the toolchain won't integrate cleanly, STOP and rescope the
  sprint** (fall back to a non-Ink render or defer) rather than fighting it.

### #30 — CLI dispatcher + `dashboard` subcommand
Make `orchestra dashboard` real without overloading the daemon's arg parser.
- Extract the daemon entry as `runDaemon(argv)`; add `runDashboard(argv)`.
- Thin top-level dispatcher: `argv[0] === "dashboard"` → dashboard; otherwise the
  existing `orchestra <WORKFLOW.md> [--port N]` daemon path (unchanged behavior &
  tests still green).
- Dashboard args parsed **separately** (don't mutate `parseArgs` into a
  "sometimes workflow / sometimes subcommand" parser):
  `orchestra dashboard [--port 4317] [--host 127.0.0.1] [--interval-ms 1000]
  [--ascii]`, plus `--help`.
- Core orchestrator loop untouched.

### #31 — Snapshot client + polling hook
The read-only data layer, fully injectable for tests.
- Typed `fetchSnapshot(baseUrl, signal)` → GET `/api/v1/state` with
  `AbortSignal.timeout(...)`; parse/validate into a `Snapshot` view type.
- Polling that **never overlaps** (schedule the next poll *after* the previous
  completes, or guard in-flight) — no raw `setInterval(async …)`.
- On error: **keep the last good snapshot** and surface a `connecting | live |
  stale` connection state — never blank the UI on a single failed poll.
- Plain React hook with an **injected** fetcher (do NOT bridge an Effect runtime
  into Ink's lifecycle — keep the UI island simple and testable).

### #32 — Dashboard view-model + Ink rendering
- Pure `toViewModel(snapshot, now, opts)` → header (poll interval, cap,
  connection state), running rows (identifier, status badge via `glyphs.ts`,
  elapsed, workspace, attempt), retrying rows (identifier, attempt, error — no
  countdown), completed (count + recent IDs), totals, rate-limits (defensive).
- Ink components render the view-model with **Box layout** (no hand-padded
  columns — let Ink lay out). Map `glyphs.ts` `ColorToken` → Ink `<Text color>`.
  Honor `--ascii` (use the ASCII glyph fallbacks for strict alignment) and
  `NO_COLOR` via `shouldUseColor`.
- `q` and Ctrl-C exit cleanly: unmount Ink, abort the in-flight fetch, clear the
  timer (no leaked handles).

### #33 — Test suite (Ivy shape — meaningful, non-flaky)
- **View-model unit tests** for every state: empty, running, retrying,
  completed-IDs-only, totals populated, `rate_limits: null`, `rate_limits`
  unknown-shape.
- **Polling-hook tests** with injected fetch + fake timers: no overlapping
  requests; disconnect after a good snapshot preserves stale data + sets the
  banner; unmount aborts polling/timers.
- A **light** `ink-testing-library` render assertion per major state (the
  view-model carries the logic; keep exact terminal-string snapshots minimal —
  they get brittle).

### #34 — Apache-2.0 license + dashboard docs + handoff
- Add `LICENSE` (full Apache-2.0 text) + `NOTICE`; set `package.json`
  `"license": "Apache-2.0"`; README license section/badge. (Symphony is
  Apache-2.0; this resolves the open License question in the backlog.)
- README "Dashboard" section: run the daemon with `--port`, then
  `orchestra dashboard` in a second terminal; document `--host/--interval-ms/
  --ascii`.
- `docs/sprint-2/done.md` handoff; update `PROJECT_BRIEF.md` §5/§7/§8 and resolve
  the License item in `docs/ideas-backlog.md`.

## Dependencies
- #29 blocks #30, #31, #32, #33.
- #32 depends on #31. #33 depends on #31 + #32. #30 independent after #29.
- #34 (license) independent; its docs portion depends on #32.

## Success criteria
1. `orchestra dashboard --port 4317` renders a live fleet view whose counts match
   `curl 127.0.0.1:4317/api/v1/state`, refreshing on an interval **without
   overlapping requests**.
2. With the daemon stopped, the dashboard shows a disconnected/stale banner and
   keeps retrying — it never crashes; `q`/Ctrl-C exits cleanly.
3. Honest rendering: running rich (with elapsed); retrying without a countdown;
   completed as count + recent IDs; rate-limits defensive ("unavailable" when
   null).
4. Reuses `glyphs.ts` (no hand-rolled status/colors); honors `NO_COLOR` + `--ascii`.
5. **Core orchestrator loop unchanged** — the diff touches only `src/cli/*`, the
   new dashboard module, build/test config, docs, and the license.
6. All 187 prior tests still green + new dashboard tests; `pnpm check` and
   `pnpm build` exit 0; CI green on Node 22+24 + CodeQL + Socket.

## Deferred to backlog (explicitly NOT this sprint)
Recent-events feed, Observer-backed ring buffer, in-process `--tui` renderer, log
tailing/forensic timeline, snapshot enrichment.
