# Sprint 6 — Progress

Live tracker. Theme: **The Web Cockpit** (a daemon-served browser UI with **full control** —
fleet/session overview + kanban + events + live-edit/persist of `WORKFLOW.md` settings).
Branch: `feature/sprint-6` (off `main`, all Sprint 5 work merged).

## Board

| # | Task | Owner | Effort · Risk | Status |
|---|------|-------|---------------|--------|
| #64 | Command channel (`CommandBus` + mailbox `Msg.Command`) + operator pause/resume/retry-now/cancel | Sage | M · Med | ✅ done |
| #65 | Cockpit `HttpApi` server (read + mutating endpoints, auth/Origin, static SPA; replaces snapshot router) | Sage | M · Med | ✅ done |
| #66 | Settings: read editable subset + persist whitelisted patch to `WORKFLOW.md` + hot-reload | Sage | M · Med | ✅ done |
| #67 | Vite+React cockpit scaffold, daemon static serving, dev proxy, token bootstrap, build wiring, API client | Nova | M · Low | ✅ done |
| #68 | Cockpit design system + app shell (web parity of `glyphs.ts`/`design-system.md`) | Milo | S–M · Low | ✅ done |
| #69 | Fleet / Session overview + Events feed views | Nova | M · Low | ✅ done |
| #70 | Kanban board view with actionable cards (Cancel / Retry-now) | Nova | M · Med | ☐ todo |
| #71 | Settings view + global pause/resume control | Nova (art: Milo) | M · Med | ☐ todo |
| #72 | Remove Ink dashboard + deps; tests + docs + handoff close-out | Nova (docs: Remy) | M · Low | ☐ todo |

Dependencies: `#64 → #65 → #66` · `#65 → #67 → #68 → {#69, #70, #71}` · `#64 → #70` ·
`#66 → #71` · `#72 → all`.
Build order: **#64 → #65 → #66** (backend; gate #64 like the budget gate) → **#67 → #68**
(scaffold + design) → **#69/#70/#71** (views, parallelizable) → **#72** close-out.

Baseline at sprint start: **336 tests** green on `main` (Sprint 5 merged; `pnpm check` =
typecheck + lint + 336 tests).

## Phase checklist

### Phase 1 — Backend control plane (Sage)
- [x] #64 — `CommandBus` service + `Msg.Command` + boot-forked pump fiber
- [x] #64 — serial command handler: `PauseDispatch`/`ResumeDispatch` (`operatorPaused` latch)
- [x] #64 — `RetryNow` + `CancelSession` (interrupt only the named worker)
- [x] #64 — additive `control` snapshot block + feed/logfmt observations
- [x] #64 — loop test (in-flight work untouched by operator-pause; cancel scoped to one fiber)
- [x] #65 — `CockpitApi` `HttpApi`: `GET /api/v1/state` (byte-compatible) + mutating endpoints
- [x] #65 — auth + loopback-Origin middleware (mutating endpoints) + token bootstrap injection
- [x] #65 — static SPA serving from `dist/cockpit/` with index fallback
- [x] #65 — `daemon.ts` wiring (`runCockpit`, `CommandBusLive`)
- [x] #66 — `WorkflowFile` service: read raw front-matter, editable-subset projection
- [x] #66 — `PUT` validate → patch whitelist → atomic write (body + `$VAR` verbatim)
- [x] #66 — `ReloadConfig` command (`ConfigRef` swap + state knob patch), hot-apply on next tick
- [x] #66 — secret-safety test: `api_key` + Liquid body byte-identical across a write

### Phase 2 — Frontend SPA (Nova + Milo)
- [x] #67 — `src/cockpit/` Vite+React+TS scaffold + `vite.config.ts` (build/proxy)
- [x] #67 — typed plain-`fetch` API client (token from injected bootstrap)
- [x] #67 — `pnpm build` runs `tsup` + `vite build`; biome covers `src/cockpit/`
- [x] #68 — web design tokens (status colors/glyph parity) + nav shell + shared primitives
- [x] #69 — Fleet/Session overview view (non-overlapping poll, last-good-on-error)
- [x] #69 — Events feed view (newest-first, filterable)
- [ ] #70 — Kanban columns (pure derivation) + Cancel/Retry-now buttons
- [ ] #71 — Settings form (whitelist, client validation, no secrets) + Pause/Resume toggle

