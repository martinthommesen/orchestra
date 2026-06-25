# Defect Log — Continuous QA Loop (Iteration 1)

Source of truth for defects found by the continuous software-quality loop, complementing
`feature-inventory.csv` (which tracks per-feature status). Defect IDs are global and
monotonic. `DEF-001` was closed in a prior loop (see `ORC-F021` notes).

Baseline at start of this iteration: **382 tests pass**, typecheck/lint/react-doctor clean.
Discovery was run as five parallel adversarial audits across orchestrator core, cockpit
server/security, adapters, persistence/restore, and the cockpit SPA model — each tasked with
finding genuine behavioral defects the existing suite misses, with a concrete reproduction.

All vectors below were **empirically reproduced** against the real code before any fix, and
each fix ships with a regression test that fails on the old code and passes on the new.

---

## DEF-002 — Non-finite `runtime_seconds` silently destroys the durable checkpoint (CRITICAL — fixed)

- **Feature:** ORC-F010 (Copilot JSONL event mapping) → ORC-F015 (durable checkpoint).
- **Reproduction:** A Copilot `result` line whose `usage.totalApiDurationMs` is non-finite —
  e.g. the JSON literal `1e400`, which `JSON.parse` turns into `Infinity` (`typeof === "number"`).
  `mapUsage` accepted it (`num` only checked `typeof === "number"`), `addUsage` folded it into
  `agent_totals.runtime_seconds` (→ `Infinity`), `JSON.stringify` emitted it as `null`, and the
  **next** boot's strict `Schema.parseJson` decode rejected `null` for a `Schema.Number` field.
- **Expected:** A malformed/extreme vendor usage value is ignored; the checkpoint always
  re-decodes. The documented invariant is that _only_ `agent_rate_limits` can fault the encode.
- **Actual:** `Persistence.load` classified the file as corrupt, renamed it
  `state.json.corrupt-<ts>`, and booted **completely fresh** — silently losing `completed`
  history, `agent_totals`, rate limits, and all in-flight bookkeeping.
- **Severity:** Critical (total, silent loss of durable orchestrator progress — defeats the
  central durability guarantee from a single bad number).
- **Root cause:** `src/adapters/agent-copilot/map.ts` `num()` admitted non-finite numbers at the
  untrusted vendor boundary; the persisted-state encode guard only covered `agent_rate_limits`.
- **Fix:** `num()` is now finite-only (`Number.isFinite`), so a non-finite measurement is dropped
  like any non-number and can never reach the totals. Smallest fix at the root (the boundary).
- **Tests:** `test/agent-copilot.test.ts` — "drops non-finite numeric fields…" (mapUsage) and
  "drops an overflowing duration parsed from a raw result line".
- **Residual risk:** The persistence encode still trusts that the totals are finite; this is now
  guaranteed by the single producer (the mapper). A second producer would need the same guard.

## DEF-003 — Clearing the budget ceiling on a no-`budget:` file returns HTTP 500 (HIGH — fixed)

- **Feature:** ORC-F021 (PUT /api/v1/settings).
- **Reproduction:** `WORKFLOW.md` has no `budget:` block (**the shipped default** —
  `WORKFLOW.example.md` ships without one), and `PUT /api/v1/settings` carries
  `{"budget":{"max_total_tokens":null}}` (how the cockpit form encodes a blank ceiling).
- **Expected:** Clearing an already-absent ceiling is an idempotent no-op → 200, file unchanged.
- **Actual:** `yaml`'s `doc.deleteIn(["budget","max_total_tokens"])` threw synchronously
  (`Expected YAML collection at budget`); the throw was not wrapped, became an Effect **die**,
  and the handler's typed `catchTags` did not catch it → **HTTP 500** (an undeclared status).
- **Severity:** High (the default starting state makes a normal settings-form submit fail; the
  error is misclassified, though the file is not corrupted).
- **Root cause:** `src/core/workflow/workflow-file.ts` ran the structural `deleteIn`
  unconditionally and synchronously.
- **Fix:** Already-absent delete paths are filtered out via `doc.hasIn(...)` up front (so an
  absent-clear keeps the byte-verbatim path and leaves the file byte-identical), AND the
  structural mutation block is wrapped in `Effect.try` mapping any throw to a typed
  `SettingsRejected`.
