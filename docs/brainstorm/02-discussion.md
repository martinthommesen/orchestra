# Brainstorm — Phase 2: Discussion & Refinement

> Agents debate, combine, and challenge the Phase 1 ideas. They reference each
> other by name. At least two genuine disagreements are resolved here.

---

## Disagreement #1 — Effect everywhere, or Effect with an escape hatch?

**Nova:** I'll say it plainly — Effect is the right engine but the wrong onboarding
story if we're dogmatic. New contributors will hit `Layer`, `Fiber`, and tagged
errors all at once. I want a Promise-friendly seam at the CLI boundary.

**Sage:** Disagree on the framing. The seam you want is exactly where bugs hide.
Symphony's hardest requirements are _typed errors_, _bounded concurrency_, and
_retry with backoff and cancellation_. Those are Effect's home turf —
`Effect.Schedule`, `Effect.fork`, `Effect.Scope`. If we drop to Promises at the
edge, we lose cancellation propagation into the agent subprocess. That's not a style
preference, it's correctness.

**Nova:** Cancellation I'll grant you. My worry is the _learning cliff_, not the
semantics.

**Ivy:** From a testing seat, Effect actually _helps_ me — `@effect/vitest` plus a
`TestClock` means I can fast-forward 5 minutes of backoff in a unit test without
sleeping. A Promise boundary would force real timers into tests. I'm with Sage on
the core.

**Remy:** Resolution: **Effect all the way through the core and the CLI.** We pay
down Nova's concern with docs, not architecture — an `docs/effect-guide.md` and a
"good first issue" path that touches a single service. Nova owns that guide so the
person who's most skeptical writes the onramp.

**Nova:** Acceptable. If I'm writing the guide, I get to keep the public service
interfaces small and obvious. Deal.

---

## Disagreement #2 — Drive Copilot as a subprocess, or via the in-process SDK?

**Dash:** Subprocess. One Copilot child process per issue, cwd pinned to the
workspace, killable by PID. It mirrors the spec's process model and gives me crash
isolation and resource accounting for free. If the SDK throws in-process, it can
take a fiber — or the daemon — with it.

**Sage:** The SDK gives us _structured_ events. Parsing a CLI's stdout/JSON stream
is the exact brittleness Ivy flagged — we'd be reverse-engineering a framing format.
In-process I get typed turn/tool/usage events directly.

**Kira:** And the SDK is the more "GitHub-native" story — it's literally the
supported integration path. From a DX angle I lean Sage.

**Dash:** Counter: the spec's entire safety model is _workspace isolation_ +
_`cwd == workspace_path`_ + _sandboxed turns_. That's far cleaner to enforce around a
child process than around an in-process call sharing our heap and env.

**Ivy:** Both are testable **if** they sit behind one `AgentRunner` port and I can
substitute a `FakeAgentRunner`. What I refuse to accept is the orchestrator importing
either Copilot integration directly.

**Nova:** Agreed — and note we don't actually _know_ the SDK's current event surface.
We're speculating.

**Remy:** Resolution: **don't decide it in a brainstorm.** Sprint 0 ships a timeboxed
**spike** that pins the real Copilot integration surface (SDK _and_ headless
`copilot` CLI), behind the `AgentRunner` port. v1 _default_ is the **subprocess**
for Dash's isolation; the SDK becomes a swap-in once the spike de-risks it. The port
makes the decision reversible, which is the whole point.

**Sage:** I can live with subprocess-first as long as the event model the
orchestrator consumes is the _typed, normalized_ one — the runner translates raw
Copilot output into our `AgentEvent` schema. The orchestrator never sees raw stdout.

**Dash:** Yes. Runner owns the mess; orchestrator sees clean events.

---

## Smaller debates (resolved quickly)

**Tracker — GitHub Issues vs Linear (Kira vs Sage):**

- **Kira:** GitHub Issues, obviously — our agent is Copilot.
- **Sage:** Fine, but the spec is _Linear-shaped_. If we contort the port to GitHub's
  model we lose parity and the "drop-in Symphony" story.
- **Resolution (Remy):** Ship the **GitHub Issues adapter** for v1, but keep the
  `IssueTracker` port shaped to the spec's normalized `Issue` model (id/identifier/
  state/labels/blocked_by/priority). Linear becomes a later adapter, not a rewrite.
  Map GitHub `labels`→labels, `state`→open/closed+project status, issue number→
  `identifier`. Document the mapping in the brief.

**Observability — TUI now vs later (Milo vs Nova/Remy):**

- **Milo:** The Ink dashboard is the delight. The reference impl shipped a web UI.
- **Nova:** The dashboard must never block the daemon. It reads a snapshot; it isn't
  the source of truth.
- **Remy:** v1 = **structured logs + an OPTIONAL JSON snapshot API** (spec §13.3/§13.7
  minimum). The **Ink TUI is post-v1**, in its own package, consuming that snapshot.
  Milo designs the status glyph/color system _now_ (cheap, reusable in logs) so the
  TUI is fast to build later.
- **Milo:** I'll take the design-system-now compromise.

**State — in-memory vs durable (Sage vs spec):**

- **Sage:** SQLite would survive restarts.
- **Ivy:** The spec _defines_ restart recovery as tracker-driven + filesystem-driven,
  with no durable scheduler DB. Adding one changes the recovery semantics we're
  supposed to conform to.
- **Resolution:** **In-memory for v1**, but all scheduler state lives behind an
  `OrchestratorState` service so durability is an additive layer later, not surgery.

---

## Points everyone agreed on

- `WORKFLOW.md` (YAML front matter + Liquid body) stays the single control surface.
- Map **every** SPEC.md error class to an Effect **tagged error**.
- `Schema` validates both ends: WORKFLOW front matter _and_ normalized agent events.
- `FakeTracker` + `FakeAgentRunner` + `TestClock` make the state machine
  deterministically testable; the scheduler invariants get property tests.
- The orchestrator is a **single state-owning fiber**; workers report via a `Queue`.
- CI green (typecheck + lint + unit + fake e2e) is a merge gate from day one.
- **pnpm workspace monorepo**; the daemon never depends on the dashboard.

## Still open after Phase 2 (carried to concepts/spike)

- Exact Copilot integration surface (SDK vs headless CLI JSON) — **Sprint 0 spike**.
- License choice (Apache-2.0 parity?) — tracked in `docs/ideas-backlog.md`.
