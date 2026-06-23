---
tracker:
  kind: github
  repo: acme/widgets
  api_key: $TEST_GH_TOKEN
  required_labels:
    - Ready
  active_states:
    - Todo
    - In Progress
polling:
  interval_ms: 15000
workspace:
  root: ./.workspaces
agent:
  max_concurrent_agents: 4
  max_turns: 8
copilot:
  model: claude-opus-4.8
  turn_timeout_ms: 1200000
---

You are working on **{{ issue.identifier }}** — {{ issue.title }}.

{% if attempt %}This is retry attempt {{ attempt }}.{% endif %}

Labels: {{ issue.labels | join: ", " }}