- **Tests:** `test/settings.test.ts` — "clearing an already-absent budget ceiling is a clean
  no-op, not a 500".

## DEF-004 — A patch onto a malformed scalar intermediate returns HTTP 500 (LOW — fixed)

- **Feature:** ORC-F021 (PUT /api/v1/settings). Same root cause as DEF-003.
- **Reproduction:** A hand-malformed `agent: 5` (scalar where a map is expected) + a patch
  `{"agent":{"max_turns":7}}` → `yaml`'s `setIn` throws `Expected YAML collection at agent`.
- **Expected:** A typed rejection (`SettingsRejected` → 400); nothing written.
- **Actual:** Unhandled die → HTTP 500.
- **Severity:** Low (requires an already-malformed file that would likely fail to decode
  elsewhere; not reachable from the default file the way DEF-003 is).
- **Fix:** Covered by the `Effect.try` wrap added for DEF-003.
- **Tests:** `test/settings.test.ts` — "a patch onto a malformed scalar intermediate is rejected
  (400), not a 500".

## DEF-005 — `toIssue`/`toStateRef` crash the poll loop on a schema-invalid derived field (CRITICAL — fixed)

- **Feature:** ORC-F005 (GitHub issue normalization) → ORC-F004/F011 (tracker fetch / loop).
- **Reproduction:** Two reachable vectors:
  1. A non-parseable `created_at`/`updated_at` (e.g. `"garbage-date"` from a GHE/proxy/mock) →
     `new Date(...)` is `Invalid Date`, which `Schema.Date` rejects.
  2. An author-controlled priority label like `p99999999999999999999` → `1e20`, which is not a
     safe integer and `Schema.Int` rejects.
     `toIssue` builds the record with `Issue.make({...})`, which validates and **throws a
     `ParseError` synchronously**. Because `toIssue` runs inside `Effect.map` (not `Effect.try`),
     the throw is a **die**, which the orchestrator's `Effect.either` guards do **not** catch.
- **Expected:** The port contract is `Effect<…, TrackerError>`; one malformed issue must degrade,
  not crash. A bad timestamp/priority should not take down polling.
- **Actual:** A single malformed/hostile issue escaped as an uncaught defect and crashed the
  polling tick / worker fiber, bypassing the entire typed-error design.
