# Sprint 6 — The Web Cockpit

Five sprints in, Orchestra is a durable, legible daemon — but every operator surface is
**read-only** (logfmt logs, the loopback `GET /api/v1/state` snapshot, the Ink dashboard).
Sprint 6 promotes the long-deferred _"web dashboard"_ and the parked _"fleet view"_ ideas
(`docs/ideas-backlog.md`) into a **complete Web Cockpit**: a browser UI **served by the
daemon** that gives an operator **full control** — kanban, session overview, an events
feed, and **live-edit + persist** of `WORKFLOW.md` settings.

> This plan stands in for a formal consilium: the **Design Decisions** section below argues
> the open tradeoffs and picks one coherent design. The four LOCKED user decisions (web
> cockpit served by the daemon · full control · Vite+React+TS SPA on `@effect/platform`
> `HttpApi` · `feature/sprint-6`) are taken as given and are not relitigated.

## Goal

Ship a browser cockpit, served by the daemon on `--port`, that lets an operator **run the
fleet**: watch every Copilot session live, work a kanban board of issues, read the events
feed, **take daemon actions** (pause/resume dispatch, retry-an-issue-now, cancel a running
session), and **live-edit + persist** the operationally-safe `WORKFLOW.md` settings — all
without violating the single-state-owning-fiber / structural-exactly-once invariants and
**without ever writing a resolved `$VAR` secret back to disk**.

## Non-goals (explicitly out of scope this sprint)

- **No remote/multi-user access.** The cockpit stays **loopback-only** (`127.0.0.1`). No
  TLS, no accounts, no RBAC — it is a local operator tool (security posture below).
- **No tracker writes from the cockpit.** Orchestra remains a tracker _reader_; the agent
  writes issue state. Kanban cards are actionable on **Orchestra's** dispatch/session
  state (retry/cancel), never by dragging issues between tracker states.
- **No editing of structural config** (tracker `repo`/`api_key`/`endpoint`, workspace
  `root`, hook scripts, the Liquid body). Only the operationally-safe, hot-applicable
  knobs are editable (Settings whitelist below). Everything else still requires a restart.
- **No new persistence of cockpit/runtime state.** Operator-pause is runtime-only (a
  restart resumes dispatch); the events feed stays a bounded ring, not a forensic log.
- **No live-Copilot resume validation, no USD budget ceiling, no PR write-back** — those
  Sprint-5 carry-forwards stay deferred.

## Constraints (carried forward + new)

1. **The single state-owning fiber stays the only writer.** Every mutating request becomes
   a message on the **same serial mailbox** the owner fiber already drains. No HTTP handler
   ever touches `OrchestratorStore` or the registry. Exactly-once stays **structural**.
2. **In-flight work is never collateral.** Operator-pause withholds _new_ dispatch only
   (exactly like the budget gate). Only an explicit per-issue **cancel** interrupts a
   worker — and only the one it names.
3. **The read snapshot stays backward-additive.** `GET /api/v1/state` keeps its exact wire
   shape; new fields are additive (a `control` block appears only when relevant). The
   _server implementation_ is rebuilt on `HttpApi` (forward-only — see DD-1), but the bytes
   a reader sees do not regress.
4. **Secrets never reach the wire or the disk-write path.** Settings editing operates on
   the **raw** front-matter map (re-read from disk), never the resolved `ServiceConfig`, so
   a resolved `$VAR` (e.g. `tracker.api_key`) can never be serialized back. No secret is
   ever sent to the browser.
5. **Forward-only.** No `/api/v2`, no dual UIs, no compat shims. The Ink dashboard is
   **removed** (DD-6); the hand-rolled snapshot router is **replaced** (DD-1).

## Design Decisions

### DD-1 — Backend: one typed `HttpApi`, and `/api/v1/state` is reorganized into it

The hand-rolled `HttpRouter` in `snapshot-server.ts` is **replaced** by a single
`@effect/platform` `HttpApi` (`CockpitApi`) that exposes the read snapshot **and** the
mutating endpoints as typed endpoint groups. Under the forward-only mandate we do **not**
keep a parallel hand-rolled router "for the dashboard" — one server, one API, derived
types. The read endpoint keeps its path (`GET /api/v1/state`) and its **byte-compatible**
wire shape (the additive tradition continues), but it is now one `HttpApiEndpoint`. No
`/api/v2`. _Rejected: keeping the old router and bolting a second control router beside it —
that is exactly the "dual API just in case" the mandate forbids._