### Phase 3 — Close-out
- [ ] #72 — delete `src/cli/dashboard/` + `dashboard.tsx` + `dashboard` subcommand
- [ ] #72 — remove `ink` / `ink-testing-library` / `react-devtools-core`; add `vite` / `@vitejs/plugin-react` / `react-dom` / `@types/react-dom`
- [ ] #72 — cross-feature coverage audit/fill
- [ ] #72 — README (cockpit usage, `--port`, token, settings whitelist, security posture)
- [ ] #72 — `docs/sprint-6/done.md` + this close record + `PROJECT_BRIEF.md` §5/§7/§8

## Notes

### #64 — Command channel + operator control commands (Sage)
Files: `src/core/orchestrator/command.ts` (new — `Command`/`CommandResult`/`CommandBus`),
`src/core/observability/control-status.ts` (new — operator-pause mirror for the snapshot),
`src/core/orchestrator/messages.ts` (+`Msg.Command`), `loop.ts` (latch + dispatch gate +
serial `handleCommand` + command pump fiber), `observer.ts`/`live-observer.ts`/
`recent-events.ts` (+`OperatorControl`/`SessionCancelled`/`RetryNowRequested` observations),
`snapshot-server.ts` (additive `control` block), `daemon.ts` + `test/fakes/harness.ts`
(wire `ControlStatusLive` + `CommandBusLive`). Test: `test/command-control.test.ts` (3
scenarios mirroring `budget-gate.test.ts`).

Decisions:
- **Operator pause is a loop-local `let` latch**, mirrored into a tiny `ControlStatus`
  service (Ref) written ONLY by the owner fiber and read by the snapshot server — same
  single-writer pattern as `RestoreStatus`/`LiveActivity`. The HTTP fiber never writes it.
- Dispatch gate is now `(budget.paused || operatorPaused) ? [] : planDispatch(...)`,
  matching the budget gate exactly; `TickEnd.dispatchSkipped` reflects either cause.
- `control` snapshot block is **additive — emitted only when dispatch is actually withheld**
  (`{ dispatch_paused: true, paused_by: "operator" | "budget" }`); omitted otherwise, so the
  Sprint-5 wire bytes are unchanged when nothing is paused.
- `CommandResult` is two shapes: `Control` (pause/resume → `{ dispatchPaused, pausedBy }`)
  and `Ack` (retry/cancel → `{ accepted, reason }`). `RetryNow` accepts only when a backoff
  timer is pending (interrupts it first to avoid a double-dispatch, then runs the normal
  re-dispatch path); `CancelSession` interrupts only the named worker+timer and `release`s
  the issue (not a completion, so it can be re-picked).
- `ReloadConfig` command variant is defined now (keeps the union exhaustive) but its handler
  is a deliberate ack-only no-op until #66 wires settings hot-reload.
Gates: typecheck + lint clean, **339 tests** (336 baseline + 3), `pnpm build` green.

### #65 — Cockpit `HttpApi` server (Sage, dep #64)
Files (new): `src/core/cockpit/api.ts` (the one `CockpitApi` `HttpApi` — `read` + `control`
groups, wire schemas, `CockpitAuth` middleware tag), `security.ts` (pure bearer/Origin/Host
loopback helpers), `token.ts` (`CockpitToken` service, env/CSPRNG resolution, `index.html`
token injection), `auth.ts` (`CockpitAuthLive` — fail-closed 401/403 guard), `handlers.ts`
(`read` byte-compat handler + `control` handlers → `CommandBus` with a 503 timeout),
`static.ts` (SPA static handler, path-traversal-safe, index fallback + token injection,
graceful 404), `server.ts` (`runCockpit` — assembles the API + static `serve` middleware +
node http/fs layers, bind-failure → log + idle). Replaced: `snapshot-server.ts` →
`snapshot.ts` (DD-1 forward-only — now the **pure projection** only; `toSnapshot` retained,
all `makeRouter`/`runSnapshotServer`/HTTP imports removed). Modified: `daemon.ts`
(`runSnapshotServer` → `runCockpit`). Tests: `test/cockpit-server.test.ts` (byte-compat read,
401, 403, command-flow over the bus, graceful 404), `test/cockpit-security.test.ts` (12 pure
security/token/path-safety units), `test/snapshot.test.ts` (renamed; pure `toSnapshot` only);
all `snapshot-server` import paths updated repo-wide.

Decisions:
- **DD-1 byte-compat**: the `read` endpoint declares its 200 as `Schema.Unknown` and the
  handler returns a raw `HttpServerResponse.json(toSnapshot(...))`, bypassing schema
  re-encoding. A round-trip test asserts the response bytes equal
  `JSON.stringify(toSnapshot(state, sameExtras))` exactly.
