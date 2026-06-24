# Sprint 3 — Durable Orchestrator + Observability v2

## Goal
Make Orchestra **durable** (survives a daemon restart, resuming in-flight work) and make
the Sprint 2 dashboard **genuinely useful** by surfacing a live event feed, per-session
agent activity, and rich (not IDs-only) completion/retry data — all on top of the existing
loopback snapshot API.

Two workstreams:
- **Phase A — Observability v2 + snapshot enrichment** (additive, low risk; lands first).
- **Phase B — Full durability with worker/retry resume** (deep core change; gated behind a
  blocking design spike, #39).
- **Phase C** — tests, docs, handoff.

## Non-negotiable constraints
1. **The snapshot contract stays backward-compatible (strictly additive).** Keep
   `completed: string[]` and `retrying[].due_at_ms` (monotonic) exactly as they are; only
   ADD new fields. The Sprint 2 dashboard's defensive parser must keep working unchanged.
   No `/api/v2` — we are not breaking `/api/v1/state`.
2. **Recent events are observability, NOT scheduling state.** They live in a separate
   `RecentEvents` service, never inside `OrchestratorState`. The snapshot server reads both.
3. **`Observer` is a single Tag, not a multicast bus.** Fan-out is via an explicit *tee*
   observer that both logs (preserving `ObserverLive` logfmt output) and appends to the
   ring buffer. `Layer.merge` does NOT fan out a Tag — do not assume it does.
4. **Reuse `glyphs.ts`** for all statuses/colours in the new dashboard panels.
5. **Durability persistence must be safe:** versioned schema, atomic write (temp + rename),
   corruption → fall back to a clean start (never crash the daemon on a bad state file).
6. The core loop is hardened (Sprint 1 + QA). Phase A touches it only minimally (enrich
   `markCompleted` + capture retry `scheduled_at`/`delay_ms`). Phase B is real core surgery
   and is therefore spike-gated.

## Snapshot contract — ADDITIVE fields only
Existing fields unchanged. New (all optional/defensively-parsed on the client):
- `recent_events: Array<EventEnvelope>` — bounded, newest-last, display-safe:
  `{ seq:int, emitted_at:ISO, level:"info"|"warn", kind:string, issue_id?:string,
  identifier?:string, message:string }` (message truncated at ingestion).
- `recent_completed: Array<CompletedEntry>` — rich completion history (bounded):
  `{ issue_id, identifier, finished_at:ISO, outcome:"completed"|"killed"|... }`.
  (`completed: string[]` stays as the authoritative IDs-only list.)
- `running[].last_activity?` — each running session's last agent activity:
  `{ event_tag:string, at:ISO, message?:string }` (sourced from the loop's runtime
  `LiveSession` bookkeeping; truncated).
- `retrying[].scheduled_at?:ISO` and `retrying[].delay_ms?:int` — captured at schedule
  time so the dashboard can honestly show a wall-clock retry time. `due_at_ms` (monotonic)
  is retained but still never used for a countdown.

## Tasks

### Phase A — Observability v2 + enrichment (additive)
- **#36 — `RecentEvents` ring-buffer service + tee Observer.** New service in
  `src/core/observability/` holding the last N (cap, e.g. 200) display-safe event
  envelopes with a monotonic `seq`. A tee Observer wraps `ObserverLive`: it formats+logs
  exactly as today AND appends a truncated envelope (append must be non-failing and cheap —
  it runs inline on the core-loop fiber). Avoid letting high-volume `AgentEvent`
  observations drown terminal events (consider a kind filter or per-kind cap). Pure
  `Observation → EventEnvelope` mapping, unit-tested.
- **#37 — Snapshot enrichment (additive).** Add `recent_events` (from #36),
  `recent_completed` (enrich `markCompleted` in `loop.ts:410,587` to record
  identifier + wall-clock `finished_at` + outcome into a bounded ring — kept OUT of the
  authoritative `completed` IDs list, e.g. a sibling `RecentCompletions` ring or a small
  bounded state field), `running[].last_activity`, and retry `scheduled_at`+`delay_ms`
  (capture at the `setRetry` site, `loop.ts:~300`). `toSnapshot` reads the extra source(s).
  Keep all existing fields byte-compatible.
- **#38 — Dashboard event-log + activity + rich completed.** New Ink panels: a live
  event-log feed (recent_events, newest-first, glyph+colour by level/kind), per-running-row
  last-activity line, and a rich recent-completed list (identifier + relative finished-at +
  outcome). Extend the defensive `parseSnapshot` + `toViewModel` + components ADDITIVELY
  (new fields optional; absent → omit panel). Honour `--ascii`/`NO_COLOR`. View-model tests.

### Phase B — Full durability with resume (spike-gated)
- **#39 — BLOCKING durability design spike.** Resolve and prove, then STOP for Producer
  review (do NOT build Phase B until authorised). Decide: persistence format (versioned
  `Schema.encode` JSON) + location (a state dir under the workspace root or a configured
  path) + atomic temp+rename + corruption fallback; write trigger (debounced write-through
  on the store `update`/`modify` chokepoint vs periodic); restore→reconcile ORDERING on
  boot; **orphaned running-attempt semantics** — resume the agent thread via the runner's
  `resume:{sessionId}` (requires persisting `session_id`) vs re-dispatch a fresh attempt vs
  release-and-requeue; **retry timer reconstruction** from wall-clock `scheduled_at`+`delay_ms`
  (NOT monotonic `due_at_ms`); on-disk bounding of completed/events. Deliver a throwaway
  proof of the encode→write→read→decode→restore round-trip + a written recommendation.
- **#40 — Persistence layer.** Versioned, atomic, debounced write-through hooked at the
  `OrchestratorStore` mutator chokepoint; corruption-tolerant load. Per the spike decision.
- **#41 — Restore + reconcile on boot.** On startup, load the durable checkpoint, restore
  bookkeeping (completed history, totals, rate-limits, recent events), re-establish in-flight
  running attempts (resume or re-dispatch per #39) and re-arm retry timers from wall-clock,
  then run the normal tracker reconciliation. Emit a clear "restored after restart"
  observation. Per the spike decision.
- **#42 — Session continuity.** Persist the minimum needed (e.g. `session_id`) to support
  the chosen resume semantics; wire it through the runner `resume` path. (May merge into #41
  depending on the spike's resume decision.)

### Phase C — close-out
- **#43 — Tests + docs + handoff.** State round-trip property tests (encode/decode
  fixed-point), restore/reconcile scenario tests (orphaned running, due retry, corrupt
  file), event-ring + enrichment unit tests, dashboard view-model tests. Docs:
  `docs/sprint-3/done.md`, README (durability + new dashboard panels), PROJECT_BRIEF
  §5/§7/§8, resolve relevant backlog items.

## Dependencies
- #37 → #36 (needs RecentEvents) · #38 → #37 (consumes enriched snapshot)
- #40 → #39 · #41 → #40 + #37 (wall-clock retry fields) · #42 → #41 · #43 → all

## Success criteria
- Phase A: dashboard shows a live event feed, per-session activity, and rich completed;
  `/api/v1/state` is strictly additive (Sprint 2 dashboard still parses it unchanged).
- Phase B: kill the daemon mid-run and restart → bookkeeping is intact and in-flight work
  is correctly resumed or safely re-derived (no stranded/duplicated issues); corrupt/missing
  state file → clean start, never a crash.
- All gates 0; core loop changes minimal and reviewed; no regression in the existing suite.

## Risk / cut order (if #39 shows Phase B exceeds one sprint)
Bring the decision to the user at the #39 gate. Natural cut: ship Phase A + the #39 spike in
Sprint 3; move #40–#42 build-out to Sprint 4.

## Deferred backlog (explicitly NOT this sprint)
- Raw agent-stdout log-file tailing (this sprint does the event/activity feed, not raw logs).
- Linear tracker adapter; in-process `--tui`; snapshot historical/forensic timeline beyond
  the bounded recent rings.