### DD-2 — Command channel: an Effect `Queue` `CommandBus` + per-command `Deferred` ack

A new `CommandBus` context service wraps a `Queue<EnqueuedCommand>` where
`EnqueuedCommand = { command: Command; reply: Deferred<CommandResult> }`. At boot the loop
forks one tiny pump fiber that drains the `CommandBus` and offers a **new mailbox `Msg`** —
`{ _tag: "Command"; command; reply }` — so commands flow through the **same single-consumer
mailbox** the owner fiber already drains (Tick / AgentEvent / WorkerDone / RetryDue). The
owner fiber applies the command **serially**, in the same place it applies every other
message, then completes the `Deferred` with a `CommandResult`. The HTTP handler only
`Queue.offer`s and awaits the `Deferred` (with a timeout). This is the cleanest fit for the
existing invariants: no shared mutable state, commands are just more serially-applied
messages, and the whole thing stays deterministic under `TestClock`. _Rejected: a second
`Ref`/`SubscriptionRef` the HTTP fiber writes — that reintroduces cross-fiber shared mutable
state the architecture deliberately bans._

`Command` (this sprint): `PauseDispatch` · `ResumeDispatch` · `RetryNow(issueId)` ·
`CancelSession(issueId)` · `ReloadConfig(rawPatch)`.

### DD-3 — Operator-pause is a runtime gate, additive on the snapshot

Operator pause is a **new, distinct** concept from the budget pause. The loop gains a
runtime `operatorPaused` latch; the dispatch gate becomes
`toDispatch = (budget.paused || operatorPaused) ? [] : planDispatch(...)` — the same shape
as the Sprint-5 budget gate, touching nothing else. It is **runtime-only** (not persisted;
a restart resumes dispatch) and surfaces as an additive `control: { dispatch_paused,
paused_by }` block on the snapshot so the cockpit (and the events feed) can show _why_
dispatch is idle (`operator` vs `budget`).

### DD-4 — Settings: edit a whitelisted subset of the **raw** front-matter, atomic write,

hot-reload the safe knobs
A new `WorkflowFile` service reads the **raw** `WORKFLOW.md`, parses the front matter as a
YAML map (preserving the Liquid body verbatim), exposes a **whitelisted editable subset**,
applies a typed patch to **only those keys**, re-serializes `front-matter + unchanged body`,
and writes it back **atomically** (temp + `rename`, mirroring the Sprint-4 checkpoint
discipline). The whitelist — the only keys the cockpit may read or write — is exactly the
hot-applicable orchestration knobs:

| Key                                    | Why it is safe to edit + hot-apply                   |
| -------------------------------------- | ---------------------------------------------------- |
| `polling.interval_ms`                  | next sleep reads it; no in-flight effect             |
| `agent.max_concurrent_agents`          | read by the dispatch planner each tick               |
| `agent.max_concurrent_agents_by_state` | read by the dispatch planner each tick               |
| `agent.max_turns`                      | gates continuation scheduling on the next completion |
| `agent.max_retry_backoff_ms`           | applied to the next backoff computation              |
| `budget.max_total_tokens`              | the pure budget gate re-evaluates it each tick       |