- **DD-1 forward-only**: the hand-rolled router is deleted outright; `snapshot-server.ts` is
  renamed to `snapshot.ts` and reduced to the pure projection (a misnomer no longer — it
  serves nothing). No dual router, no `/api/v2`.
- **DD-5 auth**: `control` is its own group carrying the `CockpitAuth` middleware; `read`
  carries none (token-free). The guard fails closed: 401 on missing/blank/wrong bearer, 403
  on non-loopback `Origin`/`Host` (CSRF + DNS-rebinding defense). Policy lives in pure,
  unit-tested `security.ts`.
- **DD-5 token**: `ORCHESTRA_COCKPIT_TOKEN` (non-empty) wins, else a 256-bit CSPRNG hex token
  minted at boot and logged **once** (value logged only when generated, never the env-pinned
  one). Injected into the served `index.html` as a JSON-encoded `<script>` global so the SPA
  reads it same-origin without a round-trip (a cross-origin tab cannot, by SOP).
- **Single-writer preserved**: every mutating endpoint only `CommandBus.send`s and awaits the
  owner fiber's ack within a bounded 5s timeout → **503** if the fiber is wedged. No HTTP
  handler touches the store/registry.
- **DD-8 static serving**: reuses the platform `FileSystem` (no new dep). `serve` middleware
  splits on `request.url`: `/api/*` → the typed app; everything else → SPA index fallback +
  token injection. Path-traversal-safe; serves a graceful 404 hint when `dist/cockpit/` is
  absent (Phase-1 reality — the SPA arrives in Phase 2). Default root resolves to
  `dist/cockpit/` relative to the bundled CLI entry.
Gates: typecheck + lint clean, **355 tests** (339 + 16: 5 cockpit-server, 12 security, −1 net
from the snapshot test split), `pnpm build` green.

### #66 — Settings read/persist + hot-reload (Sage, dep #65)
Files (new): `src/core/workflow/workflow-file.ts` (the `WorkflowFile` service + the
`EditableSettings`/`SettingsPatch` schemas). Modified: `src/core/orchestrator/loop.ts`
(`liveConfig` swap + `ReloadConfig` handler body — patches the two state-seeded knobs +
emits `ConfigReloaded`; the hot knobs `max_turns`/`max_retry_backoff_ms`/`budget`/
`max_concurrent_agents_by_state` now read off `liveConfig`), `observer.ts` (+`ConfigReloaded`
observation), `live-observer.ts`/`recent-events.ts` (render it), `errors.ts` (+`SettingsRejected`),
`domain/workflow.ts` (export `PositiveInt`), `cockpit/api.ts` (+`GET`/`PUT /api/v1/settings`),
`cockpit/handlers.ts` (settings read + PUT→`applyPatch`→`ReloadConfig`), `cockpit/server.ts`
+ `daemon.ts` (thread `workflowPath`, provide `WorkflowFileLive`). Tests: `test/settings.test.ts`
(headline byte-identical secret/body test, read projection, invalid-patch-rejected-before-write,
loop hot-reload), + the two observation-fixture maps.

Decisions:
- **DD-4 edit the RAW document, not a re-stringified object.** The write path uses the `yaml`
  package's `parseDocument` + `setIn`/`deleteIn` on ONLY the whitelisted paths, then
  `toString()`. Untouched nodes — `tracker.api_key` (literal or `$VAR`) and every other key —
  keep their exact original representation. The Liquid body is captured verbatim (the slice
  after the closing `---`) and re-appended unchanged. The headline test asserts the `$VAR`
  api_key line and the body are byte-identical before/after.
