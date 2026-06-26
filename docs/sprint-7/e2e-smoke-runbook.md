# Sprint 7 — Live-Copilot E2E Smoke Runbook

The **turnkey, by-hand procedure** for Milestone 1 (#7). Run it against a throwaway repo to
prove Orchestra's loop end-to-end and capture the _real_ Copilot JSONL that `map.ts` must
match. Milestones 2 (#6 resume) and 3 (#9 posture) extend this same setup.

> **Blast radius:** a live agent runs with `--allow-all-tools` (see §6) against a real repo
> and token. Use a **dedicated throwaway repo** and a **least-privilege token**. Never point
> the first run at anything you care about.

---

## 0. Prerequisites (verify before starting)

```bash
copilot --version          # the headless CLI must be installed + authenticated
node --version             # Node 24 (or 22)
pnpm --version
pnpm install               # from repo root
pnpm build                 # cockpit assets must exist for the served UI
```

You need:

- A **throwaway GitHub repo** — already provisioned: **`martinthommesen/orchestra-smoke`**
  (private, initialized with a `README.md` on `main`).
- A **least-privilege token** with Issues + Pull Requests scope on that repo.

---

## 1. Seed one trivial issue

**Already seeded:** issue **#2 — "Add a greeting line to README"** (body: _Append the line
"Hello from Orchestra" to README.md._), labelled `orchestra`, open. (Issue #1 is a closed
prior smoke run — ignore it.)

To re-seed later (trivial, low-blast-radius on purpose — we test Orchestra's plumbing, not
Copilot's coding ability):

```bash
gh issue create --repo martinthommesen/orchestra-smoke \
  --title "Add a greeting line to README" \
  --body 'Append the line "Hello from Orchestra" to README.md.' \
  --label orchestra
```

---

## 2. Write `WORKFLOW.md`

```bash
cp WORKFLOW.example.md WORKFLOW.md
```

Edit only these keys (everything else can stay at the example defaults):

```yaml
tracker:
  kind: github
  repo: martinthommesen/orchestra-smoke
  api_key: $GITHUB_TOKEN
  required_labels: [orchestra]
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed, Cancelled]

workspace:
  root: ./.orchestra/workspaces

hooks:
  # Private repo → clone with the token from env. `$GITHUB_TOKEN` is expanded by `sh -lc`
  # at runtime (the literal token never lands in this file or the daemon's command string).
  after_create: git clone https://x-access-token:$GITHUB_TOKEN@github.com/martinthommesen/orchestra-smoke .
  timeout_ms: 120000

agent:
  max_concurrent_agents: 1 # one session — easiest to watch
  max_turns: 3

copilot:
  command: copilot
  stall_timeout_ms: 300000
```

> The example body already tells the agent to open a PR and move the issue to a human-review
> state **using its own tools** — that's the reader-not-writer boundary. Whether it succeeds
> is the **observed (not gated)** outcome.
>
> Workspace population is implementation-defined (spec §7). The `after_create` clone above is
> the simplest real bootstrap; swap for your auth pattern (SSH/`gh`) as needed. If the clone
> needs the token, the agent's `GITHUB_TOKEN` env is already exported below.

---

## 3. Run the daemon with the cockpit

```bash
export GITHUB_TOKEN=...                      # the least-privilege repo token
export ORCHESTRA_COCKPIT_TOKEN=$(openssl rand -hex 16)   # or let the daemon log a CSPRNG one
pnpm dev ./WORKFLOW.md --port 4317
```

Open `http://127.0.0.1:4317` — watch **Fleet**, **Events**, **Kanban** live.

---

## 4. Milestone 1 checklist — the **plumbing gate** (MUST PASS)

Tick each as you observe it (cockpit + logfmt stderr):

- [ ] Daemon boots; `WORKFLOW.md` loads + validates (no startup error).
- [ ] Poll fires; the seeded issue is fetched (appears in Kanban Candidate/Claimed).
- [ ] Issue is **claimed**; a workspace dir is created under `./.orchestra/workspaces/...`
      (sanitized key), `after_create` hook runs.
- [ ] Copilot spawns with `cwd == workspace_path` (Fleet shows a running session).
- [ ] **`AgentEvent`s stream and are NOT `Malformed`** ← the hard gate. Watch the Events feed
      and logfmt for `Malformed` tags carrying a raw line. **Any `Malformed` = drift = §5.**
- [ ] Turn completes; **token totals populate** (Fleet/Budget show non-zero `total_tokens`).
- [ ] Clean teardown on `Ctrl-C` (workers + timers + cockpit server stop; no orphan `copilot`).

**Observe but DO NOT gate:** the agent actually opening a PR / moving the issue to handoff.
Record what happened — it feeds Milestone 3.

---

## 5. Capture raw JSONL + reconcile `map.ts` (the point of the smoke)

`map.ts` is pinned to the **Sprint 0 spike's assumed** shape (`type:"result"` + `exitCode`,
camelCase `usage`, `assistant.message`/`data.content`). First contact will likely break it.

**Capture ground-truth lines** by running the CLI standalone with the **daemon's exact
flags** (mirrors `copilot-runner.ts`), teed to a file:

```bash
WS=$(ls -d ./.orchestra/workspaces/*/ | head -1)    # a created workspace
copilot -p "Append the line \"Hello from Orchestra\" to README.md." \
  --output-format json -C "$WS" --allow-all-tools --no-color --log-level none \
  --session-id "$(uuidgen)" \
  | tee docs/sprint-7/captured-jsonl.raw
```

Then:

1. **Inspect** `captured-jsonl.raw` — compare each `type` and field against `map.ts`'s switch.
2. **Fix `map.ts`** against reality (new `type`s, renamed `usage` fields, different terminal
   signal). Forward-only: **supersede** the mapping table in `docs/sprint-0/spike-copilot.md`
   §8 — do not keep both.
3. **Scrub** the captured lines (strip any echoed token / repo content), move the golden
   subset to `test/fixtures/copilot-jsonl/`, and pin `map.test.ts` to them.
4. Re-run §4 — the gate must be green with the corrected mapper.

---

## 6. Milestone 2 — session-resume (#6), after §4 is green

Asymmetric: **either outcome closes the carry-forward.**

1. Set `persistence: { resume_sessions: true }` in `WORKFLOW.md`; restart the daemon.
2. Start a run, then **kill the daemon mid-turn** (`Ctrl-C` while a session streams).
3. **Restart** `pnpm dev ./WORKFLOW.md --port 4317`. On boot the orphaned `running` issue
   becomes a due-immediately continuation retry; the runner passes `--resume <sessionId>`.
4. Observe whether Copilot **honors** `--resume` for that `<thread_id>-<turn_id>` id:
   - **Honored** → record evidence; document `resume_sessions` as **safe to enable**.
   - **Not honored** (CLI rejects/ignores `--resume`, or self-heals to a fresh turn against the
     on-disk workspace) → document `resume_sessions` **stays default-off, with evidence.**

---

## 7. Milestone 3 — sandbox / approval posture (#9), after §4 is green

The adapter already spawns with **`--allow-all-tools`** and `--log-level none` — i.e. the v1
posture is **fully-trusted, auto-approve**. Confirm and document, don't assume:

1. **Observe** the live agent: does it write files / run shell / push without prompting? (With
   `--allow-all-tools`, expect yes.) What sandbox, if any, is it in?
2. **Pin** the safest flags the `copilot` CLI actually exposes — if it offers a narrower
   permission/approval mode, thread it through (small additive `copilot.*` knob); otherwise
   record that `--allow-all-tools` is the only mode and the trust boundary is the workspace +
   token scope.
3. **Write** the README **trust-posture** section (Security Rule #5 / spec §15.1): v1 targets
   trusted environments, agent runs auto-approve with all tools, isolation is the per-issue
   workspace + least-privilege token; OS/container sandboxing (§44) is future work.

---

## 8. Wrap-up

- Record outcomes in `docs/sprint-7/progress.md`; final write-up in `done.md`.
- File issues for any drift bugs found, plus the two deferrals (USD ceiling, §56 live gated
  suite). Update PROJECT_BRIEF §7–§8 at sprint close.