- **Severity:** Critical (availability — one bad issue can take the daemon's poll loop down).
- **Root cause:** `src/adapters/tracker-github/normalize.ts` `toDate` could yield `Invalid Date`
  and `derivePriority` could yield an out-of-range integer, both schema-invalid.
- **Fix:** `toDate` returns `null` for an unparseable date (the field is `NullOr(Date)`);
  `derivePriority` returns `null` for a non-`Number.isSafeInteger` value. A single malformed
  issue now degrades that one field gracefully and keeps processing.
- **Tests:** `test/tracker-github.test.ts` — "degrades a non-parseable timestamp to null instead
  of dying", "degrades an out-of-range priority label to null instead of dying", and
  "returns null for a priority that overflows the safe-integer range".

## DEF-006 — A `result` with a present-but-non-numeric `exitCode` is misread as success (MEDIUM — fixed)

- **Feature:** ORC-F010 (Copilot JSONL event mapping) → ORC-F009 (runner).
- **Reproduction:** `{"type":"result","exitCode":"5"}` (a **string** exit code). `num(obj.exitCode)`
  returned `undefined`, and `?? 0` coerced it to `0` → `TurnCompleted`/`completed`.
- **Expected:** A present non-zero/non-numeric exit code is a failure (`AgentProcessExit`).
- **Actual:** Reported as a clean turn; worse, the runner's `sawCompleted` latch then also
  swallowed the process's own non-zero exit — a failed turn looked completed.
- **Severity:** Medium (masks a real failure; bounded because real Copilot emits a numeric code).
- **Root cause:** The `num(...) ?? 0` default could not distinguish "absent" from "present but
  unusable".
- **Fix:** A clean turn now requires `exitCode === 0` (numeric). An entirely **absent** field keeps
  the historical completed default (the e2e wire always carries `exitCode: 0`); a **present**
  non-numeric/non-finite value maps to a non-zero (failure) exit.
- **Tests:** `test/agent-copilot.test.ts` — "treats a present-but-non-numeric exitCode as a
  failure, not success" and "keeps the completed default for a result with no exitCode field".

## DEF-007 — Server error detail dropped for JSON bodies without a `message` field (LOW — fixed)

- **Feature:** ORC-F026 (Cockpit API client and errors).
- **Reproduction:** A non-2xx body that is valid JSON but lacks a string `message`
  (e.g. `{"error":"the real reason"}`). `messageFromBody`'s `try` succeeded but the `if` was
  skipped, so it fell through to the generic `"request failed with status 400"` — dropping the
  server's actual diagnostic.
- **Expected:** Surface the server's detail.
- **Actual:** Operator saw only the generic status line.
- **Severity:** Low (diagnostics/honesty regression, not a correctness break).
- **Fix:** Any non-empty body that isn't `{message:string}` is now surfaced verbatim.
- **Tests:** `test/cockpit-client.test.ts` — "preserves a server error body that is JSON without a
  `message` field".

## DEF-008 — `parseRepo` mislabels a missing repo as a malformed-payload error (LOW — fixed)

- **Feature:** ORC-F004 (GitHub tracker fetch).
- **Reproduction:** An absent/blank `tracker.repo` (call sites pass `config.tracker.repo ?? ""`)
  failed with `TrackerUnknownPayload("tracker.repo must be 'owner/name'")` instead of the
  semantically-correct `MissingTrackerRepo` (spec `missing_tracker_project_slug`).
- **Expected:** A missing required slug uses the dedicated missing-slug error.
- **Actual:** Wrong error tag (affects operator diagnostics and `catchTag` discrimination).
- **Severity:** Low (classification only; preflight gates repo presence before dispatch, so it is
  defense-in-depth).
- **Fix:** A blank repo now fails with `MissingTrackerRepo`; a present-but-malformed repo keeps
  `TrackerUnknownPayload`.
- **Tests:** `test/tracker-github.test.ts` — "a blank repo fails with MissingTrackerRepo
  (DEF-008), not TrackerUnknownPayload" and "a malformed slug (no '/') fails with
  TrackerUnknownPayload", driven through the real tracker layer (`fetchCandidateIssues` parses
  the repo before any Octokit call, so `parseRepo` short-circuits with the typed error and no
  network is touched). Added in the Phase 2 gap-closure (ORC-F004-S6/S7); this supersedes the
  initial "verified by inspection" note.

---

## Investigated and intentionally NOT changed (documented design tensions / residual risks)

These were surfaced by the audit but are coherent, intentional behavior (or Low/narrow edge
cases). Changing them would alter documented semantics or risk a regression; they are recorded as
residual risks, not defects.

- **`max_failure_retries` counts lifetime failures, not per-episode** (orchestrator). `failureAttempts`
  accumulates and is never reset by an intervening clean turn, while `turnCount` resets on each
  fresh (failure) re-dispatch. This is a _matched pair_: the non-resetting failure counter is
  exactly what bounds total work to ~`max_turns × (max_failure_retries+1)`. "Fixing" the parking
  side would make the turn budget genuinely unbounded under intermittent failures. The
  `AbandonedIssue` docstring confirms the intent ("Failure count that crossed
  `agent.max_failure_retries`"). **Left as-is**; operators should read `max_failure_retries` as a
  lifetime failure budget.
- **Token usage can be under-counted if a worker's usage event is drained after a `CancelSession`/kill**
  removes the issue from the registry (the `addUsage` is inside the `rec === undefined` guard).
  Narrow ordering window; budget under-count only. Residual, Low.
- **Per-state concurrency uses the dispatch-time issue state.** `rec.issue.state` is not updated when
  an issue changes state mid-run, so `max_concurrent_agents_by_state` can charge a slot to the
  wrong bucket; bounded by the global cap and only matters when per-state caps differ. Residual,
  Low.
- **Cockpit keyboard `g g` cancels the prefix** instead of restarting it, and a known event `kind`
  glyph can override a `warn` `level`. Both Low-confidence, plausibly intentional. Residual,
  cosmetic.
