# Sprint 6 — QA Sign-off (The Web Cockpit)

**QA:** Ivy · **Date:** 2026-06-24
**Branch under test:** `feature/sprint-6` @ `068f7ca` (local, not pushed — pre-PR review)
**Scope:** #64–#72 — daemon-served Vite+React cockpit + typed `@effect/platform` control plane,
operator pause/resume + per-session cancel/retry-now, whitelisted settings read/persist/hot-reload,
and removal of the superseded Ink dashboard.

## Verdict: ✅ SHIP-WITH-FOLLOWUPS

No blockers. All gates green, the full control-plane and security model verified live against a
running daemon, and the Ink dashboard is confirmed gone. One **minor**, cosmetic, no-data-loss
defect was filed (#73) — a follow-up, not a ship-stopper.

## How I tested (mode)

**curl + code-review mode.** No browser-automation tooling is available in this environment
(no Playwright/Puppeteer/headless Chromium), so the React views were **not** rendered in a real
browser. Instead I:

1. Ran the full automated gate (`pnpm check`, `pnpm build`).
2. Built `dist/` and ran the real daemon on a free loopback port with a pinned token, against a
   throwaway `WORKFLOW.md` (dummy `GITHUB_TOKEN`, so tracker polls 401 — expected; the daemon
   stays up and serves the cockpit), then drove the **live HTTP API** with `curl` through the
   happy paths **and** the negative auth/Origin/Host, settings-validation, and traversal cases.
3. Read the implementation against every #64–#72 AC: the CommandBus → owner-fiber → snapshot
   control flow, the settings whitelist/secret-safety, the auth/Origin enforcement, the static
   serving + token injection, and the pure SPA `model/*` mappers + API client.

Commands used (representative):
```
pnpm check            # tsc x2 + biome + vitest
pnpm build            # tsup + vite build
GITHUB_TOKEN=dummy ORCHESTRA_COCKPIT_TOKEN=<tok> node dist/cli/main.js <wf> --port <port>
curl ... (read + auth-matrix + settings PUT + traversal — see below)
```

## Gate results

| Gate | Result |
|------|--------|
| `pnpm typecheck` (root + `tsconfig.cockpit.json`) | ✅ clean |
| `pnpm lint` (Biome) | ✅ clean |
| `pnpm test` (vitest) | ✅ **347 passing / 347** across **36 files**, 0 failures, ~3s |
| `pnpm build` | ✅ `tsup` → `dist/cli/main.js` (128 KB); `vite` → `dist/cockpit/index.html` + hashed `assets/` (37 modules) |

Test count matches `done.md` (347). The byte-compatibility round-trip test for `GET /api/v1/state`
(`test/cockpit-server.test.ts` "is byte-identical to JSON.stringify(toSnapshot(...))") is present
and green.

## AC checklist (#64–#72)

| # | Feature | AC verdict | Evidence |
|---|---------|-----------|----------|
| #64 | Command channel + operator control | ✅ PASS | Live: `POST /control/pause` → `{"dispatch_paused":true,"paused_by":"operator"}`, snapshot `control` block then reflects it + an `operator_paused` event appears in `recent_events`; resume clears it (`control` omitted again). Dispatch gate `(budget.paused || operatorPaused)` confirmed by code + `command-control.test.ts`/`budget-gate.test.ts`. |
| #65 | Cockpit `HttpApi` (read + mutating) | ✅ PASS | `GET /api/v1/state` 200 token-free, byte-compat test pins it; mutating endpoints reject 401/403 (matrix below); valid command returns its `CommandResult`; SPA index served with token bootstrap; daemon stays up when tracker auth fails. |
| #66 | Settings read/persist + hot-reload | ✅ PASS (caveat #73) | `GET /api/v1/settings` returns **only** the whitelist (no `tracker`/`api_key`/secrets); valid `PUT` round-trips, `poll_interval_ms` hot-applies on the next tick (45000 reflected in `/state`); invalid patch (negative concurrency) → 400 **before** write; `budget.max_total_tokens: null` clears the key. **Headline secret-safety holds**: `api_key: $GITHUB_TOKEN` + Liquid body byte-identical across a write. Caveat: untouched-key whitespace reformatting → #73 (minor). |
| #67 | Vite+React scaffold + serving + client | ✅ PASS | `pnpm build` emits the SPA; API client (`api/client.ts`) is DOM-free, attaches the bearer token **only** to mutating verbs, reads token-free, surfaces typed `ApiError`; `cockpit-client.test.ts` green. |
| #68 | Design system + app shell | ✅ PASS | Web token parity with `glyphs.ts`/`design-system.md`; `cockpit-design.test.ts` green; shared chip/panel primitives reused by the views. |
| #69 | Fleet + Events views | ✅ PASS | Pure mappers (`model/fleet.ts`, `model/events.ts`) unit-tested; additive contract honored (absent `control`/`restore` → block omitted, verified live); non-overlapping poller (`cockpit-poller.test.ts`). |
| #70 | Kanban with actionable cards | ✅ PASS | Pure `toKanban` derivation unit-tested; Running→Cancel, Retrying→Retry-now, Completed→no action; Claimed count-only (documented limitation #1). Live: retry/cancel unknown id → `{"accepted":false,"reason":"no such tracked issue"}`. |
| #71 | Settings view + pause/resume toggle | ✅ PASS | Settings form-model + validation unit-tested (`cockpit-settings.test.ts`); payload carries no secrets (verified live); pause/resume wired to `control.*`. |
| #72 | Remove Ink dashboard + docs | ✅ PASS | No `ink`/`ink-testing-library`/`react-devtools-core` in `package.json` or `pnpm-lock.yaml`; no `ink` imports or `dashboard` subcommand in `src`/`test` (only doc-comment mentions remain); `main.ts` is a single daemon entry; `pnpm build` builds daemon + SPA. |

## Security validation (DD-5) — all ✅

Live against the running daemon (`POST /api/v1/control/pause`, `PUT /api/v1/settings`):

| Case | Expected | Actual |
|------|----------|--------|
| Daemon bind | loopback only | `127.0.0.1:<port>` (LISTEN) ✅ |
| Read `GET /state`, `GET /settings` | token-free 200 | 200 ✅ |
| Mutating, no token | 401 | 401 ✅ |
| Mutating, blank `Bearer ` | 401 | 401 ✅ |
| Mutating, wrong token | 401 | 401 ✅ |
| Mutating, good token + cross-origin `Origin` | 403 | 403 ✅ |
| Mutating, good token + `Origin: null` | 403 | 403 ✅ |
| Mutating, good token + evil `Host` | 403 | 403 ✅ |
| Mutating, good token + loopback `Origin` | 200 | 200 ✅ |
| Mutating, good token + no `Origin` (curl) | 200 | 200 ✅ |
| Token in served `/` HTML | injected at serve time | `window.__ORCHESTRA_COCKPIT_TOKEN__="..."` present ✅ |
| Token in on-disk built HTML | absent | `dist/cockpit/index.html` has **0** matches ✅ |
| `GET /settings` secret exposure | none | only `polling`/`agent`/`budget`; no `tracker`/`api_key`/`$VAR`/resolved secret ✅ |
| `GET /state` secret exposure | none | no token/`$GITHUB_TOKEN`/resolved-secret leak ✅ |
| Path traversal (`%2e%2e%2f...` to `/etc/passwd`, `package.json`) | no file leak | serves SPA index, no file contents leaked ✅ |
| Settings secret-safety on write | `api_key`/`$VAR`/body byte-identical | confirmed via on-disk diff (`api_key: $GITHUB_TOKEN`, Liquid body unchanged) ✅ |
| `</script>` token-injection escape | escaped | covered by `cockpit-security.test.ts` / token tests ✅ |

Token comparison is length-checked + branch-stable (not a per-char early return); a length leak is
immaterial for a loopback operator tool and is documented as such. Acceptable.

## Bugs filed

| # | Title | Severity | Status |
|---|-------|----------|--------|
| [#73](https://github.com/martinthommesen/orchestra/issues/73) | Settings PUT reformats untouched WORKFLOW.md front-matter (comment alignment + flow-seq spacing) | minor | open |

**#73 summary:** the first `PUT /api/v1/settings` re-serializes the whole YAML front matter, so
untouched lines get cosmetically normalized (aligned trailing comments collapse to a single space;
flow arrays gain inner padding `[orchestra]` → `[ orchestra ]`). Comments, the `$VAR` value, and the
Liquid body all survive (no data loss, no secret leak) and it is idempotent after the first write —
but it contradicts the documented "every untouched key verbatim" guarantee and creates one-time
git-diff noise. Minor, not a blocker.

## Accepted limitations (confirmed reasonable & documented — NOT bugs)

1. **Kanban "Claimed" column is count-only.** Confirmed in `model/kanban.ts` + `done.md`: the wire
   emits `counts.claimed` but no claimed issue IDs (Orchestra reads the tracker). Count is the
   pending = `claimed − running − retrying`, clamped ≥ 0. Reasonable, documented. ✅
2. **UI poll cadence fixed at 2 s** (`COCKPIT_POLL_MS`). Documented; non-overlapping poller is
   unit-tested. Reasonable. ✅
3. **Pure-module unit coverage only** (no jsdom/DOM stack). Confirmed: React components are exercised
   via pure `model/*` mappers + the live e2e smoke, not a rendered-DOM suite. Per the dependency
   budget; reasonable and disclosed. ✅ (Noted: my own playthrough was therefore curl + code-review,
   not a rendered-browser click-through — see mode above.)

## Blocker status

**No blockers.** The single state-owning-fiber / structural-exactly-once invariant is preserved
(all mutations flow through the CommandBus → mailbox), the read wire stays byte-compatible, secrets
never reach the wire or the disk-write path, and the auth/Origin model fails closed. The one open
issue (#73) is minor and cosmetic.

## Recommendation

**SHIP-WITH-FOLLOWUPS.** Open the PR for `feature/sprint-6`. Track #73 as a fast follow (a one-line
`yaml` stringifier option or node-level edit would likely resolve it). Re-verify #73 when fixed
before closing.