**Secret safety (constraint #4).** The editor operates on the **raw** front-matter map, so
`tracker.api_key` (a literal or a `$VAR`) is **outside the whitelist and never touched** —
the resolved secret value (which lives only in the in-memory `ServiceConfig`) is never read
from, sent to the browser, or written to disk. The write path preserves every untouched key
verbatim, including any `$VAR` indirection.

**Hot-reload, without disrupting in-flight work.** A successful `PUT` issues a
`ReloadConfig(rawPatch)` command. The loop reads its config from a `ConfigRef` (not a
closed-over const); the command handler updates the `ConfigRef` **and** patches the matching
`OrchestratorState` fields (`poll_interval_ms`, `max_concurrent_agents`) so the next tick
plans against the new knobs. It **kills nothing** — only future-tick decisions change. If
re-parsing the patched file fails schema validation, the write is rejected before it lands
(validate-then-write) and the `CommandResult` carries the typed error.

### DD-5 — Security: loopback bind + per-session bearer token + Origin allowlist

The server stays bound to `127.0.0.1`. **Read** (`GET /api/v1/state`) stays token-free
(loopback, read-only — keeps the bytes contract simple). **Every mutating endpoint** (`POST`/`PUT`)
requires `Authorization: Bearer <token>` **and** an `Origin`/`Host` allowlist check
(loopback only). The token is a **per-process session secret**: read from
`ORCHESTRA_COCKPIT_TOKEN` if set, else generated at startup (CSPRNG) and logged once. The
daemon serves the SPA same-origin and **injects the token into the served `index.html`** (a
`window.__ORCHESTRA_COCKPIT_TOKEN__` bootstrap) so the SPA can read it without a network
round-trip. CSRF posture: a cross-origin browser tab cannot read the token (same-origin
policy) and cannot set a custom `Authorization` header on a "simple" request without a CORS
preflight the server rejects (it allows same-origin only). So the mutating API is **not
trivially CSRF-able** from a random tab, which is the bar for a local operator tool.
_Rejected: cookie-session auth (cookies are auto-sent cross-site → the CSRF footgun we are
avoiding)._

### DD-6 — The Ink dashboard is **removed**

The web cockpit is a strict superset of the Ink dashboard's read view, plus control.
Keeping two read UIs is exactly the debt the forward-only mandate says to delete. Once the
cockpit's read views land and pass QA, the close-out task **deletes** `src/cli/dashboard/`,
`src/cli/dashboard.tsx`, the `orchestra dashboard` subcommand, and the Ink-only deps
(`ink`, `ink-testing-library`, `react-devtools-core`). React stays — the SPA uses it.
_Rejected: keeping the Ink dashboard "for headless/SSH operators" — that is a real but
separate need; if it returns it should be a thin cockpit-API client, not preserved legacy._

### DD-7 — Kanban: columns mapped from state; cards actioned by **buttons**, not drag

Columns: **Candidate/Claimed → Running → Retrying → Completed**, derived from the snapshot
(`claimed`, `running`, `retrying`, `completed`) joined with each card's tracker identifier.
Cards are **actionable via explicit buttons** — _Cancel_ on a running card, _Retry now_ on
a retrying card. **Drag is deliberately disallowed**: dragging a card between columns would
imply Orchestra moves tracker state, but Orchestra is a _reader_ (the agent writes state).
Buttons keep the actions honest about what Orchestra actually owns.

### DD-8 — Serving: Vite build → static assets served by `@effect/platform`; dev = proxy

The SPA lives in `src/cockpit/`. `vite build` → `dist/cockpit/`. The daemon's `HttpApi`
serves `dist/cockpit/` as static assets (existing `@effect/platform`/`-node`
`HttpServer`/`FileSystem` — **no new runtime dep**) at `/`, with the SPA fallback to
`index.html`. Dev: `pnpm dev:cockpit` runs the Vite dev server (HMR) proxying `/api` → the
running daemon's `--port`. Prod: `pnpm build` runs **both** `tsup` (daemon) and `vite build`
(SPA), so `dist/` ships both; the daemon locates `dist/cockpit/` relative to its own module
URL. `--port` now serves the **whole cockpit** (SPA + read + control) — there is no separate
flag.

## Tasks

> Owners are among **Nova** (frontend/runtime), **Sage** (backend/orchestrator), **Milo**
> (art/CLI/design-system). Acceptance criteria are concrete; each task is one coherent,
> commit-per-task unit. Issue numbers are filed on `martinthommesen/orchestra` (see
> "Issues" at the bottom — provisional **#64–#72** pending `gh` filing).

### Phase 1 — Backend control plane (Sage)

- **#64 — Command channel + operator control commands.** _Owner: Sage · Effort M · Risk Med
  (touches the loop assembly, but additively)._
  New `CommandBus` service (`Queue<EnqueuedCommand>`), a `Msg.Command` mailbox variant, and
  a boot-forked pump fiber draining the bus into the mailbox (DD-2). The owner fiber gains a
  serial command handler implementing `PauseDispatch`/`ResumeDispatch` (DD-3 `operatorPaused`
  latch + additive `control` snapshot block), `RetryNow(issueId)` (fire a pending retry now
  / re-dispatch an eligible issue), and `CancelSession(issueId)` (interrupt **only** that
  worker fiber, `release` the issue + drop its registry entry, emit an observation). Each
  command completes its `Deferred<CommandResult>`.
  **AC:** the dispatch gate is `(budget.paused || operatorPaused) ? [] : planDispatch(...)`;
  a `PauseDispatch` withholds new dispatch while in-flight workers, retries, and reconcile
  are provably untouched (a loop test mirrors `budget-gate.test.ts`); `CancelSession`
  interrupts the named worker and **no** other; `RetryNow` re-dispatches an eligible issue
  and is a no-op (typed `CommandResult`) for an unknown/ineligible id; commands apply
  serially through the existing mailbox (deterministic under `TestClock`); a new `control`
  block (`dispatch_paused`, `paused_by: "operator" | "budget" | null`) is additive on the
  snapshot; new observations render in the feed + logfmt; all gates green.

- **#65 — Cockpit `HttpApi` server (read + mutating endpoints).** _Owner: Sage · Effort M ·
  Risk Med · dep: #64._
  Replace the hand-rolled `snapshot-server.ts` router with a typed `HttpApi` `CockpitApi`
  (DD-1): `GET /api/v1/state` (byte-compatible wire shape) + the mutating endpoints (API
  surface below), each wired to the `CommandBus` and awaiting its ack. Add the auth/Origin
  middleware (DD-5): bearer-token + loopback-Origin required on mutating endpoints, read
  stays token-free. Serve `dist/cockpit/` static assets with SPA fallback + token injection
  into `index.html` (DD-8). `runSnapshotServer(port, budget)` becomes `runCockpit(port,
…)`; `daemon.ts` wiring updated.
  **AC:** `GET /api/v1/state` returns the same shape Sprint-5 readers expect (a wire
  round-trip test pins it); every mutating endpoint rejects a missing/blank token (401) and
  a cross-origin `Origin` (403); a valid command returns its `CommandResult`; the SPA index
  is served with the token bootstrap injected; a bind failure logs + idles (never crashes
  orchestration, as today); all gates green.

- **#66 — Settings: read editable subset + persist patch + hot-reload.** _Owner: Sage ·
  Effort M · Risk Med · dep: #65._
  New `WorkflowFile` service (DD-4): `GET /api/v1/settings` returns the whitelisted editable
  subset (raw values, secrets excluded); `PUT /api/v1/settings` validates a typed patch,
  applies it to **only** the whitelisted keys of the **raw** front-matter map, re-serializes
  with the Liquid body verbatim, writes **atomically** (temp + `rename`), then issues a
  `ReloadConfig` command (`ConfigRef` swap + `OrchestratorState` knob patch).
  **AC:** a `PUT` round-trips through disk and the new knobs take effect on the **next** tick
  without killing in-flight work (loop test); `tracker.api_key` and the Liquid body are
  **byte-identical** before/after a write (the secret-safety + body-preservation test is the
  headline); an invalid patch (e.g. negative concurrency) is rejected **before** the write
  lands and returns a typed error; a `$VAR` in an untouched key survives verbatim; all gates
  green.

### Phase 2 — Frontend SPA (Nova + Milo)

- **#67 — Vite + React cockpit scaffold, serving, dev proxy, build wiring, API client.**
  _Owner: Nova · Effort M · Risk Low · dep: #65._
  `src/cockpit/` Vite+React+TS app; `vite.config.ts` (build → `dist/cockpit/`, dev `/api`
  proxy); a **plain-`fetch`** typed API client (no Effect in the browser) reading the
  injected bearer token; `pnpm build` runs `tsup` **and** `vite build`; biome covers
  `src/cockpit/`; the app shell + client mappers are pure, vitest-tested modules.
  **AC:** `pnpm build` produces `dist/cockpit/index.html` + assets and a daemon bundle;
  `pnpm dev:cockpit` serves with HMR and proxies the API; the API client attaches the bearer
  token to mutating calls and surfaces typed errors; pure mappers (wire → view-model, column
  derivation) are unit-tested; all gates green.

- **#68 — Cockpit design system + app shell (web parity of `glyphs.ts`/`design-system.md`).**
  _Owner: Milo · Effort S–M · Risk Low · dep: #67._
  Translate the status design system (the five worker statuses, level colors, glyphs) to web
  CSS tokens; build the nav shell (Fleet · Kanban · Events · Settings) and shared status
  chip / panel primitives the views consume. Honor a reduced-motion / high-contrast posture
  consistent with the CLI's `--ascii`/`NO_COLOR` spirit.
  **AC:** one source of truth for status color + glyph parity with `design-system.md`; the
  shell renders all four nav targets; primitives are reused by #69/#70/#71 (no per-view
  re-styling); pure token/format helpers are unit-tested; all gates green.

- **#69 — Fleet / Session overview + Events feed views.** _Owner: Nova · Effort M · Risk Low
  · dep: #67, #68._
  The **Fleet** view (default): live running sessions with elapsed/status/workspace/attempt
  - humanized last-activity, totals, budget, restore, rate-limits — the dashboard's content,
    richer, polling `GET /api/v1/state` (non-overlapping, last-good-on-error, like the Ink
    poller). The **Events** view: the `recent_events` feed, newest-first, glyph+level styled,
    filterable by kind/level.
    **AC:** the fleet renders every snapshot block honestly (absent field → panel omitted,
    matching the additive contract); polling never overlaps and shows stale-with-data on a
    failed poll; the events feed reflects new lifecycle events (incl. the new `control`
    pause/resume + cancel observations); view-model mappers are unit-tested; all gates green.

- **#70 — Kanban board view with actionable cards.** _Owner: Nova · Effort M · Risk Med ·
  dep: #67, #68, #64._
  Columns **Candidate/Claimed → Running → Retrying → Completed** derived from the snapshot
  (DD-7); cards show identifier + state context; **Cancel** (running) and **Retry now**
  (retrying) buttons call the mutating API and reflect the `CommandResult`; **no drag**.
  **AC:** column derivation is a pure, unit-tested function over the snapshot; Cancel/Retry
  buttons issue the correct authorized POST and optimistically reflect the result, reverting
  on error; a card with no valid action shows none; all gates green.

- **#71 — Settings view + global pause/resume control.** _Owner: Nova (art: Milo) · Effort M
  · Risk Med · dep: #66._
  A form over the whitelisted editable settings (concurrency caps, poll interval, budget
  ceiling, max_turns, backoff) bound to `GET/PUT /api/v1/settings`, with client-side
  validation mirroring the schema; a prominent **Pause / Resume dispatch** toggle calling the
  control endpoints. **Never renders or requests a secret.**
  **AC:** loading shows current values (no secrets present in the payload or the DOM);
  saving round-trips and surfaces the typed error on an invalid patch without corrupting the
  form; the pause/resume toggle reflects the live `control.dispatch_paused` /`paused_by`; the
  settings form-model + validation are unit-tested; all gates green.

### Phase 3 — Close-out

- **#72 — Remove the Ink dashboard; tests + docs + handoff.** _Owner: Nova (docs: Remy) ·
  Effort M · Risk Low · dep: all._
  Delete `src/cli/dashboard/`, `src/cli/dashboard.tsx`, the `orchestra dashboard` subcommand
  in `main.ts`, the Ink-only deps (`ink`, `ink-testing-library`, `react-devtools-core`) and
  their tests (DD-6). Cross-feature coverage audit/fill (cockpit ↔ command ↔ settings),
  README (cockpit usage, `--port`, the token, the editable-settings whitelist, the security
  posture), `docs/sprint-6/done.md`, `progress.md` close record, `PROJECT_BRIEF.md` §5/§7/§8.
  **AC:** no remaining reference to Ink or the `dashboard` subcommand; `pnpm build` builds
  daemon + SPA; the dep delta is exactly the authorized set (below); all gates green; QA
  sign-off obtained before merge (control-plane sprint → QA gate is mandatory).

## Dependencies & build order

```
#64 ─▶ #65 ─▶ #66
        │      │
        ▼      │
       #67 ─▶ #68 ─▶ #69
        │            #70 ◀── (also #64)
        │      └────▶ #71 ◀── (#66)
        └────────────────────────────▶ #72 (after all)
```

Build order: **#64 → #65 → #66** (backend control plane; #64 is the only loop-assembly
change — gate it for review like the budget gate), then **#67 → #68** (scaffold + design),
then **#69/#70/#71** (the four views, parallelizable), then **#72** close-out (the deletion

