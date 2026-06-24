# Sprint 6 — Done (The Web Cockpit)

Handoff for the Producer. See `plan.md` for the original scope + locked Design Decisions
(DD-1..DD-8), `progress.md` for the phase-by-phase log.

## Summary

Sprint 6 promotes the read-only Ink TUI into a **complete web cockpit**: a Vite+React SPA
**served by the daemon** on `--port`, backed by a typed `@effect/platform` `HttpApi` with a
real control plane. The daemon becomes operable from a browser — fleet/session overview,
events feed, an actionable Kanban board, and live-edit + persist of the operationally-safe
`WORKFLOW.md` settings — without ever weakening the single-writer, exactly-once core. The
forward-only mandate held throughout: the hand-rolled snapshot router was **replaced**
outright (no `/api/v2`, no dual routers), and the close-out **deleted** the Ink dashboard
entirely rather than deprecating it.

- **Closed this sprint:** #64, #65, #66, #67, #68, #69, #70, #71, #72.

## What shipped

| # | Issue | Outcome |
|---|-------|---------|
| #64 | Command channel + operator control commands | New `CommandBus` (`src/core/orchestrator/command.ts`: `Queue<{ command; reply: Deferred<CommandResult> }>`) + a `Msg.Command` mailbox variant + a boot-forked pump fiber draining the bus into the **same serial mailbox** the owner fiber already consumes. Serial command handler: `PauseDispatch`/`ResumeDispatch` (a loop-local `operatorPaused` latch mirrored into a tiny set-once-style `ControlStatus` service, single-writer like `RestoreStatus`); the dispatch gate becomes `(budget.paused \|\| operatorPaused) ? [] : planDispatch(...)`; additive `control: { dispatch_paused, paused_by }` snapshot block. `RetryNow(issueId)` re-arms a backing-off issue; `CancelSession(issueId)` interrupts **only** that worker fiber. Exactly-once stays structural; deterministic under `TestClock`. (`5c2227c`) |
| #65 | Cockpit `HttpApi` server | Replaced `snapshot-server.ts` with `src/core/cockpit/` (`api`/`auth`/`handlers`/`security`/`server`/`static`/`token`). Read `GET /api/v1/state` re-served **byte-compatibly** from the pure `snapshot.ts` projection (a round-trip test pins the wire bytes); mutating endpoints (`POST /control/{pause,resume}`, `POST /issues/:id/{retry,cancel}`, `PUT /settings`) each wired to the `CommandBus`, returning only after the owner fiber acks (bounded timeout → 503). Auth middleware (DD-5): bearer token (`ORCHESTRA_COCKPIT_TOKEN` or CSPRNG hex, logged once at INFO) + loopback `Origin`/`Host` allowlist on mutating endpoints; read stays token-free; 401 missing token, 403 cross-origin. Static serving of `dist/cockpit/` with SPA `index.html` fallback + token injection (graceful when the dir is absent). `runSnapshotServer`→`runCockpit`; `daemon.ts` rewired. (`309b99d`) |
| #66 | Settings read/persist + hot-reload | `WorkflowFile` service (`src/core/workflow/workflow-file.ts`): `GET /api/v1/settings` returns the whitelisted, **secret-free** subset of the RAW front-matter; `PUT` validates a typed patch, applies to **only** the whitelisted RAW keys, re-serializes with the Liquid body **verbatim**, writes **atomically** (temp+rename), then issues `ReloadConfig` (`ConfigRef` swap + `OrchestratorState` knob patch) so the safe knobs hot-apply next tick **without killing in-flight work**. Headline test: `tracker.api_key` + the Liquid body are **byte-identical** before/after a write; an invalid patch is rejected **before** the write lands. (`84d6e10`) |
| #67 | Vite+React+TS scaffold + serving + build + API client | `src/cockpit/` app; `vite build` → `dist/cockpit/`; `pnpm build` runs tsup **and** vite; `pnpm dev:cockpit` = Vite dev server with `/api` proxy to the daemon. A plain-`fetch` typed API client (no Effect in the browser) reading the bearer token from `window.__ORCHESTRA_COCKPIT_TOKEN__` and attaching it to mutating calls; typed errors. Pure mappers live in vitest-tested `model/*` modules (no jsdom). Dedicated `tsconfig.cockpit.json` (DOM+JSX) wired into `pnpm typecheck`; Biome covers `src/cockpit/`. (`522bfeb`) |
| #68 | Cockpit design system + app shell | Web CSS-token parity with `glyphs.ts`/`docs/design-system.md` (the five worker statuses, level colors, glyphs — one source of truth in `design/tokens.{ts,css}`); nav shell (Fleet · Kanban · Events · Settings) + shared status-chip/panel primitives reused by #69/#70/#71; reduced-motion/high-contrast posture mirroring the CLI's `--ascii`/`NO_COLOR` spirit. (`a82200a`) |
| #69 | Fleet/Session overview + Events views | Fleet: live running sessions (elapsed/status/workspace/attempt + humanized last-activity), totals, budget, restore, rate-limits, and the new `control` banner — non-overlapping poll of `GET /api/v1/state`, last-good-on-error (like the Ink poller). Events: the `recent_events` feed, newest-first, filterable. Absent field → panel omitted (additive contract). (`aebabb4`) |
| #70 | Kanban board with actionable cards | Columns Candidate/Claimed → Running → Retrying → Completed via a **pure, unit-tested** derivation over the snapshot; Cancel (running) / Retry-now (retrying) **buttons** calling the authorized POSTs and reflecting the `CommandResult`, reverting on error; no drag. (`b6f4131`) |
| #71 | Settings view + global pause/resume | Form over the whitelisted settings (`GET/PUT /api/v1/settings`) with client-side validation mirroring the schema; a prominent Pause/Resume dispatch toggle on the control endpoints reflecting live `control.dispatch_paused`/`paused_by`; never renders or requests a secret (no `tracker` key in the payload or DOM). (`ed0324a`) |
| #72 | Remove Ink dashboard + finalize docs | Deleted `src/cli/dashboard.tsx`, `src/cli/dashboard/`, and `test/dashboard/`; reduced `main.ts` to a single daemon entry; purged `ink`/`ink-testing-library`/`react-devtools-core` + the `dev:dashboard` script. Re-pointed the surviving cross-feature decode test from the deleted Ink `parseSnapshot`/`toViewModel` to the cockpit's `toFleetView`. README + `PROJECT_BRIEF.md` §5/§7/§8 + this handoff. (this commit) |

