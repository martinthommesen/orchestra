# Sprint 7 — First Contact (Live-Copilot Hardening)

Six sprints in, Orchestra is a durable, legible, fully-controllable daemon — **but it has
never touched a real GitHub repo or a live Copilot CLI.** Every guarantee is proven against
fakes under `TestClock`. The core loop, the adapters, and `map.ts` (the JSONL→`AgentEvent`
mapper) are all pinned to assumptions from the **Sprint 0 spike**, not to observed reality.

Sprint 7 is **production-hardening, not new surface area.** It is the first end-to-end run
against a live agent, and the fixes that first contact forces. Measured against OpenAI's
Symphony `SPEC.md` (the behavioral reference), this closes the "Real Integration Profile"
(§56) carry-forward and resolves two long-open questions (live session-resume, trust
posture) — by _observing_, not assuming.

> **Program chosen:** B (production-hardening), over A (Symphony-parity completion: SSH/
> remote workers, Linear adapter, `/refresh` + per-issue debug endpoints, full file-watcher).
> Rationale: the cockpit is the live operator surface, but nothing here has run for real;
> proving the loop end-to-end de-risks every parity item. A is the _next_ program, not this one.

## Goal

Run the full Orchestra loop against a **real GitHub repo + a live Copilot CLI**, by hand,
once — prove the plumbing, reconcile `map.ts` to the agent's _actual_ output, and resolve
the two open carry-forwards (session-resume, sandbox/approval posture) by observation.

## The spine (locked during grilling)

```
#7 Real integration (manual smoke)  ──►  #6 Session-resume   ──►  #9 Sandbox/approval
   = THE SPINE; everything rides it      = scenario on it        = scenario on it
                                                                  #8 USD ceiling = OFF critical path → follow-up issue
```

Decided: lead with #7 because #6 and #9 are only observable _through_ a working live
harness, and #8 (USD ceiling) is pure orchestrator code with zero live dependency.

## Milestone 1 — Plumbing smoke (#7), the hard gate

A **manual, one-command runbook** (`docs/sprint-7/e2e-smoke-runbook.md`) running the real
daemon against a **throwaway repo** seeded with one **trivial, low-blast-radius issue**
("add one line to `README.md`"). The trivial task is deliberate: this validates **Orchestra's
loop and event plumbing**, not Copilot's coding ability.

**Pass/fail line — gate on plumbing, observe outcome:**

- **MUST PASS (Narrow gate):** boot → load+validate `WORKFLOW.md` → poll → claim → workspace
  create + hooks → spawn Copilot (`cwd` == `workspace_path`) → **stream produces
  non-`Malformed` normalized `AgentEvent`s** → turn completes + token totals populate →
  clean teardown — all reflected live in the cockpit Fleet/Events.
- **OBSERVE, DO NOT GATE (Full outcome):** the agent actually moving the issue to the handoff
  state / opening a PR. That depends on **Copilot's own GitHub tooling + token scopes** (the
  reader-not-writer boundary) — it's the _agent's_ job, not Orchestra's. Capture as an
  observation that feeds Milestone 3.

**The drift mechanic (the whole point of the smoke):** `map.ts` hard-codes the spike's
assumed shape (`type:"result"` + `exitCode`, camelCase `usage`, `assistant.message` /
`data.content`). This is the single most likely thing to have drifted. So:

1. **Tee live Copilot stdout to a file** during the run — capture the _real_ JSONL lines.
2. **Fix `map.ts` against reality** (new `type`s, renamed `usage` fields, different terminal
   signal — whatever shows up). Forward-only: the spike's assumed mapping table in
   `docs/sprint-0/spike-copilot.md` §8 is **superseded**, not kept alongside.
3. **Freeze the captured lines as `map.test.ts` fixtures** under `test/fixtures/copilot-jsonl/`
   (scrubbed for any echoed secrets). The mapper is now pinned to _observed_ output. These
   fixtures are also what make the deferred §56 live suite cheap to build.

## Milestone 2 — Session-resume validation (#6), gated behind Milestone 1 green

Can't test resume-across-restart until one clean live turn works. Scenario: daemon starts a
session → kill the daemon mid-turn → restart → observe whether Copilot honors `--resume` for
our `<thread_id>-<turn_id>` session id across the downtime, vs. the self-heal fresh-turn
fallback against the on-disk workspace.

