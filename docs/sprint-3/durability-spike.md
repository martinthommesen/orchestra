# Sprint 3 / #39 — Durability Design Spike (BLOCKING gate)

> **Status: design only.** This document resolves and proves the Phase B durability design.
> It does **not** implement #40/#41/#42. The Phase-B in/out decision is a Producer + user
> call at this gate. Engineers should be able to build #40–#42 directly from §2.

Authors: Sage (lead, core/durability), with Nova (state/registry) and Milo (operator-facing
"restored" surfacing).

---

## 1. Current-state analysis

### 1.1 The authoritative state and where it lives

`OrchestratorState` is a `Schema.Struct` — `src/core/domain/orchestrator-state.ts:21-38`:

```
poll_interval_ms      : Int
max_concurrent_agents : Int
running               : Record<string, RunAttempt>   // issue_id -> running attempt
claimed               : string[]                     // reserved/running/retrying claim set
retry_attempts        : Record<string, RetryEntry>   // issue_id -> scheduled retry
completed             : string[]                     // bookkeeping IDs (does NOT gate dispatch)
agent_totals          : AgentTotals                  // input/output/total tokens + runtime_s
agent_rate_limits     : Unknown | null               // vendor-shaped passthrough
```

It is held behind the `OrchestratorStore` service (`Context.Tag`) backed by a single `Ref`
— `src/core/orchestrator/state.ts:136-158`. The store exposes exactly three operations:
`get` (safe concurrent read, used by the snapshot server), `update`, `modify`. The
**single-writer invariant** holds: only the owner loop fiber mutates; the snapshot server
only reads. All mutations are pure `OrchestratorState -> OrchestratorState` functions
(`claim`, `setRunning`, `clearRunning`, `setRetry`, `clearRetry`, `markCompleted`,
`release`, `addUsage`, `setRateLimits` — `state.ts:54-127`).

**`update`/`modify` are the single mutation chokepoint** — this is where a transparent
write-through persistence hook belongs (§2.4). `layerOrchestratorStore(config)`
(`state.ts:161`) seeds the Ref with `initialState(config)` (all-zero/empty).

### 1.2 The loop and its runtime-only registry

`runOrchestrator` (`src/core/orchestrator/loop.ts:120-703`) is the single state-owning
fiber: a `Queue<Msg>` mailbox drained by exactly one fiber that applies every mutation
serially. Workers and timers never touch state — they post `Msg` (`messages.ts`:
`Tick | AgentEvent | WorkerDone | RetryDue`).

Crucially, a second piece of state lives **entirely outside** `OrchestratorStore`: the
runtime `registry: Map<string, IssueRuntime>` (`loop.ts:139`). `IssueRuntime`
(`loop.ts:62-76`) holds:

```
issue            : Issue
workspace        : Workspace | null
workerFiber      : Fiber | null     // NON-SERIALIZABLE
timerFiber       : Fiber | null     // NON-SERIALIZABLE
sessionId        : string | null    // <-- only durable record of the agent thread id
turnCount        : number           // clean turns done; gates continuation vs max_turns
failureAttempts  : number           // drives exponential backoff
lastEventAt      : number           // MONOTONIC ms; stall detection
pendingKind      : "failure" | "continuation" | null  // how RetryDue should re-dispatch
pendingAttempt   : number
```

The registry is touched only by the owner fiber, so it needs no synchronization — but it is
**purely in-memory** and is rebuilt from scratch on every process start. Several fields here
(`sessionId`, `turnCount`, `failureAttempts`, `pendingKind`/`pendingAttempt`) are **not**
present anywhere in the persisted `OrchestratorState` schema. That gap is the heart of the
durability design (§2.2).

Dispatch sites:
- `dispatch` (`loop.ts:207-280`) — computes workspace path, writes `setRunning(clearRetry(...))`
  into the store with a `RunAttempt` (status `PreparingWorkspace`), forks the `workerEffect`
  fiber, records `rec.workerFiber`. For continuation it builds
  `resume = isCont && rec.sessionId !== null ? { sessionId } : null` (`loop.ts:266`).