- docs land last, after the cockpit has proven itself). Estimate ~8–11 days.

## API surface (contract level)

**Read (token-free, loopback):**

| Method · Path          | Returns                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `GET /api/v1/state`    | the snapshot — **byte-compatible** Sprint-5 shape + additive `control` block |
| `GET /api/v1/settings` | the whitelisted editable subset (raw values, **no secrets**)                 |

**Mutating (`Authorization: Bearer <token>` + loopback `Origin` required):**

| Method · Path                    | Command                         | `CommandResult`                                      |
| -------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `POST /api/v1/control/pause`     | `PauseDispatch`                 | `{ dispatch_paused: true, paused_by: "operator" }`   |
| `POST /api/v1/control/resume`    | `ResumeDispatch`                | `{ dispatch_paused, paused_by }`                     |
| `POST /api/v1/issues/:id/retry`  | `RetryNow(id)`                  | `{ accepted: boolean, reason? }`                     |
| `POST /api/v1/issues/:id/cancel` | `CancelSession(id)`             | `{ accepted: boolean, reason? }`                     |
| `PUT /api/v1/settings`           | (validate+write+`ReloadConfig`) | the new editable subset, or a typed validation error |

Errors: `401` (missing/blank token), `403` (cross-origin / non-loopback), `400`/typed body
(invalid patch), `404`/`{accepted:false}` (unknown issue id). Every mutating endpoint
returns only **after** the owner fiber has acked the command (bounded timeout → `503`).

