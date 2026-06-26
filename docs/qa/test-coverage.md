# Test Coverage — Phase 2 Scenario Catalog (Continuous QA Loop, Iteration 1)

The canonical per-feature test-scenario matrix lives in
[`test-scenarios.csv`](./test-scenarios.csv): **305 scenarios across all 37 features**
(`feature-inventory.csv`), spanning the seven categories — Happy, Error, Boundary, Invalid,
Security, Performance, and Responsive (UI features only). Every scenario is grounded in the
**actual code behavior** and maps to its coverage.

## Coverage at a glance

| Coverage             | Count | Meaning                                                                         |
| -------------------- | ----- | ------------------------------------------------------------------------------- |
| Automated (`test/…`) | 231   | A named unit/integration test exercises the scenario                            |
| Live / manual smoke  | 39    | Covered by the live daemon/browser smoke (no unit harness by design)            |
| Waived               | 35    | Explicitly accepted with documented rationale (see below) — **not** silent gaps |
| Open gap             | **0** | —                                                                               |

Each feature has at least one complete scenario set, and all major end-to-end journeys
(poll → select → dispatch → run → reconcile → retry/park → complete; cockpit read/control;
settings read/persist/hot-reload; restart restore) are represented.

## Gaps closed this iteration (13)

Phase 2 surfaced genuine coverage gaps; the high-value, low-risk ones were closed with new
regression tests (all passing):

| Scenario     | Feature              | New test                                                                          |
| ------------ | -------------------- | --------------------------------------------------------------------------------- |
| ORC-F004-S6  | GitHub tracker fetch | `tracker-github`: malformed slug → `TrackerUnknownPayload`                        |
| ORC-F004-S7  | GitHub tracker fetch | `tracker-github`: blank repo → `MissingTrackerRepo` (also pins DEF-008)           |
| ORC-F010-S8  | JSONL mapping        | `agent-copilot`: missing/invalid timestamp → injected `now` fallback              |
| ORC-F026-S8  | Cockpit API client   | `cockpit-client`: 404 → `not_found`; empty 2xx body → `undefined`                 |
| ORC-F027-S6  | Cockpit polling      | `cockpit-poller`: in-flight result after `stop()` is ignored                      |
| ORC-F027-S7  | Cockpit polling      | `cockpit-poller`: `start()` is idempotent                                         |
| ORC-F029-S7  | Fleet screen         | `cockpit-fleet`: unserializable `rate_limits` → "present (unserializable)"        |
| ORC-F030-S13 | Kanban screen        | `cockpit-kanban`: retry detail collapses to `#attempt` when error/schedule absent |
| ORC-F031-S9  | Events screen        | `cockpit-events`: free-text search with a null identifier (no crash)              |
| ORC-F031-S10 | Events screen        | `cockpit-events`: unknown event kind → level-glyph fallback (⚠ / ·)               |
| ORC-F031-S12 | Events screen        | `cockpit-events`: over-long message truncated to one capped line                  |
| ORC-F037-S6  | Issue parking        | `orchestrator-pure`: `abandon()` transition + claim/mutual-exclusion invariant    |
| ORC-F037-S8  | Issue parking        | already covered (`domain`: rejects non-positive `attempts`) — re-mapped           |

## Waivers (35) — explicitly accepted, with rationale

These scenarios are intentionally not unit-tested; each is covered another way or is low-value
to isolate. They are recorded so coverage stays honest (a waiver is a decision, not a silent
hole).

- **No jsdom/DOM test stack (4)** — `usePolling`/`useKeyboardShortcuts` DOM-bound behaviors
  (F027-S9, F028-S9/S10/S11). Per the Sprint-6 dependency budget there is no jsdom; React
  components are exercised via their pure `model/*` mappers + live browser smoke.
- **No Octokit mock/injection seam (4)** — the GitHub adapter's Octokit transport paths
  (pagination/PR-filter, 404→omit, non-404 re-fail, network fault): F004-S1/S3/S4/S5. The pure
  normalization is fully unit-tested; transport is covered by live smoke. (The `parseRepo`
  error branches, which short-circuit before any network call, ARE now unit-tested.)
- **Shared HTTP auth middleware (10)** — per-endpoint HTTP 401/403 and idempotency for
  resume/retry/cancel/settings (F019-S8, F020-S3/S5, F022-S6, F023-S2/S4, F024-S5/S6,
  F025-S4/S5). All mutating endpoints share one `CockpitAuth` middleware proven end-to-end on
  `control/pause`; the underlying commands are covered at the command/client layers.
- **Build-script / static-serving internals (8)** — `check-react-doctor.mjs` error branches,
  static SPA fallback, no-budget read projection (F002-S9, F019 dup, F020-S4, F035-S4,
  F036-S3/S4/S6). Low value to isolate; the gate's happy path runs in CI every push.
- **Subprocess / loop fault-injection (7)** — `before_remove` failure, `AgentNotFound`,
  `TurnTimeout`, per-tick preflight/fetch error, budget-reload resume, combined `pausedBy`,
  abandon-time cleanup failure (F008-S8, F009-S7/S8, F011-S3, F014-S6/S7, F037-S7). Covered via
  the fake-script e2e + live smoke; deeper injection deferred.
- **Daemon lifecycle live smoke (1)** — daemon boot with a bad workflow path (F001-S6); covered
  by the documented live smoke, no boot harness.
- **Documented residual risk (1)** — F015-S8: non-finite `runtime_seconds` at the persistence
  layer. Finiteness is guaranteed at the ORC-F010 mapper boundary (DEF-002 fix); the encoder
  still trusts finiteness. See [`defect-log.md`](./defect-log.md).

## Method

Phase 2 ran six parallel scenario generators (one per subsystem), each reading the actual
implementation and its tests to map every scenario to real coverage and flag honest gaps. The
flagged gaps were then triaged: closed with a test where high-value and low-risk, otherwise
waived with the rationale above. No scenario is left as an unaddressed "Gap".
