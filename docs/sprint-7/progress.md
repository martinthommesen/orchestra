# Sprint 7 — Progress / Findings

Running log of first-contact findings from the live-Copilot smoke (Milestone 1, #7).

## Finding F1 — Agent auth is conflated with the tracker token (marquee finding)

**Status:** confirmed; unblocked by config during the smoke; **clean fix now IMPLEMENTED**
(commit follows this doc) — the credential is decoupled in code, no longer config-only.

**Symptom.** Running the daemon, Copilot exits with `Authentication failed … ensure it has the
'Copilot Requests' permission enabled`, even though standalone `copilot -p "say hello"` works
fine via the user's stored `/login`.

**Root cause.** `src/adapters/agent-copilot/copilot-runner.ts:82-86` unconditionally injects the
**tracker token** (`config.tracker.api_key`) into the Copilot subprocess as
`GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` / `GH_TOKEN`. The Copilot CLI reads those for _its own_
authentication, so the daemon **overrides the working `/login` with the repo token** — and a
classic `gh auth token` has repo scope but **not** the `Copilot Requests` entitlement (a
fine-grained-PAT-only permission). This is the Symphony→Orchestra impedance mismatch: Codex
used one OpenAI credential for model + tool access; GitHub **splits** repo access (Octokit +
the agent's `git push`/PR) from Copilot subscription entitlement. The Sprint 0 spike assumed
one token covers both.

**Proof.** With `unset GITHUB_TOKEN COPILOT_GITHUB_TOKEN GH_TOKEN`, standalone
`copilot -p "say hello" --allow-all-tools` succeeds (26 AI credits, real response). Injecting
the tracker token is the only differing variable.

**Unblock (config, no code change).** Use one **fine-grained PAT** with `Copilot Requests`
(account) + Contents/Issues/PR (repo: `orchestra-smoke`), exported as `GITHUB_TOKEN`. One
entitled token satisfies tracker reads, clone hook, Copilot model auth, and the agent's git
push — so it also makes the observe-only "agent opens a PR" outcome actually exercisable.

**Clean fix (DONE — forward-only).** Decoupled the agent credential from the tracker token:

- Added optional `copilot.github_token` (`$VAR`-resolved by the loader, mirrors
  `tracker.api_key`) — the credential the **agent subprocess** runs as. Absent → inject
  **nothing** (child uses its ambient `/login`; `HOME`/`XDG_*` already pass through). Present
  → inject for headless servers. `copilot-runner.ts` now sources the injected token from
  `config.copilot.github_token`, **never** `tracker.api_key`.
- **Constraint 1 (unset, not blank) — and the merge-semantics trap it hid.** The node
  executor builds the child env as `{ ...process.env, ...command.env }` (**merge**, verified
  in `@effect/platform-node-shared`), so the daemon's own `GITHUB_TOKEN` (the operator's
  tracker credential, canonical env per `workflow.ts`) would be **inherited** if the key were
  merely omitted — silently re-introducing F1, un-blanked. So `childEnv` sets the three agent
  keys to `undefined` (Node's spawn skips undefined-valued keys → the var is genuinely
  **unset**), never `""`. Pinned by a discriminator test: with the tracker token planted in
  `process.env` and no agent token configured, the child probe reads `__UNSET__`; with an agent
  token configured, it reads that token and **not** the tracker token.
- **Constraint 2 (secret-safe) — both surfaces verified structurally + tested.** `/settings`
  is safe by construction (the `EditableSettings`/`SettingsPatch` whitelist excludes all of
  `copilot.*`) and `/api/v1/state` embeds no config at all. Added tests: loader resolves /
  drops `copilot.github_token`'s `$VAR`; the editable projection never carries `github_token`
  even when the WORKFLOW.md sets it.
- **Hooks checked (no half-migration):** hook scripts run with **no** `Command.env`, inheriting
  the ambient orchestrator env — they never injected `tracker.api_key`, so nothing to decouple.

**Smoke outcome (historical).** The smoke itself was unblocked by config — one fine-grained PAT
(Copilot Requests + Contents/Issues/PR) exported as `GITHUB_TOKEN`, code then unchanged — and
the daemon ran the full loop against live Copilot. The code fix above now makes that decoupling
first-class so a headless deploy doesn't depend on the tracker and agent token happening to be
the same entitled PAT.

## Finding F2 — Plumbing gate PASSED; streaming map.ts did NOT drift

The §4 plumbing gate is green for streaming events. Across ~5 min of live streaming,
`SessionStarted` / `AgentMessage` / `Notification` all mapped cleanly — **zero `Malformed`
events**. The Sprint 0 spike's assumed shapes held for the streaming path. The agent also
cleared the **observe-only outcome gate**: edited `README.md`, committed on `add-greeting-line`,
pushed, and opened **PR #3** (`Closes #2`, correct diff) via its own GitHub tooling.

**UPDATE — now VALIDATED via the standalone capture** (`captured-jsonl.raw`, a `copilot -p
"Print DONE and stop"` run). The terminal `result` → `TurnCompleted` mapping is correct; the
reason token totals never populated is now pinned down, and it is **not a bug in the terminal
path** — it's that the tokens were never in `result.usage` to begin with:

- **`result.usage` carries no token counts.** Observed shape: `{premiumRequests,
totalApiDurationMs, sessionDurationMs, codeChanges}`. The Sprint 0 §4 capture _already showed
  this_ — the drift was purely in the **implementation**: `map.ts`'s `mapUsage` read phantom
  `inputTokens`/`outputTokens`/`totalTokens` off `result.usage`, fields that capture never had.
- **The only token count in the whole stream is per-message `assistant.message.outputTokens`**
  (=5). So the turn's output-token total is the sum of these. Fixed forward-only:
  `output_tokens` now rides the **`AgentMessage`** (the orchestrator folds `usage` per event,
  so it accumulates into `agent_totals` automatically); it is attached to the `AgentMessage`
  **only**, never the sibling `Notification`, or the same tokens would double-count.
- **No `input_tokens` / `total_tokens` are emitted anywhere** (n=2: Sprint 0 + Sprint 7, both
  no-tool turns). Since the `budget.max_total_tokens` ceiling gates on `total_tokens`, it
  **cannot bind on Copilot output as-is** — a real finding that feeds the deferred **#8**
  USD/token-ceiling follow-up. Not fabricating a `total_tokens` from `output_tokens`. Whether a
  _tool-using_ turn reports more is still uncaptured (this capture is the trivial happy path).
- **`assistant.message.role` does not exist** (the real field is `model`); the dead `role`
  extraction + the unused `AgentMessage.role` schema field were removed.

**Artifacts.** `map.ts` reconciled; `AgentMessage.role` deleted; Sprint 0 §8 mapping table
banner-superseded; scrubbed fixture `test/fixtures/copilot-jsonl/standalone-result.jsonl` (12
representative lines, home-path scrubbed, bulky `session.*` catalogs trimmed) pins the mapper in
`test/agent-copilot.test.ts` ("pinned to the live standalone capture"): zero `Malformed`, exactly
one `completed` terminal, output tokens accounted exactly once. **Caveat (carry-forward):** this
pins the **streaming + terminal/usage** paths only. Tool-use paths (`permission.*`,
`toolRequests`, multi-message turns, error terminals) are **not** exercised and remain on spike
assumptions until a tool-using run (e.g. the F2 README/PR run) is teed to a file.

## Finding F3 — Handoff has no home in the plain-GitHub state model (product finding)

The agent finished the work (PR #3 open) but the daemon kept dispatching turns / "working". Root
cause is conceptual, not a plumbing bug: the prompt says _"move the issue to your team's
human-review state,"_ but a plain GitHub issue is only **open/closed** — there is no
"human-review" state, and `Closes #2` doesn't take effect until the PR **merges**. So the issue
stays `active` (open → In Progress) after the work is done, reconcile keeps seeing it active, and
the loop re-runs the agent up to `max_turns`/retries on already-complete work — burning credits.

Symphony/Linear closes this gap with a real handoff state (e.g. "Human Review") that stops
dispatch. On GitHub the equivalent is a **status label** (`normalize.ts` already maps
status-labels → state): a workflow should hand off by applying a label that the operator puts in
`terminal_states` (or a dedicated non-active state), so dispatch stops the moment the PR is up —
without waiting for merge.

**FIXED — and confirmed live.** Re-running the smoke after M1 reproduced this exactly: issue #2,
already handed off (`Human Review` label, PR open), was re-dispatched every poll and burned
credits in an infinite loop. Root cause was purely **config inconsistency**: the example prompt
told the agent to "move to your human-review state," but `terminal_states` did not contain such a
label, so `normalize.ts` precedence-3 fell back to `active_states[0]` (Todo) → eligible → loop.

The mechanism was already complete in code: `deriveState` recognizes any label in
`terminal_states`, and `selection.isEligible` rejects every non-active state, so a recognized
handoff label stops dispatch with **zero production-code change** (verified the dedicated-config
alternative would be redundant — `isEligible` already excludes non-active states, and routing
handoff through the existing terminal path also gets the `TerminalKill` workspace-clean +
mark-completed that the "neither" path would leak). The fix:

- `WORKFLOW.example.md` (and the smoke's `WORKFLOW.md` + runbook §2): `Human Review` added to
  `terminal_states`; the prompt body now tells the agent to **apply the exact `Human Review`
  label** as its final step (and not strip `orchestra`).
- Regression guard in `test/tracker-github.test.ts`: an **open** issue carrying the handoff label
  → `deriveState` returns the terminal state → `isEligible` is `false` (the loop cannot recur).
- Tracked as [#79](https://github.com/martinthommesen/orchestra/issues/79).

**Known adjacent (separate, pre-existing — not #79):** a worker that completes via `max_turns`
(loop.ts `handleWorkerOutcome`) marks completed + deletes the registry entry but does **not**
clean its workspace — only reconcile's `TerminalKill`/`NeitherKill` paths do. Handoff issues are
reaped (and cleaned) by reconcile when caught mid-continuation, but a clean `max_turns` finish
leaves the workspace until restart cleanup. Worth its own follow-up if it bites.

## Deferrals & follow-ups — filed as GitHub issues

Per the plan (open issues for the deferrals + one per real drift finding so nothing is lost):

- **F1** — agent/tracker credential conflation: **fixed in-tree** (commit `d05fe58`), not an
  open issue. The token model is documented for operators in `WORKFLOW.example.md` + the runbook.
- [#77](https://github.com/martinthommesen/orchestra/issues/77) — **budget ceiling can't bind on
  Copilot** (the F2 token-accounting finding: no `input_tokens`/`total_tokens` emitted) **+ the
  deferred USD ceiling** (was #8), which is downstream of the same accounting gap.
- [#78](https://github.com/martinthommesen/orchestra/issues/78) — **§56 live gated integration
  suite** (deferred): the runbook is its spec; the captured fixtures make it cheap. Carries the
  tool-use-capture gap from the F2 caveat.
- [#79](https://github.com/martinthommesen/orchestra/issues/79) — **F3 handoff-label** ergonomics
  gap.

Still open in-sprint (need a live daemon, per the runbook): **M2** session-resume (#6) verdict,
**M3** sandbox/approval posture (#9) + README trust-posture section.