## Frontend information architecture

| View                                   | Source                               | Content                                                                                                                                      |
| -------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fleet / Session overview** (default) | `GET /api/v1/state` poll             | running sessions (elapsed/status/workspace/attempt + humanized activity), totals, **budget**, **restore**, rate-limits, the `control` banner |
| **Kanban**                             | `GET /api/v1/state` poll             | Candidate/Claimed → Running → Retrying → Completed; Cancel/Retry-now buttons (DD-7)                                                          |
| **Events**                             | `GET /api/v1/state` poll             | the `recent_events` feed, newest-first, filterable                                                                                           |
| **Settings**                           | `GET/PUT /api/v1/settings` + control | editable whitelist + global Pause/Resume toggle                                                                                              |

## Security posture (summary, see DD-5)

Loopback bind · read token-free · **mutating = Bearer token + loopback-Origin allowlist** ·
per-process CSPRNG token (or `ORCHESTRA_COCKPIT_TOKEN`) injected same-origin into
`index.html` · no cookies (avoids the cross-site auto-send CSRF footgun) · no secret ever
leaves the daemon or reaches the browser. Documented in the README before any wider use.

## Dependency budget

**Add (justified):**

| Dep                    | Kind | Why                                                           |
| ---------------------- | ---- | ------------------------------------------------------------- |
| `vite`                 | dev  | the LOCKED SPA build/dev-server stack                         |
| `@vitejs/plugin-react` | dev  | React JSX + Fast-Refresh for Vite                             |
| `react-dom`            | dep  | the SPA's React renderer (Vite bundles it into static assets) |
| `@types/react-dom`     | dev  | types for the above                                           |

