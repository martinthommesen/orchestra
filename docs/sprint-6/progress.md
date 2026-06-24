# Sprint 6 — Progress

Live tracker. Theme: **The Web Cockpit** (a daemon-served browser UI with **full control** —
fleet/session overview + kanban + events + live-edit/persist of `WORKFLOW.md` settings).
Branch: `feature/sprint-6` (off `main`, all Sprint 5 work merged).

## Board

| # | Task | Owner | Effort · Risk | Status |
|---|------|-------|---------------|--------|
| #64 | Command channel (`CommandBus` + mailbox `Msg.Command`) + operator pause/resume/retry-now/cancel | Sage | M · Med | ✅ done |
| #65 | Cockpit `HttpApi` server (read + mutating endpoints, auth/Origin, static SPA; replaces snapshot router) | Sage | M · Med | ✅ done |
| #66 | Settings: read editable subset + persist whitelisted patch to `WORKFLOW.md` + hot-reload | Sage | M · Med | ☐ todo |
| #67 | Vite+React cockpit scaffold, daemon static serving, dev proxy, token bootstrap, build wiring, API client | Nova | M · Low | ☐ todo |
| #68 | Cockpit design system + app shell (web parity of `glyphs.ts`/`design-system.md`) | Milo | S–M · Low | ☐ todo |
| #69 | Fleet / Session overview + Events feed views | Nova | M · Low | ☐ todo |
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
- [ ] #66 — `WorkflowFile` service: read raw front-matter, editable-subset projection
- [ ] #66 — `PUT` validate → patch whitelist → atomic write (body + `$VAR` verbatim)
- [ ] #66 — `ReloadConfig` command (`ConfigRef` swap + state knob patch), hot-apply on next tick
- [ ] #66 — secret-safety test: `api_key` + Liquid body byte-identical across a write

### Phase 2 — Frontend SPA (Nova + Milo)
- [ ] #67 — `src/cockpit/` Vite+React+TS scaffold + `vite.config.ts` (build/proxy)
- [ ] #67 — typed plain-`fetch` API client (token from injected bootstrap)
- [ ] #67 — `pnpm build` runs `tsup` + `vite build`; biome covers `src/cockpit/`
- [ ] #68 — web design tokens (status colors/glyph parity) + nav shell + shared primitives
- [ ] #69 — Fleet/Session overview view (non-overlapping poll, last-good-on-error)
- [ ] #69 — Events feed view (newest-first, filterable)
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

_(per-task notes land here as work completes — files changed, decisions, gate results.)_
