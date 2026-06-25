# Sprint 6 — QA Sign-off (The Web Cockpit)

**QA:** Ivy · **Date:** 2026-06-24 (initial) · 2026-06-24 (QA-loop close: #73 fix verified)
**Branch under test:** `feature/sprint-6` @ `8ede8b3` (local, not pushed — pre-PR review)
**Scope:** #64–#72 — daemon-served Vite+React cockpit + typed `@effect/platform` control plane,
operator pause/resume + per-session cancel/retry-now, whitelisted settings read/persist/hot-reload,
and removal of the superseded Ink dashboard.

## Verdict: ✅ SHIP

No blockers, **no open follow-ups**. All gates green, the full control-plane and security model
verified live against a running daemon, and the Ink dashboard is confirmed gone. The one minor defect
filed during the initial sign-off (#73) was **fixed in-branch at `8ede8b3` and verified by QA** (see
"#73 fix verification" below) — it ships in this PR, so the verdict is flipped from the initial
SHIP-WITH-FOLLOWUPS to **✅ SHIP**.

## #73 fix verification (QA-loop close, 2026-06-24)

The dev team fixed #73 (settings PUT reformatting untouched front-matter) in-branch at commit
`8ede8b3`. I re-verified both gates and the behavior live; **it holds**.

- **Gates:** `pnpm check` green — **349 tests / 349** across 36 files (was 347; **+2 new
  byte-verbatim regressions** in `test/settings.test.ts`: the scalar-PUT whole-file byte-identical
  assertion and the budget-clear structural case). `pnpm build` green.
- **Live (curl, rebuilt `dist/`):** against a `WORKFLOW.md` with aligned trailing comments + a
  flow-style array (`[orchestra, bot]`):
  - **Scalar PUT (dominant path)** — `agent.max_turns: 20 → 33` and `polling.interval_ms: 30000 →
5000`: the on-disk diff is **exactly the one changed value line** each time. Aligned trailing
    comments, the compact flow array, key order, and the body are all byte-identical. The #73
    regression is gone on the path operators hit by far the most.
  - **Structural budget-clear** (`budget.max_total_tokens: null`): the key is removed, the now-empty
    `budget:` block is pruned (no dangling `budget: {}`), and the flow array stays **compact**
    (`[orchestra, bot]`, no `[ orchestra ]` padding regression). The `$VAR` secret (`$GITHUB_TOKEN`)
    and the Liquid body pass through verbatim; the resolved secret value is never written. Trailing-
    comment **alignment normalizes** on untouched lines on this path only.
  - **Mechanism confirmed in code** (`src/core/workflow/workflow-file.ts`): scalar edits on an
    existing key rewrite only that scalar's CST source token (`keepSourceTokens` + `CST.setScalarValue`
    - `CST.stringify`); structural edits fall back to `doc.toString({ flowCollectionPadding: false })`
      with empty-parent pruning; the **actual output bytes** are re-parsed + schema-validated before the
      atomic write. Secret-safety (raw-front-matter-only, `api_key`/`$VAR`/body untouched) is unchanged.

