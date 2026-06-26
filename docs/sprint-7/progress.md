# Sprint 7 — Progress / Findings

Running log of first-contact findings from the live-Copilot smoke (Milestone 1, #7).

## Finding F1 — Agent auth is conflated with the tracker token (marquee finding)

**Status:** confirmed, unblocked by config; **clean fix deferred to a deliberate follow-up**
(do not fix ahead of the smoke learning — manual-smoke-first).

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

**Clean fix (deferred follow-up — forward-only).** Decouple the agent credential from the
tracker token:

- Add optional `copilot.github_token` (`$VAR`-resolved, mirrors `tracker.api_key`), the
  credential the agent subprocess runs as. Absent → inject **nothing** (the child uses its
  ambient `/login`; `HOME`/`XDG_*` already pass through). Present → inject for headless servers.
- Source `childEnv`'s injected token from `copilot.github_token`, never `tracker.api_key`.
- **Two correctness/security constraints** (from review):
  1. When no agent token is configured, **`delete`** `GITHUB_TOKEN`/`GH_TOKEN`/
     `COPILOT_GITHUB_TOKEN` from the child env — do **not** blank to `""` (the proven-good
     state is `unset`, not empty; empty may read as "an invalid token was supplied").
  2. `copilot.github_token` is a **secret** — mirror `tracker.api_key` everywhere it's kept
     off the wire/disk: verify `snapshot.ts` (`/api/v1/state`) and `workflow-file.ts`
     (GET /settings secret-free subset + PUT whitelist) exclude it, and extend the
     secret-safe tests. A new resolved secret leaking into the snapshot/settings would
     regress the property this codebase guards hardest.
- File as its own issue; this is a real defect, not just smoke scaffolding.

**Outcome.** Unblock worked — fine-grained PAT (Copilot Requests + Contents/Issues/PR)
exported as `GITHUB_TOKEN`, current code unchanged. Daemon ran the full loop against the live
Copilot.

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
without waiting for merge. **Action:** document this in the runbook + WORKFLOW guidance; consider
a first-class "handoff label" convention. Not a code defect; a real ergonomics/spec-mapping gap.