## Architecture (so a future sprint doesn't regress it)

- **Single state-owning fiber stays the only writer (DD-2).** No HTTP handler ever touches
  `OrchestratorStore`/the worker registry. Every mutation is a `Command` placed on the
  `CommandBus` (`Queue` + per-command `Deferred` ack); a boot-forked pump drains it into the
  **same serial mailbox** (`Msg.Command`) the owner fiber already consumes, so command
  handling is serialized with ticks and worker callbacks — exactly-once stays **structural**,
  not coordinated. HTTP handlers `await` the `Deferred` (bounded → 503), they never share a
  mutable `Ref` with the loop.
- **Operator-pause is a dispatch gate, not a kill (DD-3).** It mirrors the budget gate exactly
  (`(budget.paused || operatorPaused) ? [] : planDispatch(...)`) — it withholds **new**
  dispatch only. In-flight workers, retries, and reconcile are untouched. Only an explicit
  `CancelSession` interrupts a worker, and only the one it names. The `control` snapshot block
  is strictly additive.
- **`HttpApi` replaced the hand-rolled router (DD-1), read stays byte-compatible.** `snapshot-server.ts`
  is gone; the read endpoint serializes the pure `snapshot.ts` projection and a round-trip
  test pins the wire bytes. No `/api/v2`, no compat shim.