- `handleAgentEvent` (`loop.ts:559-584`) — on `SessionStarted` sets `rec.sessionId = event.session_id`
  (this is where the session id first becomes known), accumulates usage, flips the running
  attempt to `StreamingTurn`.
- `markCompleted` is called at two sites: `TerminalKill` reconcile (`loop.ts:419`,
  `outcome:"killed"`) and `WorkerDone`/`Completed` past `max_turns` (`loop.ts:601`,
  `outcome:"completed"`).
- `scheduleRetry` (`loop.ts:284-336`) — the retry/continuation scheduler (see §1.3).

### 1.3 Retry scheduling — monotonic vs wall-clock (the central trap)

`scheduleRetry` (`loop.ts:295-326`) computes a `delay` (continuation = `CONTINUATION_DELAY_MS`;
failure = `failureBackoffMs(attempt, max_retry_backoff_ms)`) and then writes a `RetryEntry`:

```
due_at_ms    = mono + delay            // MONOTONIC clock (clock.monotonicMillis)
scheduled_at = new Date(wall)          // WALL-CLOCK at schedule time (#37, optional Date)
delay_ms     = delay                   // backoff applied (#37, optional Int)
```

and forks a timer fiber: `Effect.sleep(Duration.millis(delay)) >> Queue.offer(RetryDue)`.

`RetryEntry` (`retry-entry.ts:9-27`): `due_at_ms` is documented as a **monotonic** value,
immune to wall-clock jumps but **meaningless across a process restart** — `monotonicMillis`
delegates to Effect's `Clock` (`ports/clock.ts`) whose origin resets per process. By contrast
`scheduled_at + delay_ms` is an **absolute wall-clock fire instant** and is the only
restart-safe way to reconstruct a timer. Phase A captured `scheduled_at`/`delay_ms` precisely
so durability could re-arm honestly. **This is the recurring trap and the single most
important constraint of §2.5: re-arm from `scheduled_at + delay_ms`, never from `due_at_ms`.**

`RetryEntry` also does **not** record `kind` (failure vs continuation). At runtime,
`handleRetryDue` (`loop.ts:626-640`) decides re-dispatch shape from `rec.pendingKind` in the
registry — which is not persisted. So to reconstruct a retry across restart we must persist
the kind (and, for continuation, the session id). See §2.2.

### 1.4 Session handling and resume

`session_id` originates in the Copilot runner (`copilot-runner.ts:49`): first turn pins a
generated `randomUUID()` via `--session-id`; a resumed turn passes `--resume <sessionId>`
(`copilot-runner.ts:64`). The runner emits a `SessionStarted` event carrying that id first
(`copilot-runner.ts:88-95`), which the loop captures into `rec.sessionId`
(`loop.ts:566-568`). The `AgentRunner` port already accepts
`resume?: { sessionId }` (`ports/agent-runner.ts:20`) — **resume plumbing exists end to end**;
what is missing for durability is that the session id is never persisted (it lives only in the
registry), so after a restart no running issue can be resumed.

Today resume is used only for in-process continuation turns (turn > 1 of the same daemon
lifetime). The Copilot session itself lives in Copilot's own store, external to Orchestra;
its liveness/expiry across a daemon downtime is **not guaranteed** — a key risk for any
"resume across restart" policy (§2.6).

### 1.5 The observability rings

