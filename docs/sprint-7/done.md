# Sprint 7 — Done (First Contact: Live-Copilot Hardening)

Handoff for the Producer. See `plan.md` for the original scope + the locked spine, `progress.md`
for the finding-by-finding log (F1–F5).

## Summary

Six sprints in, Orchestra was a durable, legible, fully-controllable daemon that had **never
touched a real GitHub repo or a live Copilot CLI** — every guarantee was proven against fakes
under `TestClock`, every adapter pinned to assumptions from the Sprint 0 spike. Sprint 7 ran the
full loop end-to-end against **`martinthommesen/orchestra-smoke` + the live `copilot` CLI**, by
hand, repeatedly — and fixed what first contact forced. It is **production-hardening, not new
surface area.** The whole sprint was validated live, watched in the web cockpit; the agent opened
real PRs and handed issues off through its own GitHub tooling.

The spine resolved in order: **#7 plumbing smoke → #6 session-resume → #9 trust posture.**

## What shipped

| Area                                        | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Commit               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| **M1 · map.ts reconciled (F2)**             | The drift mechanic. `result.usage` carries **no token counts** (only `premiumRequests`/`*DurationMs`/`codeChanges`); the spike's `inputTokens`/`outputTokens`/`totalTokens` reads were phantom. The only token figure is per-message `assistant.message.outputTokens`, now surfaced as `usage.output_tokens` on the **`AgentMessage` only** (the orchestrator folds usage per event — tagging the sibling `Notification` would double-count). Dead `AgentMessage.role` removed (real field is `model`). Pinned to a scrubbed capture fixture; spike §8 mapping table banner-superseded.                                                                                                                      | `9dca4b1`            |
| **F1 · agent/tracker credential decoupled** | The marquee bug: the daemon injected `tracker.api_key` into the Copilot subprocess as `GITHUB_TOKEN`, overriding the working `/login` with a token lacking the `Copilot Requests` entitlement. New optional `copilot.github_token` (`$VAR`-resolved); the runner sources the agent credential from it, **never** the tracker token. Absent → the three agent-token keys are left **unset** (not `""`) so the child uses ambient `/login`. The trap: the executor **merges** `{...process.env, ...command.env}`, so omitting a key would inherit the daemon's `GITHUB_TOKEN` — `childEnv` sets them `undefined` (Node's spawn drops undefined). Secret-safe on both surfaces; pinned by a discriminator test. | `d05fe58`, `ad50e66` |
| **#79 · handoff label (F3)**                | The live re-dispatch loop: a handed-off issue (`Human Review` label, PR open) re-dispatched every poll, burning credits. Root cause was **config inconsistency**, not code — the example prompt named a "human-review state" absent from `terminal_states`, so `normalize.ts` precedence-3 fell back to `Todo` → eligible → loop. The mechanism was already complete (`deriveState` + `isEligible` reject non-active states); the fix is `Human Review` in `terminal_states` + the prompt applying that exact label, with a regression test. **Zero production-code change.**                                                                                                                                | `620ac08`            |
| **#78 · tool-use fixtures**                 | The happy-path fixture was no-tool; this closes the unit-fixture gap. A tool-forcing capture shows the agent emits `tool.execution_start\|partial_result\|complete` (**not** `tool.call`), `assistant.reasoning*`, `session.background_tasks_changed`; a tool call is an `assistant.message` with empty `content` + `toolRequests`; and under `--allow-all-tools` there are **zero `permission.*` events**. **`map.ts` did not drift** — every unrecognized family hits the forward-compat drop, mapping with zero `Malformed`. Pinned by a second scrubbed fixture + tests.                                                                                                                                 | `31632f0`            |
| **M3 · trust posture (#9, F4)**             | Resolved by observation: `tool.execution_complete` telemetry reports `sandboxApplied: false` — the agent runs shell/file writes **unsandboxed on the host**. New README **"Security & trust posture"** section documents the v1 model (per-issue workspace + least-privilege token as the boundary; OS/container sandboxing is the operator's job, §44 future) with an explicit "don't run v1 as-is" warning.                                                                                                                                                                                                                                                                                                | `ca6cf18`            |
| **M2 · session-resume verdict (#6, F5)**    | Resolved by driving it live. Cross-process `--resume <id>` of a **cleanly-completed** session is honored and carries context (standalone probe). A session killed **mid-turn** is **not** resumable — the resumed turn exits `AgentProcessExit` and the **self-heal** runs a fresh turn on the on-disk workspace, which completed and handed off (proven end-to-end). Verdict: `resume_sessions` is safe to enable but **stays default-off** (narrow benefit; fail-safes always).                                                                                                                                                                                                                            | `c05ded2`            |
| **Deferrals + runbook**                     | Filed [#77](https://github.com/martinthommesen/orchestra/issues/77) (budget ceiling can't bind on Copilot + USD ceiling), [#78](https://github.com/martinthommesen/orchestra/issues/78) (§56 live gated suite — unit-fixture half done), [#79](https://github.com/martinthommesen/orchestra/issues/79) (closed). Turnkey `e2e-smoke-runbook.md` corrected post-F1 (token model) and post-M1 (capture done).                                                                                                                                                                                                                                                                                                  | `de59989`            |

## Findings a future sprint must not regress

- **Two credentials, by design.** `tracker.api_key` is the daemon's reader (Octokit + clone
  hook); `copilot.github_token` (or ambient `/login`) is the **agent's**. The daemon never
  injects the tracker token into the agent. Re-conflating them resurrects F1.
- **Token accounting is output-only.** Copilot emits **no** `input_tokens`/`total_tokens`
  (n=3 captures). `usage.output_tokens` is the only signal; it accumulates per-event into
  `agent_totals`. The `budget.max_total_tokens` ceiling therefore can't bind today (#77).
- **`map.ts` is forward-compatible by construction.** Unrecognized event families (`tool.*`,
  `assistant.reasoning*`, future `session.*`) drop silently; only an **empty `type`** is
  `Malformed`. Don't add per-tool branches without a downstream consumer — the spike's
  `tool.call`/`permission.*` assumptions were both wrong.
- **Handoff = a status label in `terminal_states`.** Dispatch eligibility is "state ∈
  `active_states`" (`isEligible`); any recognized non-active state stops it. The example prompt
  and `terminal_states` must name the **same** label or the loop returns.
- **Resume is self-healing, not guaranteed.** A failed `--resume` always falls back to a fresh
  turn on the on-disk workspace — "can only help, never strand." Keep that property.
- **The agent runs unsandboxed.** v1's isolation is the workspace + token scope, not the OS.

## Gates at close-out

- `pnpm test` — **405 green** (3 new map.ts fixtures/tests + the F1 discriminator/secret tests +
  the #79 handoff guard).
- `pnpm typecheck` (both `tsconfig.json` + `tsconfig.cockpit.json`) — clean.
- `pnpm lint` (biome + prettier) — clean.
- **Live**: full loop run end-to-end against real GitHub + Copilot, watched in the cockpit;
  agent opened PRs and handed off; daemon went idle (no loop) on handoff; clean teardown, no
  orphan processes.

## Carry-forwards (deferred beyond Sprint 7)

- **#77** — budget ceiling can't bind on Copilot (output-only tokens) + the deferred USD ceiling.
- **#78** — the §56 **live gated** integration suite (`ORCHESTRA_E2E=1`, test-repo lifecycle,
  secrets-in-CI). The runbook is its spec and both unit fixtures make it cheap; the live half is
  the remaining infra cost.
- **Workspace leak on `max_turns` completion** (noted in `progress.md` F3): a worker that
  completes via `max_turns` marks completed but doesn't clean its workspace (only reconcile's
  terminal/neither paths do). Pre-existing, minor — worth its own issue if it bites.
- **Program A** (SSH/remote workers, Linear adapter, `POST /api/v1/refresh`, per-issue debug
  endpoint, out-of-band file-watcher) — the next program, now that single-host real runs are solid.
