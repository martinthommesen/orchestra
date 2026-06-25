---
# =============================================================================
# WORKFLOW.example.md — copy to WORKFLOW.md and edit for your repo:
#
#     cp WORKFLOW.example.md WORKFLOW.md
#     export GITHUB_TOKEN=...        # a least-privilege repo token (Issues + PRs)
#     pnpm dev ./WORKFLOW.md
#
# Orchestra reads this file as YAML front matter (configuration) plus a Liquid body
# (the per-issue prompt). Every block below is OPTIONAL and shown with a sensible
# value; delete what you don't need and the built-in defaults apply. Secrets use
# `$VAR` indirection — resolved from the environment at load, never written here
# (PROJECT_BRIEF §9).
# =============================================================================

# --- tracker: where Orchestra reads work from (GitHub Issues in v1) -----------
tracker:
  kind: github # only `github` is supported in v1
  repo: your-org/your-repo # owner/name of the repo whose Issues drive the work
  api_key: $GITHUB_TOKEN # $VAR → resolved from env; never hard-code a token
  # endpoint: https://api.github.com   # override for GitHub Enterprise
  required_labels: [orchestra] # an issue needs ALL these labels to be picked up
  active_states: [Todo, In Progress] # states Orchestra will work
  terminal_states: [Done, Closed, Cancelled] # states that stop a worker

# --- polling: how often to scan the tracker -----------------------------------
polling:
  interval_ms: 30000 # 30s between tracker scans

# --- workspace: where per-issue working directories are created ---------------
workspace:
  root: ./.orchestra/workspaces # relative to this file; `~` and `$VAR` also allowed

# --- hooks: shell run around each workspace's lifecycle (fully trusted) --------
#     Hooks are plain shell, NOT Liquid-rendered. `timeout_ms` guarantees a hook can
#     never hang the orchestrator; hook output is truncated in logs.
hooks:
  after_create: git init -q # runs once, just after the workspace dir is made
  # before_run: pnpm install      # runs before each agent turn
  # after_run: echo done          # runs after each agent turn
  timeout_ms: 60000 # 60s per hook

# --- agent: orchestration limits ----------------------------------------------
agent:
  max_concurrent_agents: 3 # global cap on simultaneous Copilot sessions
  max_turns: 10 # max agent turns per issue
  max_failure_retries: 3 # max retries after failed attempts before parking the issue
  max_retry_backoff_ms: 300000 # cap on exponential retry backoff (5 min)
  # max_concurrent_agents_by_state:   # optional per-state caps (keys are lowercased)
  #   in progress: 2

# --- copilot: the coding agent ------------------------------------------------
copilot:
  command: copilot # the headless CLI Orchestra drives (see spike doc)
  # model: claude-opus-4.8       # optional model override; default chosen by Copilot
  turn_timeout_ms: 3600000 # hard cap per turn stream (1h)
  read_timeout_ms: 5000 # startup / sync-request timeout
  stall_timeout_ms: 300000 # kill + retry if no agent event for this long (5 min)
---

You are an autonomous coding agent working on a single GitHub issue inside a clean,
isolated workspace. The current working directory **is** the repository checkout —
make and commit your changes here.

## Issue {{ issue.identifier }} — {{ issue.title }}

- State: {{ issue.state }}
  {%- if issue.priority %}
- Priority: {{ issue.priority }}
  {%- endif %}
  {%- if issue.url %}
- Link: {{ issue.url }}
  {%- endif %}
  {%- if issue.labels != empty %}
- Labels: {{ issue.labels | join: ", " }}
  {%- endif %}

### Description

{{ issue.description | default: "(no description provided)" }}
{%- if issue.blocked_by != empty %}

### Blocked by

{% for blocker in issue.blocked_by -%}

- {{ blocker.identifier }} ({{ blocker.state }})
  {% endfor -%}
  {%- endif %}

## Your task

{% if attempt -%}
This is **retry attempt {{ attempt }}** — a previous attempt did not finish cleanly.
Inspect what's already in the workspace, fix what's incomplete, and continue. Do not
restart from scratch unless the existing work is unsalvageable.
{%- else -%}

1. Explore the repository to understand its structure, conventions, and tests.
2. Implement exactly what the issue asks for — no more, no less — with tests.
3. Keep your changes focused and your commits well-described.
   {%- endif %}

When the work is complete, open a pull request that references this issue and move the
issue to your team's human-review state. Perform all Git and GitHub writes using your
available tools.