- **Secret safety (constraint #4).** The editor never reads the resolved `ServiceConfig` for
  the write or the wire — it operates on the raw front matter. The editable projection
  (`{ polling, agent, budget }`) has no `tracker` key at all, so a secret can't leak to the
  browser. The fully resolved config (with the resolved api_key) is produced only for the
  in-process `ReloadConfig` command (re-loaded from the just-written file) and never serialized.
- **Validate-then-write.** The merged document is decoded against `ServiceConfig` BEFORE the
  write; a patch that would yield an unparseable `WORKFLOW.md` is rejected (`SettingsRejected`)
  with nothing written. Invalid patches (e.g. negative concurrency) fail the `SettingsPatch`
  decode at the HTTP boundary (`PositiveInt`) → 400, before `applyPatch` is even reached.
- **Atomic persist** mirrors the Sprint-4 checkpoint: write a `.orchestra.tmp` sibling (mode
  preserved from the existing file) then `rename(2)` into place.
- **Hot-reload without collateral (DD-4).** The loop reads its hot knobs from a loop-local
  `liveConfig` (the existing latch idiom — only the owner fiber writes it). `ReloadConfig`
  swaps `liveConfig` and patches `OrchestratorState.{poll_interval_ms, max_concurrent_agents}`,
  so the next dispatch tick plans against the new values. It interrupts NOTHING — the loop
  test proves an in-flight worker keeps running while a raised concurrency cap lets a
  previously-withheld issue dispatch on the next tick.
- **Deviation note (DD-4 "ConfigRef").** The plan names a `ConfigRef`; I used a loop-local
  `let liveConfig` instead — it is the same single-writer pattern already used for the
  `operatorPaused`/`budgetPaused` latches in this loop, avoids a cross-fiber `Ref` the HTTP
  fiber could touch, and the owner fiber is the only writer. Functionally identical (a
  point-of-use read swapped atomically by the owner fiber); strictly cleaner here.
Gates: typecheck + lint clean, **359 tests** (355 + 4 settings), `pnpm build` green.

### Review fixes (post-Phase-1 security/concurrency pass)
Three fixes, one commit each, each with a regression test proven to fail without the fix:
- **[HIGH] `handleRetryDue` idempotency** (`loop.ts`): a `RetryNow` racing a fired backoff
  timer could double-dispatch (orphan a worker). Guard: early-return when a worker is already
  running for the issue. Regression in `command-control.test.ts` (gated-observer stall makes
  the interleaving deterministic under `TestClock`).
- **[MEDIUM] concurrent settings writes** (`workflow-file.ts`): `applyPatch` now serialized
  with a `Semaphore(1)` + unique temp suffix → no lost update. Regression in `settings.test.ts`.
- **[LOW] token bootstrap** (`token.ts`): escape `<` → `\u003c` so a `</script>`-bearing
  operator token can't break out of the inline script. Regression in `cockpit-security.test.ts`.
Gates: typecheck + lint clean, **362 tests**, `pnpm build` green.

### #67 — Vite + React cockpit scaffold + serving + dev proxy + API client (Nova, dep #65)
Files (new): `src/cockpit/{index.html,main.tsx,App.tsx,vite-env.d.ts}`,
`src/cockpit/api/{types.ts,client.ts}`, `vite.config.ts`, `tsconfig.cockpit.json`,
`test/cockpit-client.test.ts`. Modified: `package.json` (deps `react-dom`; devDeps `vite`,
`@vitejs/plugin-react`, `@types/react-dom`; scripts `build = tsup && vite build`,
`dev:cockpit = vite`, `typecheck` runs both tsconfigs), `tsconfig.json` (exclude `src/cockpit`).

Decisions:
- **Two TS programs, one `typecheck`.** The Node daemon stays on the root `tsconfig` (node
  types, no DOM); the browser SPA gets `tsconfig.cockpit.json` (DOM lib + JSX, `vite/client`).
  `pnpm typecheck` runs `tsc --noEmit` on both. The root config *excludes* `src/cockpit`, but
  the pure client/model modules are deliberately **DOM-free** so the Node test program can
  import and check them; only the `.tsx` components (reachable solely via `main.tsx`) need DOM.
- **Plain-fetch, DOM-free client.** `createClient({ baseUrl?, token?, fetch? })` uses a
  structural `FetchLike` (not the DOM `fetch` type) so it unit-tests under Node with an
  injected fake. Reads are token-free (DD-5); mutating verbs attach `Authorization: Bearer`
  from the injected `window.__ORCHESTRA_COCKPIT_TOKEN__`. Non-2xx → a typed `ApiError`
  (status + stable `code` + server message); network failure → `ApiError(0, "network")`.
- **Build/serve wiring (DD-8).** `vite build` emits to `dist/cockpit/` (verified: `index.html`
  + `assets/`), exactly where the daemon static handler serves from. `base: "/"` so emitted
  asset URLs resolve against the static root. `dev:cockpit` proxies `/api` to
  `127.0.0.1:${ORCHESTRA_PORT|4317}`; a dev-only Vite plugin re-injects the token from
  `ORCHESTRA_COCKPIT_TOKEN` (parity with the daemon's injection) so mutations work in dev.
- The `App.tsx` is a minimal boot scaffold; the design-system shell + views land in #68–#71.
Gates: typecheck (both configs) + lint clean, **373 tests** (+11 client), `pnpm build` emits
the daemon bundle **and** `dist/cockpit/index.html` + assets.

### #68 — Cockpit design system + app shell (Milo, dep #67)
Files (new): `src/cockpit/design/{tokens.ts,tokens.css}`, `src/cockpit/router.ts`,
`src/cockpit/useRoute.ts`, `src/cockpit/components/{StatusChip.tsx,Panel.tsx,AppShell.tsx}`,
`src/cockpit/app.css`, `test/cockpit-design.test.ts`. Modified: `src/cockpit/App.tsx` (renders
the shell + placeholder views), `src/cockpit/main.tsx` (imports the token + app CSS).

Decisions:
- **One status vocabulary, reused — not duplicated.** `design/tokens.ts` imports `Status`,
  `ColorToken`, `STATUS_STYLES`, `PHASE_TO_STATUS`, `phaseStatus` straight from
  `core/observability/glyphs.ts` (the single source of truth shared with the CLI). `glyphs.ts`
  is pure and its only import is an `import type`, so the bundler erases it — no Effect/Schema
  reaches the browser. The web layer adds **only** the binding each semantic color token → a CSS
  custom property (`COLOR_TOKEN_VAR`). `tokens.css` renders those five tokens (info=cyan,
  warn=yellow, muted=gray, success=green, danger=red), parity pinned by `cockpit-design.test.ts`.
- **Accessibility posture mirrors the CLI's NO_COLOR / --ascii spirit.** `StatusChip` always
  renders glyph **and** label (color is never the only signal); `tokens.css` drops all motion
  under `prefers-reduced-motion: reduce` and reinforces borders/contrast under
  `prefers-contrast: more`.
- **Tiny hash router, no react-router.** `router.ts` is pure (`parseRoute`/`routeHref`/`ROUTES`,
  Node-testable); `useRoute.ts` holds the DOM binding (`hashchange`). Four nav targets
  (Fleet · Kanban · Events · Settings) map 1:1 to the four views; Fleet is the default.
- **Shared primitives reused by #69–#71.** `StatusChip` (status glyph+label chip), `Panel`
  (titled card; omitted when its additive data is absent), `AppShell` (presentational nav frame;
  route state owned above in `App`). Views are placeholders until #69/#70/#71 replace them.
Gates: typecheck (both configs) + lint clean (`!important` reduced-motion reset suppressed with
justified `biome-ignore`), **381 tests** (+8 design/router), `pnpm build` emits the SPA with the
bundled CSS (`dist/cockpit/assets/index-*.css`).
### #69 — Fleet / session-overview + Events views (Nova, dep #67/#68)
Files (new): `src/cockpit/model/{format.ts,fleet.ts,events.ts,poller.ts}`,
`src/cockpit/usePolling.ts`, `src/cockpit/api/instance.ts`,
`src/cockpit/components/ConnectionBanner.tsx`, `src/cockpit/views/{FleetView.tsx,EventsView.tsx}`,
`test/{cockpit-fleet.test.ts,cockpit-events.test.ts,cockpit-poller.test.ts}`. Modified:
`src/cockpit/App.tsx` (routes Fleet/Events to the real views), `src/cockpit/app.css` (view styles).

Decisions:
- **All derivation is pure + unit-tested; the views are dumb.** `toFleetView` and `toEventsView`
  map a `SnapshotWire` + a client `now` into render-ready models, reusing the Ink dashboard's
  honesty rules: client-side elapsed from `started_at`, an explicit `—` sentinel for unparseable
  timestamps (never a fake "0s"), an honest "unknown" badge for a contract-drifted run phase
  (never masquerading as active "running"), and a defensive opaque rate-limit summary that never
  assumes a vendor schema. Status glyphs/colors come from the one `glyphs.ts` source.
- **Non-overlapping poll, last-good-on-error — and that logic is itself tested.** Rather than bury
  the scheduling in a hook, the generic DOM-free `Poller` class (web parity of the Ink poller)
  holds the guarantees (no overlap; a failed poll keeps the last-good value and flips
  live→stale; stays `connecting` until the first success; clean teardown) and is unit-tested with
  fake timers + an injected fetcher. `usePolling` is a thin React adapter over it.
- **Additive contract honored.** budget/restore/rate-limits/control panels are omitted when the
  daemon doesn't send the block; the new `control` banner (#64) distinguishes operator vs budget
  pause and states plainly that in-flight work continues.
- **Events feed.** `recent_events` rides the wire newest-last (append-only ring); `toEventsView`
  reverses to newest-first and precomputes per-kind glyph/color. `filterEvents` (pure) filters by
  level, kind, and free text over message+identifier. The view owns only the filter UI state.
Gates: typecheck (both configs) + lint clean, **403 tests** (+22: fleet/events/poller), `pnpm
build` emits `dist/cockpit/index.html` + assets.