**Remove (DD-6, net-neutral):** `ink`, `ink-testing-library`, `react-devtools-core` — they
existed solely for the deleted Ink dashboard. `react` stays (now used by the SPA).

**Explicitly NOT added:** any browser HTTP client (the SPA uses plain `fetch`), any DOM test
stack (`jsdom`/`@testing-library`) — cockpit logic lives in **pure, vitest-tested modules**
(API mappers, column derivation, settings form-model), matching how the Ink dashboard kept
its testable core out of the render layer. The static-file serving reuses existing
`@effect/platform` — **no new runtime serving dep**.

## Success criteria

- A browser at `http://127.0.0.1:<port>/` shows live fleet, kanban, events, and settings,
  served by the daemon from one `HttpApi`.
- An operator can **pause/resume** dispatch, **retry-now** and **cancel** sessions from the
  UI; each action is applied by the **single owner fiber** via the command mailbox and
  reflected on the next snapshot.
- An operator can **edit + persist** the whitelisted `WORKFLOW.md` settings from the UI; the
  file is rewritten **atomically** with the Liquid body and any `$VAR`/`api_key`
  **byte-identical**, and the safe knobs **hot-apply** on the next tick without killing
  in-flight work.
- Mutating endpoints reject missing-token / cross-origin requests; no secret reaches the
  browser.
- The Ink dashboard and its deps are gone; `pnpm build` builds daemon + SPA; all gates green.

## Quality gates

`pnpm typecheck && pnpm lint && pnpm test` (vitest — adds the command-channel, cockpit-API,
settings-persistence, and SPA pure-logic suites; subtracts the Ink dashboard suites) **plus**
`pnpm build` (now `tsup` **and** `vite build`). Lint (biome) must cover `src/cockpit/`. The
QA gate is **mandatory** before merge — this sprint ships a control plane.

## Risk note

The only loop-assembly change is **#64** (the command mailbox path + the additive
operator-pause gate) — gate it for review exactly like the Sprint-5 budget gate, and keep
the command handler off the worker/reconcile paths (cancel is the sole worker-touching
command, and it interrupts only the named fiber). **#66**'s write path is the secret-safety
hot-spot — the "api_key + body byte-identical" test is the non-negotiable guard. **#72**'s
deletion is large but mechanical; it lands last, after the cockpit is proven.