**Accepted best-effort caveat (NOT a bug):** on the rarer _structural_ sub-cases (key delete, map
set, or introducing a key absent from the raw file) the universal `[ orchestra ]` padding regression
is fixed, but trailing-comment **alignment on untouched lines may normalize**. This is an explicit,
documented trade-off — framed correctly in `done.md` ("best-effort: comment alignment ... may
normalize") and the code header — and verified to read accurately. No data loss, no secret leak; it
is not re-filed.

#73 is **resolved and closeable** (it ships in this PR). No open follow-ups remain.

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

| Gate                                              | Result                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck` (root + `tsconfig.cockpit.json`) | ✅ clean                                                                                                                                                     |
| `pnpm lint` (Biome)                               | ✅ clean                                                                                                                                                     |
| `pnpm test` (vitest)                              | ✅ **349 passing / 349** across **36 files**, 0 failures, ~3s (347 at the initial sign-off; +2 new #73 byte-verbatim regressions in `test/settings.test.ts`) |
| `pnpm build`                                      | ✅ `tsup` → `dist/cli/main.js` (128 KB); `vite` → `dist/cockpit/index.html` + hashed `assets/` (37 modules)                                                  |

Test count matches `done.md` (349 after the #73 fix). The byte-compatibility round-trip test for
`GET /api/v1/state` (`test/cockpit-server.test.ts` "is byte-identical to JSON.stringify(toSnapshot(...))")
is present and green.

## AC checklist (#64–#72)

| #   | Feature                                | AC verdict | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------- |
| #64 | Command channel + operator control     | ✅ PASS    | Live: `POST /control/pause` → `{"dispatch_paused":true,"paused_by":"operator"}`, snapshot `control` block then reflects it + an `operator_paused` event appears in `recent_events`; resume clears it (`control` omitted again). Dispatch gate `(budget.paused                                                                                                                                                                                                                                                                                                                                                                                                     |     | operatorPaused)`confirmed by code +`command-control.test.ts`/`budget-gate.test.ts`. |
| #65 | Cockpit `HttpApi` (read + mutating)    | ✅ PASS    | `GET /api/v1/state` 200 token-free, byte-compat test pins it; mutating endpoints reject 401/403 (matrix below); valid command returns its `CommandResult`; SPA index served with token bootstrap; daemon stays up when tracker auth fails.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #66 | Settings read/persist + hot-reload     | ✅ PASS    | `GET /api/v1/settings` returns **only** the whitelist (no `tracker`/`api_key`/secrets); valid `PUT` round-trips, `poll_interval_ms` hot-applies on the next tick; invalid patch (negative concurrency) → 400 **before** write; `budget.max_total_tokens: null` clears the key + prunes the empty block. **Headline secret-safety holds**: `api_key: $GITHUB_TOKEN` + Liquid body byte-identical across a write. **#73 fixed @ `8ede8b3`**: scalar PUT is now byte-verbatim (verified live — only the edited value moves, comment alignment + flow arrays preserved); structural edits keep arrays compact with a documented best-effort comment-alignment caveat. |
| #67 | Vite+React scaffold + serving + client | ✅ PASS    | `pnpm build` emits the SPA; API client (`api/client.ts`) is DOM-free, attaches the bearer token **only** to mutating verbs, reads token-free, surfaces typed `ApiError`; `cockpit-client.test.ts` green.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| #68 | Design system + app shell              | ✅ PASS    | Web token parity with `glyphs.ts`/`design-system.md`; `cockpit-design.test.ts` green; shared chip/panel primitives reused by the views.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| #69 | Fleet + Events views                   | ✅ PASS    | Pure mappers (`model/fleet.ts`, `model/events.ts`) unit-tested; additive contract honored (absent `control`/`restore` → block omitted, verified live); non-overlapping poller (`cockpit-poller.test.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| #70 | Kanban with actionable cards           | ✅ PASS    | Pure `toKanban` derivation unit-tested; Running→Cancel, Retrying→Retry-now, Completed→no action; Claimed count-only (documented limitation #1). Live: retry/cancel unknown id → `{"accepted":false,"reason":"no such tracked issue"}`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #71 | Settings view + pause/resume toggle    | ✅ PASS    | Settings form-model + validation unit-tested (`cockpit-settings.test.ts`); payload carries no secrets (verified live); pause/resume wired to `control.*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| #72 | Remove Ink dashboard + docs            | ✅ PASS    | No `ink`/`ink-testing-library`/`react-devtools-core` in `package.json` or `pnpm-lock.yaml`; no `ink` imports or `dashboard` subcommand in `src`/`test` (only doc-comment mentions remain); `main.ts` is a single daemon entry; `pnpm build` builds daemon + SPA.                                                                                                                                                                                                                                                                                                                                                                                                  |

## Security validation (DD-5) — all ✅

Live against the running daemon (`POST /api/v1/control/pause`, `PUT /api/v1/settings`):

| Case                                                             | Expected                             | Actual                                                                            |
| ---------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Daemon bind                                                      | loopback only                        | `127.0.0.1:<port>` (LISTEN) ✅                                                    |
| Read `GET /state`, `GET /settings`                               | token-free 200                       | 200 ✅                                                                            |
| Mutating, no token                                               | 401                                  | 401 ✅                                                                            |
| Mutating, blank `Bearer `                                        | 401                                  | 401 ✅                                                                            |
| Mutating, wrong token                                            | 401                                  | 401 ✅                                                                            |
| Mutating, good token + cross-origin `Origin`                     | 403                                  | 403 ✅                                                                            |
| Mutating, good token + `Origin: null`                            | 403                                  | 403 ✅                                                                            |
| Mutating, good token + evil `Host`                               | 403                                  | 403 ✅                                                                            |
| Mutating, good token + loopback `Origin`                         | 200                                  | 200 ✅                                                                            |
| Mutating, good token + no `Origin` (curl)                        | 200                                  | 200 ✅                                                                            |
| Token in served `/` HTML                                         | injected at serve time               | `window.__ORCHESTRA_COCKPIT_TOKEN__="..."` present ✅                             |
| Token in on-disk built HTML                                      | absent                               | `dist/cockpit/index.html` has **0** matches ✅                                    |
| `GET /settings` secret exposure                                  | none                                 | only `polling`/`agent`/`budget`; no `tracker`/`api_key`/`$VAR`/resolved secret ✅ |
| `GET /state` secret exposure                                     | none                                 | no token/`$GITHUB_TOKEN`/resolved-secret leak ✅                                  |
| Path traversal (`%2e%2e%2f...` to `/etc/passwd`, `package.json`) | no file leak                         | serves SPA index, no file contents leaked ✅                                      |
| Settings secret-safety on write                                  | `api_key`/`$VAR`/body byte-identical | confirmed via on-disk diff (`api_key: $GITHUB_TOKEN`, Liquid body unchanged) ✅   |
| `</script>` token-injection escape                               | escaped                              | covered by `cockpit-security.test.ts` / token tests ✅                            |

Token comparison is length-checked + branch-stable (not a per-char early return); a length leak is
immaterial for a loopback operator tool and is documented as such. Acceptable.

## Bugs filed

| #                                                             | Title                                                                                            | Severity | Status                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------- |
| [#73](https://github.com/martinthommesen/orchestra/issues/73) | Settings PUT reformats untouched WORKFLOW.md front-matter (comment alignment + flow-seq spacing) | minor    | **fixed in-branch @ `8ede8b3`, verified, ships in this PR** |

**#73 summary (filed):** the first `PUT /api/v1/settings` re-serialized the whole YAML front matter, so
untouched lines got cosmetically normalized (aligned trailing comments collapsed to a single space;
flow arrays gained inner padding `[orchestra]` → `[ orchestra ]`). Comments, the `$VAR` value, and the
Liquid body all survived (no data loss, no secret leak), but it contradicted the documented "every
untouched key verbatim" guarantee and created one-time git-diff noise.

**#73 resolution (verified):** fixed at `8ede8b3`. The dominant path — a scalar PUT on an existing key
— is now **byte-verbatim** (only the edited value's bytes change, via a CST source-token rewrite),
verified live (see "#73 fix verification" up top). Structural sub-cases (delete/map/absent-key) drop
the array-padding regression universally and prune empty parent blocks, with an accepted, documented
best-effort caveat that trailing-comment alignment on untouched lines may normalize. No open
follow-ups remain.

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
4. **Settings write — structural-edit comment-alignment normalization** (#73 fix best-effort caveat).
   On the rarer structural PUT sub-cases (key delete / map set / absent key), trailing-comment
   alignment on untouched lines may normalize (the array-padding regression itself is fixed
   universally). Documented in `done.md` + the code header; no data loss, no secret leak. Reasonable. ✅

## Blocker status

**No blockers, no open follow-ups.** The single state-owning-fiber / structural-exactly-once invariant
is preserved (all mutations flow through the CommandBus → mailbox), the read wire stays byte-compatible,
secrets never reach the wire or the disk-write path, and the auth/Origin model fails closed. The one
defect filed at sign-off (#73) is fixed in-branch and verified.

## Recommendation

**SHIP.** Open the PR for `feature/sprint-6` — it carries the #73 fix, so there is nothing left to
track. #73 can be closed by the merge.