**Success is asymmetric — either outcome closes the question:**

- **Honored** → document `persistence.resume_sessions` as safe to enable, with evidence.
- **Not honored** (the CLI may not support resume the way the spike assumed — another drift
  check) → `resume_sessions` **stays default-off**, with documented evidence it can't be
  honored.

Either way the "session resume unproven" carry-forward is **resolved, not re-deferred.**

## Milestone 3 — Sandbox / approval trust posture (#9), gated behind Milestone 1 green

Spec §28/§44 + Security Rule #5 ("document the trust posture... state approval/sandbox policy
before any public push") — the README still owes this section. **Doc + flag-pinning, not a
new subsystem:**

1. **Observe** the live agent's default posture (does headless `copilot` write files / run
   shell without prompting? what sandbox is it in?).
2. **Pin** the safest permission/approval flags the `copilot` CLI actually exposes into the
   adapter's spawn args.
3. **Write** the README trust-posture section, grounded in observed behavior.

New orchestrator code **only** if the CLI exposes a flag that must thread through
`WORKFLOW.md` → adapter config — then it's a small additive knob. OS/container/VM sandboxing
(§44) is explicitly **future, noted not built**.

## Non-goals (explicitly deferred — fenced during grilling)

- **The §56 live gated integration suite** (real daemon vs. live GitHub+Copilot behind
  `ORCHESTRA_E2E=1`, skip-reporting, secrets-in-CI, test-repo lifecycle) → **next sprint.**
  It carries real infra cost and shouldn't gate the _learning_. The captured JSONL fixtures
  - `map.ts` fixes from this sprint are precisely what make it cheap. (Pinning the captured
    lines as **unit** fixtures per Milestone 1 _is_ in scope; the **live** suite is not.)
- **#8 USD budget ceiling** (`max_cost_usd` + `usd_per_million_tokens`) → **own follow-up
  issue.** Pure orchestrator code, zero live dependency, fully independent. May run as a
  zero-risk _parallel filler_ while waiting on live runs, but it is **not on the critical path.**
- **Program A entirely** (SSH/remote workers, Linear adapter, `POST /api/v1/refresh`,
  per-issue debug endpoint `/api/v1/<identifier>`, general out-of-band file-watcher) — the
  next program, once single-host real runs are solid.

## Settled forward-only decisions — NOT gaps, do not backfill

These spec items are deliberate, settled deviations. The plan must not try to "complete" them:

- **Durable orchestrator state** — spec §47 says _no_ durable DB; we built a superset (Sprint 4).
- **GitHub-not-Linear · Copilot-not-Codex** — pinned in Sprint 0 / the brainstorm.
- **Reader-not-writer** — the agent does ticket/PR writes via its own tools. "No PR
  write-back" is _"is Copilot's GitHub tooling wired"_ (a Milestone-3 observation), **not**
  an Orchestra code gap.

## Deliverables

- `docs/sprint-7/e2e-smoke-runbook.md` — turnkey, one-command manual procedure (env vars,
  test-repo + seeded issue setup, `WORKFLOW.md`, the tee-to-file capture step). Repeatable by
  hand; also the spec for the deferred §56 suite.
- `map.ts` reconciled to observed CLI output; `docs/sprint-0/spike-copilot.md` §8 mapping
  table superseded.
- `test/fixtures/copilot-jsonl/*` (scrubbed) + `map.test.ts` pinned to them.
- README trust-posture section; any pinned adapter spawn flags.
- `persistence.resume_sessions` guidance updated with live evidence (enable-safe or
  stays-off-because).
- `docs/sprint-7/progress.md` + `done.md`; PROJECT_BRIEF §7–§8 updated at close.

## Tracking

GitHub Issues if the remote exists, else `docs/sprint-7/progress.md` (brief §13). Open issues
now for the two deferrals (**USD ceiling**, **§56 live gated suite**) so they're not lost,
plus one per real drift bug surfaced by the smoke.

## Definition of done

1. Manual plumbing smoke is **green** (Narrow gate) and reproducible from the runbook.
2. `map.ts` matches observed CLI output; captured fixtures pin it; spike table superseded.
3. #6 resolved — `resume_sessions` documented enable-safe **or** stays-off-with-evidence.
4. #9 resolved — trust posture observed, safest flags pinned, README section written.
5. Deferrals filed as issues; brief + sprint docs updated per the handoff protocol.