- **Settings persistence is secret-safe + atomic + surgical + hot-reloading (DD-4, #73).** The
  write operates on the **raw** front-matter re-read from disk (never the resolved `ServiceConfig`),
  edits only the whitelisted keys, and writes via a **`Semaphore(1)`-serialized** temp+rename
  (concurrent PUTs can't lose an update). The edit is **surgical**: the dominant case — changing a
  scalar value on an already-present key — rewrites just that scalar's CST source token
  (`CST.setScalarValue`) and re-emits the tree (`CST.stringify`), so the result is **byte-verbatim**
  except the edited value (trailing-comment alignment, flow-vs-block style, key order, blank lines,
  and every untouched line preserved exactly). The rarer **structural** edits (clearing a ceiling →
  key delete, setting the `max_concurrent_agents_by_state` map, or introducing an absent whitelisted
  key) fall back to a Document re-serialize with `flowCollectionPadding:false` (flow arrays keep
  `[a, b]`, no `[ a, b ]` padding) and prune a now-empty parent block — **best-effort**: comment
  alignment on untouched lines may normalize. In every case the Liquid body, `$VAR`, and
  `tracker.api_key` stay byte-identical and never reach the wire or the disk-write path.
  `ReloadConfig` swaps a `ConfigRef` + patches the live state knobs on the next tick.
- **Security (DD-5).** Loopback bind; read endpoints token-free; mutating endpoints require both an
  `Authorization: Bearer <token>` and a loopback `Origin`/`Host` (401 / 403). Token from
  `ORCHESTRA_COCKPIT_TOKEN` else CSPRNG hex logged once at INFO; injected same-origin into the SPA
  HTML as `window.__ORCHESTRA_COCKPIT_TOKEN__` (escaped against `</script>`).
- **SPA (DD-8).** Plain `fetch` + pure `model/*` mappers — no Effect, no DOM in the browser test
  path. Four views over a non-overlapping 2 s poll with last-good-on-error. `vite build` →
  `dist/cockpit/`, served statically by the `HttpApi` with an `index.html` fallback.

## Security / secret-safety tests added

- **Cockpit auth matrix** (`test/cockpit-server.test.ts`): 401 (no token), 403 (good token,
  cross-origin), 200 (loopback + token) on a mutating endpoint; the control command flows over the
  `CommandBus` and returns the wire `CommandResult`; graceful 404 when the SPA isn't built.
- **Read-wire byte-compatibility**: a round-trip test pins `GET /api/v1/state` bytes against the
  pure projection.
- **Settings secret-safety + surgical edit** (`test/settings.test.ts` / `workflow-file`):
  `tracker.api_key` + the Liquid body are byte-identical across a write; an invalid patch is
  rejected **before** the write lands; overlapping PUTs both land correctly (the `Semaphore(1)`
  prevents the lost update); a scalar PUT on an existing key (`max_turns`) leaves the whole file
  **byte-verbatim except the edited value** — aligned trailing comments and a flow-style array on
  untouched keys preserved exactly (#73); the budget-clear delete prunes the empty block and keeps
  flow arrays compact.
- **Token bootstrap injection** (`test/cockpit/token`): a `</script>`-bearing token is escaped
  (`\u003c`) so it can't break out of the inline `<script>`.
- **Command-control loop** (`test/command-control.test.ts`): operator-pause withholds new dispatch
  while in-flight work continues; cancel is scoped to one fiber; the `RetryNow`↔firing-backoff race
  dispatches **exactly one** worker (the Phase-1 review regression).

## Breaking changes

- **The Ink dashboard is removed.** `src/cli/dashboard.tsx`, `src/cli/dashboard/`, and the
  `orchestra dashboard` subcommand are deleted. `orchestra` is now a single daemon CLI; the web
  cockpit (served on `--port`) is the operator surface. Deps `ink`, `ink-testing-library`,
  `react-devtools-core` removed.
- **`snapshot-server.ts` is gone**, replaced by the pure `src/core/observability/snapshot.ts`
  projection served by the cockpit `HttpApi`. The read endpoint's wire bytes are unchanged.

## Deps added / removed

- **Added:** `react-dom` (runtime); `vite`, `@vitejs/plugin-react`, `@types/react-dom` (dev).
  (`react` was already present.)
- **Removed:** `ink`, `react-devtools-core` (runtime); `ink-testing-library` (dev). Verified gone
  from `pnpm-lock.yaml` and from every `import` in `src`/`test`.

## How to run

```bash
pnpm dev ./WORKFLOW.md --port 4317   # daemon + cockpit on http://127.0.0.1:4317
open http://127.0.0.1:4317/           # the web cockpit
pnpm dev:cockpit                      # Vite dev server for UI work (/api proxied to the daemon)

pnpm build                            # tsup → dist/cli/main.js ; vite → dist/cockpit/
node dist/cli/main.js ./WORKFLOW.md --port 4317
```

The mutating endpoints need `Authorization: Bearer <token>` + a loopback `Origin`/`Host`; the
token is `ORCHESTRA_COCKPIT_TOKEN` if set, else a CSPRNG hex token logged once at INFO at boot.

## Accepted limitations (known / intentional — not bugs)

1. **Kanban "Claimed" column is count-only.** The snapshot wire emits `counts.claimed` but not the
   claimed issue IDs (Orchestra reads the tracker; candidate cards live there). Real Claimed cards
   would need an additive backend change — out of scope for Sprint 6.
2. **UI poll cadence is fixed at 2 s** (`COCKPIT_POLL_MS`). No user-configurable interval this
   sprint.
3. **Pure-module unit coverage only.** Per the dependency budget there is **no** jsdom/DOM test
   stack (`@testing-library`/`jsdom`); the React components are exercised indirectly via their pure
   `model/*` mappers and a live e2e smoke, not a rendered-DOM unit suite.

## Gates at close-out

- `pnpm typecheck` (root + `tsconfig.cockpit.json`) — clean.
- `pnpm lint` (Biome over 144 files incl. `src/cockpit/`) — clean.
- `pnpm test` — **349 passing** (347 at the #72 close-out + 2 new #73 byte-verbatim regressions;
  was 423 at Phase-2 end before the `test/dashboard/` Ink suite was deleted with the dashboard; the
  cross-feature decode test was re-pointed to `toFleetView` and is retained).
- `pnpm build` — tsup emits `dist/cli/main.js`; vite emits `dist/cockpit/index.html` + hashed
  `assets/`.

## Carry-forwards (deferred beyond Sprint 6)

- A live-Copilot session-resume validation (`persistence.resume_sessions` is default-off,
  fake-tested only).
- The optional USD budget ceiling (`max_cost_usd` + `usd_per_million_tokens`).
- The PR-creation / GitHub status write-back flow.
- A general WORKFLOW.md file-watcher for out-of-band edits (the cockpit covers the whitelisted
  safe-knob subset).