Three sibling services, each a separate `Ref`-backed bounded buffer, read by the snapshot
server, deliberately **outside** `OrchestratorState` (constraint #2 — "observability, NOT
scheduling state"):

- `RecentEvents` — cap **200** display-safe event envelopes (`recent-events.ts:24`).
- `RecentCompletions` — cap **50** rich finished-issue records (`recent-completions.ts:15`).
- `LiveActivity` — cap **256** per-issue last-agent-activity, **updated on every `AgentEvent`**
  (the highest-frequency mutation in the system) (`live-activity.ts:18`).

### 1.6 Exactly what is LOST on a daemon restart today

Because `OrchestratorStore` is in-memory only and the registry is rebuilt empty, a restart
re-seeds `initialState(config)` and loses **everything**:

1. **All bookkeeping** — `completed` IDs, `agent_totals` (tokens/runtime), `claimed`,
   `agent_rate_limits`. History resets to zero.
2. **In-flight retries** — every `retry_attempts` entry and its timer fiber. A retry that was
   30s from firing simply never fires.
3. **Running attempts** — the `running` map and every `workerFiber`. The Copilot subprocesses
   are children of the daemon; on a clean SIGTERM they are torn down by scope finalizers
   (`copilot-runner.ts` `Command.start` scope), on SIGKILL they may be orphaned OS processes.
4. **Session continuity** — `rec.sessionId` for every issue. No thread can be resumed.
5. **Continuation/backoff progress** — `turnCount`, `failureAttempts`, `pendingKind`.
6. **Observability rings** — `RecentEvents`/`RecentCompletions`/`LiveActivity` all reset; the
   dashboard history is blank after restart.

**Important nuance — there is an implicit recovery today, and it is also the source of the
hardest problem.** Because `claimed` resets empty, the next poll tick re-selects any issue
still in an active tracker state and **re-dispatches it fresh** — so work is not permanently
stranded, but it: loses turn/backoff continuity, loses session context, double-counts nothing
(totals reset), and *could* race a still-alive orphaned subprocess from the previous run.
**Once we persist `running` (#40), this implicit safety net inverts into a hazard:** on
restart we will have `running` entries with **no live fiber and no live subprocess** — the
classic *orphaned running attempt*. Reconciling those safely (§2.4) is the riskiest part of
Phase B.

---

## 2. Proposed design

### 2.1 What to persist — and the observability-rings in/out call

**Persist:** the authoritative `OrchestratorState` (running / claimed / retry_attempts /
completed / agent_totals / agent_rate_limits / poll+concurrency knobs) **plus** the minimal
registry-derived continuity needed to correctly resume/re-arm in-flight work (session id,
turn count, failure attempts, retry kind — see §2.2).

**Exclude (RECOMMENDATION): the in-memory observability rings stay OUT.**
`RecentEvents` (200), `RecentCompletions` (50), and `LiveActivity` (256) are **not**
persisted. On boot they start empty.

Justification:
- **Boundary integrity.** Constraint #2 makes these "observability, NOT scheduling state".
  They can never influence dispatch; persisting them would blur a boundary the architecture
  deliberately draws, and would couple three independent services into the durable contract.
- **Write-payload / thrash.** `LiveActivity` mutates on **every** `AgentEvent` — by far the
  highest-frequency mutation. Folding the rings into the durable payload would make the
  hottest event in the system also the heaviest to persist, defeating debouncing (§2.3) and
  bloating each write by up to ~500 records vs. the typically tiny core state (a handful of
  running/retry entries + counters).
- **Low value.** Post-restart dashboard *history* is cosmetic. The feed repopulates within
  one or two ticks of resumed activity; completed IDs (the authoritative list) **are** restored
  via core state, so counts are correct immediately. We lose only a few minutes of scrollback.
- **Complexity.** Each ring is its own `Ref`/service; persisting them means three more
  load/restore paths and three more schema-versioned shapes, for cosmetic gain.

**Operator affordance (Milo):** on a successful restore, emit one synthetic
`RecentEvents` entry — `kind:"restored"`, `level:"info"`,
`"restored after restart: N running, M retrying, K completed"` — plus a `Started`-class
observation, so the otherwise-empty feed honestly explains the gap. (`toEventDraft` would gain
one additive case; alternatively append directly via `RecentEvents.append` at boot.)

### 2.2 Schema + versioning

The persisted file is a **superset** of the snapshot: it carries the full `OrchestratorState`
*plus* a continuity sidecar that the `/api/v1/state` snapshot never exposes (keeping the
snapshot contract pristine — no v2, no regression to Phase A / Sprint 2 dashboard).

Two ways to carry the continuity fields; we recommend **Option A**.

**Option A (recommended) — promote continuity into the domain schemas (additive).**
Single source of truth = the store; persistence stays a transparent store decorator (§2.4)
with zero new bookkeeping. Additive, backward-safe schema changes:

- `RunAttempt` gains: `session_id?: string | null`, `turn?: Int`, `failure_attempts?: Int`.
  Populate `session_id` by folding it into the **existing** `store.update` in
  `handleAgentEvent` on `SessionStarted` (`loop.ts:566`); populate `turn`/`failure_attempts`
  at the **existing** `setRunning` site in `dispatch`.
- `RetryEntry` gains: `kind?: "failure" | "continuation"`, `session_id?: string | null`.
  Populate at the **existing** `setRetry` site in `scheduleRetry` (the same Phase-A site).

These are optional/additive: they appear in the snapshot too, but additively (the defensive
client parser ignores unknown/absent fields — Phase A already proved this). The registry
becomes a *runtime cache* of what the store now durably owns.

**Option B (alternative) — sidecar map, snapshot untouched.** Keep a `runtime` map in the
persisted file only, assembled at write time by reading the registry. Lower schema churn but
re-introduces a second source of truth and forces the persistence layer to see registry
internals (which are loop-private). We prefer A for single-source-of-truth and testability.

**Versioned persisted shape** (`PersistedState`, a new `Schema.Struct`):

```
PersistedStateV1 = {
  version  : Literal(1),
  saved_at : Date,                 // wall-clock at write; diagnostic only
  state    : OrchestratorState,    // the authoritative serializable view (Option A fields incl.)
}
```

(Under Option B add `runtime: Record<string, { session_id, turn_count, failure_attempts,
pending_kind, pending_attempt }>`.)

**Serialization is via `Schema`, not raw `JSON.stringify`** — this is what makes `Date`s
round-trip as ISO strings and validates on the way back in:

```
const Persisted = Schema.parseJson(PersistedStateV1);   // string  <-> typed
const encode = Schema.encode(Persisted);                // typed   -> JSON string  (ISO dates)
const decode = Schema.decodeUnknown(Persisted);         // unknown -> typed | ParseError
```

**Forward-only migration.** `decodePersisted(raw): Effect<PersistedStateV1, ParseError>`
first reads the `version` discriminant, then runs the matching decoder and applies a chain of
pure `migrateV1toV2`, `migrateV2toV3`, … transforms up to the current version. We never write
an older version. A bump is required whenever a field's *meaning* changes incompatibly; purely
additive optional fields do **not** require a bump (older files decode, missing optionals stay
absent).

**Non-serializable / hazardous values:**
- **Fibers** (`workerFiber`, `timerFiber`) — never in any schema; excluded by construction.
- **Dates** (`RunAttempt.started_at`, `RetryEntry.scheduled_at`, `saved_at`) — `Schema.Date`
  encodes to ISO; decoding validates. Never hand-roll `new Date(...)` on read.
- **Monotonic `due_at_ms`** — a plain `Number`; it serializes fine but its *value* is invalid
  after restart. Persist it (harmless) but **§2.5 forbids using it on restore.**
- **`agent_rate_limits: Unknown`** — vendor JSON passthrough parsed from agent events, so it
  is already JSON-shaped. `Schema.parseJson` will round-trip it; add a defensive guard so a
  pathological non-JSON value can never fail the *whole* write (fall back to `null` for that
  field, log a warning). Corruption of this one field must never lose the rest of the state.

### 2.3 Write strategy — atomic + debounced

**Location.** A dedicated state dir, default `<workspace.root>/.orchestra/` (workspace.root
already resolves to an absolute path — default `<system-temp>/orchestra_workspaces`,
`workflow.ts:55-62`). File: `<state_dir>/state.json`; temp sibling `state.json.tmp`.
A `.orchestra/` dotdir does not collide with the per-issue workspace subdirs that
`startupCleanup` manages. Add an **optional** config block
`persistence?: { dir?: string; debounce_ms?: PositiveInt (default 500) }` (additive,
all-defaults so an unchanged `WORKFLOW.md` still decodes).

**Atomicity (crash-safety mid-write).** Always *write-temp-then-rename*:
`fs.writeFile(tmp, json)` → `fs.rename(tmp, state.json)`. `rename(2)` is atomic on a single
filesystem, so a reader (or a crash) ever sees either the complete old file or the complete
new file — never a half-written one. Keeping `tmp` in the **same directory** guarantees a
same-filesystem rename. (Optional hardening: `fsync` the temp fd before rename; likely
unnecessary for our durability goal and skippable.) Use `@effect/platform` `FileSystem`
(already available via `NodeContext.layer` in `daemon.ts:88`) so it stays inside Effect.

**Debounce (no thrash).** A single long-lived **writer fiber**, forked scoped:
- The store decorator (§2.4) signals "dirty" after each `update`/`modify` — via a
  `Queue.sliding<void>(1)` (coalescing) or a `Ref<boolean>` flag.
- Writer loop: take the dirty signal → `Effect.sleep(debounce_ms)` → `store.get` → encode →
  atomic write → clear dirty. Bursts within a tick (a `handleTick` can issue many `update`s)
  collapse into at most one write per `debounce_ms` (~500ms default).
- **Guaranteed final flush.** A scope finalizer (`Effect.ensuring` on the writer / the layer's
  acquireRelease) performs one last synchronous-style write on shutdown, so the most recent
  state is durable even on SIGTERM. (On SIGKILL we lose at most the last `debounce_ms` of
  mutations — acceptable; the next-tick reconcile corrects any drift.)

**Trigger placement = the store mutator chokepoint, transparently.** Persistence hooks into
`OrchestratorStore.update`/`modify` (§2.4), **not** sprinkled through `loop.ts`. This keeps
core-loop surgery minimal: #40 changes only the *layer wiring* in `daemon.ts` and adds new
files; the loop keeps calling the same `store` API.

### 2.4 Restore + reconcile on boot (#41)

The durable store is provided by a new `layerDurableOrchestratorStore(config)` that **replaces**
`layerOrchestratorStore(config)` in `appLayer` (`daemon.ts:43`). It:

1. **Load.** `persistence.load`:
   - file missing → `Option.none` → seed `initialState(config)` (cold start, registry empty).
   - file present → `decodePersisted`. On **any** decode/parse failure → log a warning, emit a
     `tracker_error`-class observation, **rename the bad file to `state.json.corrupt-<ts>`**,
     and fall back to `initialState` (constraint #5: corruption ⇒ clean start, **never crash**).
   - success → the restored `OrchestratorState`.
2. **Seed the Ref** with the restored (or initial) state.
3. **Wrap** `update`/`modify` to mark-dirty after applying; **fork** the scoped writer fiber
   with the final-flush finalizer (§2.3). `get`/`update`/`modify` signatures are unchanged →
   `loop.ts` and `snapshot-server.ts` are untouched.

Then, inside `runOrchestrator` **startup** (the one place #41 adds real loop code — additive
to the block at `loop.ts:682-689`, *before* the first `Tick`):

4. **Rebuild the registry** from the restored store. For each `running[id]` and each
   `retry_attempts[id]`, create an `IssueRuntime` with `workerFiber=null`, `timerFiber=null`,
   and `sessionId`/`turnCount`/`failureAttempts`/`pendingKind`/`pendingAttempt` taken from the
   restored continuity fields (§2.2). `lastEventAt = now (monotonic)` so a freshly-restored
   issue is not instantly stall-killed.
5. **Re-arm retries** from wall-clock (§2.5).
6. **Convert orphaned running → due continuation retries** (orphan policy below).
7. **Emit `RestoredAfterRestart`** (counts) + the synthetic `RecentEvents` entry (§2.1).
8. Continue the **existing** startup: `startupCleanup` (`loop.ts:657-680`) then the first
   `Tick`. The normal per-tick `reconcile` (`loop.ts:461-506`) — tracker refresh of all
   running+retrying ids — is the **safety net**: anything that went terminal or vanished while
   the daemon was down is `TerminalKill`/`NeitherKill`'d before any re-dispatch wastes work.

**Ordering rationale:** restore (seed + registry) → re-arm/convert (so the issues exist as
*retrying*, not *running-with-no-fiber*) → first tick reconcile (tracker truth corrects stale
state) → dispatch. This guarantees we never re-dispatch an issue that already finished, and we
never leave a "running" entry with no backing fiber.

#### Orphaned-running reconcile policy — the headline decision

A persisted `running[id]` has, post-restart, **no worker fiber and no live subprocess**.
Options weighed:

| Policy | Pro | Con |
|---|---|---|
| (a) **Resume** via `--resume {session_id}` | preserves agent's in-conversation context, fewer tokens | depends on Copilot session still being alive across downtime (external, **unverified**); may duplicate a turn that half-finished before the crash |
| (b) **Re-dispatch fresh** (new session, full prompt) | simple, robust | loses agent context; re-reasons the current turn |
| (c) **Release + requeue** (drop, let next tick re-select) | trivial | loses `turn_count`/`failure_attempts` continuity; resets attempt accounting; matches today's lossy behavior |

**RECOMMENDATION — (b′) re-dispatch as a *continuation*, reusing the persisted workspace,
with session resume as an optional best-effort optimization.**

The key insight: **the durable, authoritative record of agent progress is the workspace on
disk (the git working tree), not Copilot's in-memory session.** A continuation turn against
the same workspace recovers the real work without depending on session liveness. So:

- **Mechanically, reduce the orphan to existing machinery:** for each restored-`running` issue,
  `clearRunning` it and `setRetry` a **continuation** retry that is **due immediately**
  (`scheduled_at = now`, `delay_ms = 0`, `kind = "continuation"`, `attempt = turn_count + 1`,
  carry `session_id`). Set `rec.pendingKind="continuation"`, `rec.pendingAttempt=turn_count+1`.
  This makes the orphan a *retrying* issue, which means it automatically gets:
  - **reconcile protection** — the first tick's reconcile sees it among `retrying` ids; if the
    tracker says terminal → `TerminalKill` (no re-dispatch), neither/vanished → release,
    active → leave it to fire. No bespoke orphan-dispatch code, no double-dispatch.
  - **re-dispatch via the existing `handleRetryDue`** continuation path (`loop.ts:635-636`).
- **Session resume is optional and self-healing.** Default = **fresh session** for the resumed
  continuation turn (no `--resume`), because Copilot session liveness across a restart is not
  guaranteed and the workspace carries the progress. If `persistence.resume_sessions === true`
  **and** `session_id` is present, pass `resume:{sessionId}`; if Copilot rejects an
  unknown/expired session the worker fails → normal failure-backoff → eventually a fresh turn.
  So resume can only help, never strand.

This makes the **riskiest** part of Phase B (orphan handling) ride entirely on already-tested
machinery (retry re-arm + reconcile + continuation dispatch), and decouples correctness from
the one external unknown (Copilot session liveness).

### 2.5 Retry re-arm across restart — re-derive from WALL-CLOCK, never monotonic

**This is the single most important, most-trapped design point.** For every restored
`retry_attempts[id]`:

```
fireInstant = scheduled_at.getTime() + delay_ms      // absolute wall-clock ms (restart-safe)
remaining   = fireInstant - Date.now()               // wall-clock remaining
```

- `remaining <= 0`  → the retry is already due → enqueue `RetryDue` immediately (or fork a
  delay-0 timer). Reconcile still gates it (it's a retrying id).
- `remaining > 0`   → fork a timer `Effect.sleep(Duration.millis(remaining)) >> RetryDue`,
  exactly like `scheduleRetry` but with the **residual** delay. Record it as `rec.timerFiber`.
- `scheduled_at`/`delay_ms` absent (only possible for a pre-#37 file, which durability will
  never write) → fire immediately (defensive).

**Never** read `due_at_ms` on restore — it was relative to the dead process's monotonic origin
and is now garbage. (It is retained in the schema only for snapshot byte-compatibility and is,
as ever, never turned into a countdown.) Reconstruct `rec.pendingKind`/`pendingAttempt` from
the persisted `RetryEntry.kind`/`attempt` (§2.2) so `handleRetryDue` re-dispatches the correct
shape (fresh vs continuation).

### 2.6 Session continuity (#42)

- **Persist `session_id`** on `RunAttempt` (set in `handleAgentEvent` on `SessionStarted`) and
  carry it onto `RetryEntry` at `setRetry` for continuation retries (§2.2). This is the
  minimum needed for resume.
- **Resume policy:** default **fresh** session on reconcile/restore (workspace-on-disk is the
  source of truth); opt-in best-effort `--resume` behind `persistence.resume_sessions`
  (§2.4). The runner already supports `resume:{sessionId}` (`agent-runner.ts:20`,
  `copilot-runner.ts:64`) — #42 is mostly (a) the additive schema fields, (b) threading
  `session_id` into the continuation `dispatch`’s `resume`, (c) the config flag. **#42's schema
  work folds naturally into #41**; its runtime flag is a thin add.
- **Risk to flag:** Copilot owns the session lifecycle; we have not verified that `--resume`
  honors a session after an arbitrary daemon downtime. Keeping the default **off** (fresh)
  contains this risk to an opt-in path.

### 2.7 Effect idioms & contract compatibility

- **`Persistence` service** (`Context.Tag`) — `load: Effect<Option<PersistedStateV1>>`,
  `save: (PersistedStateV1) => Effect<void>` (atomic), plus an internal dirty-signal +
  scoped writer fiber. Backed by `@effect/platform` `FileSystem` (ambient via
  `NodeContext.layer`). New files under `src/core/persistence/` (`persistence.ts`,
  `persisted-state.ts`).
- **Transparent store decorator** — `layerDurableOrchestratorStore(config)` wraps the existing
  store: load→seed→wrap-mutators→fork-writer (§2.4). It is a drop-in for
  `layerOrchestratorStore` in `appLayer` (`daemon.ts:43`); `get`/`update`/`modify` are
  unchanged so `loop.ts` and `snapshot-server.ts` need no edits for #40.
- **Writer lifecycle** — `Effect.forkScoped` + `Effect.ensuring`/`acquireRelease` final flush,
  so the writer is torn down (and flushes) with the orchestrator scope, consistent with how
  the snapshot server and workers are already scoped (`daemon.ts:78-85`).
- **Additive snapshot contract preserved** — persistence reads the same `OrchestratorState`;
  `toSnapshot` is untouched; the new optional `RunAttempt`/`RetryEntry` fields are additive to
  `/api/v1/state` (defensive client ignores them). **No `/api/v2`, no Phase-A / Sprint-2
  regression.** The observability rings stay ephemeral and out of the durable contract (§2.1).
- **Determinism** — all clocks already go through the `Clock` port / Effect `Clock`, and the
  writer uses `Effect.sleep`, so the whole durability path is `TestClock`-controllable (round-
  trip and re-arm tests can run with virtual time, matching the existing suite's style).

### 2.8 Throwaway round-trip proof (encode → write → read → decode → restore)

A throwaway proof (to live as a `*.spec` under #43, not shipped from this spike) validates the
fixed point. Pseudocode:

```ts
const s0 = someOrchestratorState({ running, retry_attempts (scheduled_at+delay_ms), completed,
                                   totals, rate_limits });
const p0 = { version: 1, saved_at: new Date(), state: s0 };
const json = yield* Schema.encode(Schema.parseJson(PersistedStateV1))(p0); // Dates -> ISO
yield* fs.writeFile(tmp, json); yield* fs.rename(tmp, file);               // atomic
const raw  = yield* fs.readFileString(file);
const p1   = yield* Schema.decodeUnknown(Schema.parseJson(PersistedStateV1))(raw);
assert.deepEqual(p1.state, s0);                       // fixed point (Dates equal as Dates)
// re-arm: for each retry, fireInstant = scheduled_at+delay_ms; remaining vs TestClock.now
// corrupt case: write "{ not json", decode -> ParseError -> fallback initialState, no throw
```

Expected: `p1.state` deep-equals `s0` (Schema guarantees the Date↔ISO fixed point); the corrupt
input yields a `ParseError` that the loader maps to a clean start. This is mechanical given the
existing `Schema.decodeUnknown` usage in `loader.ts:100` — no novel Effect machinery required,
which is the main evidence the design is low-mechanism-risk.

---

## 3. Sizing recommendation

### Per-issue risk / effort

| Issue | Scope | Effort | Risk | Notes |
|---|---|---|---|---|
| **#40** Persistence layer | versioned `Schema` codec, atomic temp+rename, debounced scoped writer, corruption→clean-start, store decorator, optional `persistence` config | **M (~1–1.5d)** | **Low–Med** | Mostly self-contained new files + one `daemon.ts` layer swap; `OrchestratorState` schema already exists. Risks: debounce + final-flush correctness; same-fs rename; `agent_rate_limits:Unknown` guard. No loop surgery. |
| **#41** Restore + reconcile + re-arm | load→seed→registry rebuild; **orphan→due-continuation-retry**; **wall-clock re-arm**; boot ordering vs first reconcile; idempotency (no double-dispatch); `RestoredAfterRestart` | **H (~2–3d incl. tests)** | **High** | The real core surgery, in `runOrchestrator` startup. Hardest correctness: orphan reconcile + re-arm + ordering. Needs scenario tests (orphan active/terminal/vanished, due/future retry, both kinds). **Riskiest item of Phase B.** |
| **#42** Session continuity | additive `session_id`/`kind` on `RunAttempt`/`RetryEntry`; thread `session_id` into continuation `resume`; `resume_sessions` flag; best-effort/self-healing resume | **S–M (~0.5–1d)** | **Med (Low if default-off)** | Runner already supports `resume`. Schema part folds into #41. Risk is purely the external Copilot session-liveness unknown — contained by defaulting resume **off** (fresh). |
| **#43** Tests + docs + handoff | round-trip property test (encode/decode fixed point), restore scenarios, corruption→clean-start, wall-clock re-arm, `done.md`/README/PROJECT_BRIEF | **M (~1–1.5d)** | **Low** | Mechanical given §2.8; high value as the regression guard for #41. |

**Total: ~5–7 days of focused core work.**

### Does Phase B fit the remaining Sprint 3?

**Recommendation: roll the Phase-B *build* (#40–#42) to Sprint 4; close Sprint 3 as
Phase A + this #39 spike.**

Rationale: Phase A already consumed sprint capacity, and Phase B is ~a full sprint of deep
core work whose centre of gravity (#41: orphaned-fiber reconcile, wall-clock re-arm,
boot-ordering idempotency) is exactly the kind of subtle, scenario-heavy core surgery that
should **not** be rushed at sprint-end. Rushing #41 risks stranded or duplicated issues —
the precise failure mode durability exists to prevent. The spike has de-risked the design
(reducing orphans to existing retry/reconcile machinery; resume made optional), but the
implementation still wants a clean sprint and careful review.

**If the user wants durability value *this* sprint — the safe, high-value slice:**
ship **#40 + a *minimal* restore** = persist and restore **bookkeeping** (`completed`,
`agent_totals`, `claimed`, `agent_rate_limits`) and **re-arm retries from wall-clock** (§2.5),
**but defer orphan resume**: on boot, treat orphaned `running` with policy (c)
*release-and-requeue* (drop running + unclaim, let the normal tick re-dispatch via the tracker
— exactly today's behavior, zero new risk). This delivers "history + in-flight retries survive
a restart" at **Low** risk, and defers the genuinely hard, high-value parts — full
orphan→continuation reconcile (#41) and session resume (#42) — to Sprint 4 where they get the
test coverage and review they need.

**Riskiest parts to call out for the user:** (1) orphaned-fiber reconcile + boot ordering
idempotency (#41); (2) atomic+debounced persistence with a guaranteed shutdown flush (#40);
(3) resume semantics against an external, unverified Copilot session lifecycle (#42 — mitigated
by default-off fresh sessions and workspace-on-disk as the true source of progress).
