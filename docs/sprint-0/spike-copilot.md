# Spike — Driving GitHub Copilot Headlessly (Sprint 0, Task 7)

> **Timebox:** ~3h. **Status:** complete. **Decision: subprocess for v1.**
> This doc pins the integration surface so Sprint 1 can build the `AgentRunner`
> implementation without re-litigating the transport. Both options stay behind the
> `AgentRunner` port (`src/core/ports/agent-runner.ts`).

## 1. Question

How do we drive **GitHub Copilot for one agent turn, headlessly, in a target
directory**, and what does its event/output stream look like? Two candidate
mechanisms:

- **(a) Subprocess** — spawn the installed `copilot` CLI in non-interactive
  (`--print`) mode and parse its stdout.
- **(b) In-process SDK** — import `@github/copilot` and drive a session via a
  programmatic API.

## 2. What was investigated (live, not from docs)

- **Installed toolchain:** GitHub Copilot CLI **1.0.64-3** at `~/.local/bin/copilot`,
  already authenticated (credentials under `~/.copilot`). `gh` authed as
  `martinthommesen`.
- **CLI surface:** `copilot --help` / `copilot -p --help`. Relevant flags found:
  `-p, --prompt` (non-interactive "print" mode — runs one prompt and exits),
  `--output-format <text|json>`, `-C, --add-dir <dir>` / working-directory control,
  `--allow-all-tools` (skip interactive approval — required for unattended runs),
  `--no-color`, `--log-level <level>`, `--session-id <uuid>`, `--resume`/`--continue`
  (session continuation), and `--acp` (Agent Client Protocol — a JSON-RPC server mode,
  see §7).
- **SDK packages:** unpacked both `@github/copilot@1.0.63` and `@1.0.64-3` tarballs and
  diffed their `package.json` `exports`. The `./sdk` subpath export that existed in
  **1.0.63 was REMOVED in 1.0.64-3** (the installed version). The sibling
  `@github/copilot-sdk` package exists but its `/extension` entrypoint is for
  _authoring extensions that join an existing session_, not for _driving_ the agent
  headlessly. The `.d.ts` files were mined for the full event vocabulary (§5).
- **Live PoC:** ran one real prompt through the CLI in JSON mode against a throwaway
  workspace and captured the full JSONL stream (§4). ~26 event lines, terminal
  `result` with `exitCode: 0`.

## 3. PoC — exact invocation

```bash
COPILOT_AUTO_UPDATE=false \
copilot -p "Reply with exactly the single word: pong. Do not call any tools." \
  --output-format json \
  -C "<ABS_WORKSPACE_DIR>" \
  --allow-all-tools \
  --no-color \
  --log-level none
```

- **stdout** = JSONL (one JSON object per line). **stderr** = empty on success.
- **Auth env (one of):** `COPILOT_GITHUB_TOKEN` | `GH_TOKEN` | `GITHUB_TOKEN`. The CLI
  also reuses its own `~/.copilot` login, which is how the PoC authenticated.
- `COPILOT_AUTO_UPDATE=false` pins the binary (no surprise self-update mid-run).
- `--allow-all-tools` is **mandatory for unattended runs** — without it the agent
  blocks on an interactive approval prompt. This is the trust posture documented in
  PROJECT_BRIEF §9.5 (v1 targets trusted environments).
- `-C <dir>` sets the directory the agent operates in. Sprint 1 **must additionally
  spawn with `cwd === workspacePath`** to satisfy Safety Invariant 1
  (`InvalidWorkspaceCwd`); `-C` and `cwd` are set to the same absolute path.

## 4. PoC — captured event stream (real output, 2026-06-23)

The stream is a flat JSONL log. **Streaming/lifecycle events** share one envelope:

```jsonc
{
  "type": "assistant.message", // dot-notation event kind
  "data": {
    /* event-specific payload */
  },
  "id": "25de54af-…", // event id
  "timestamp": "2026-06-23T11:23:38.976Z",
  "parentId": "0e037da1-…", // causal parent event id
  "ephemeral": true, // optional; transient/status events
}
```

The **terminal `result`** event is a _different, flatter_ shape (no `data`/`id`/
`parentId`) — treat it specially:

```jsonc
{
  "type": "result",
  "timestamp": "2026-06-23T11:23:38.997Z",
  "sessionId": "cebdde6a-a29a-424d-bb9d-696edb61ff7b",
  "exitCode": 0,
  "usage": {
    "premiumRequests": 15,
    "totalApiDurationMs": 2066,
    "sessionDurationMs": 19124,
    "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModified": [] },
  },
}
```

### Event types observed in the PoC (26 lines)

| `type`                              | role in the turn                | key `data` fields                                                                                             |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session.mcp_server_status_changed` | MCP servers connecting (×11)    | `serverName`, `status` — `ephemeral`                                                                          |
| `session.mcp_servers_loaded`        | MCP catalog ready (×3)          | `servers[]` — `ephemeral`                                                                                     |
| `session.skills_loaded`             | skill catalog (×2)              | `skills` — `ephemeral`                                                                                        |
| `session.tools_updated`             | tool catalog                    | tool list                                                                                                     |
| `session.custom_agents_updated`     | custom-agent catalog            | —                                                                                                             |
| `user.message`                      | the prompt as sent              | `content`, `transformedContent` (system-reminder wrapped), `attachments[]`                                    |
| `assistant.turn_start`              | turn began                      | `turnId` (`"0"`), `interactionId`                                                                             |
| `assistant.message_start`           | assistant reply opening         | `messageId`                                                                                                   |
| `assistant.message_delta`           | streamed token chunk (×2)       | `messageId`, `deltaContent` (`"p"`, …)                                                                        |
| `assistant.message`                 | **completed assistant message** | `role`, `model` (`claude-opus-4.8`), `content` (`"pong"`), `outputTokens` (4), `turnId`, **`toolRequests[]`** |
| `assistant.turn_end`                | turn finished                   | `turnId`                                                                                                      |
| `result`                            | **terminal** — process exiting  | `sessionId`, `exitCode`, `usage{…}`                                                                           |

**Key takeaways for the runner:**

- `assistant.message` is the substantive payload (final text + `toolRequests[]` +
  per-message token count). `message_start`/`message_delta` are optional streaming
  niceties we can ignore in v1 and add later for live output.
- Most `session.*` events are `ephemeral: true` status noise → map to a single
  internal "diagnostic" channel or drop.
- `result.exitCode` + the **process exit code** are the dual success signals. The
  runner converts a non-zero exit / missing `result` into `AgentProcessExit`.
- `usage.premiumRequests` is real billing signal — surface it in observability
  (already modelled on `Usage.premium_requests`).

## 5. Wider event vocabulary (from the SDK `.d.ts`, for forward-compat)

The PoC only exercised a happy path. The SDK type defs enumerate the events a robust
mapper should also expect (so Sprint 1 doesn't get surprised):

- **Tools:** `tool.call`, `tool.user_requested`, `tool.execution_start`,
  `tool.execution_progress`, `tool.execution_partial_result`, `tool.execution_complete`.
- **Permissions:** `permission.request`, `permission.requested`, `permission.completed`
  (suppressed by `--allow-all-tools`, but defend anyway).
- **Reasoning/usage:** `assistant.reasoning`, `assistant.reasoning_delta`,
  `assistant.usage`, `assistant.intent`, `assistant.streaming_delta`, `assistant.abort`.
- **Failures / lifecycle:** `model.call_failure`, `session.error`, `session.idle`,
  `session.compaction_start`/`_complete`, `session.permissions_changed`,
  `session.mode_changed`, `user.abort`.

The mapper's contract: **recognize the handful that matter, fold everything else into
`AgentMessage` (diagnostic) or `Malformed`** so an unknown/new event never crashes the
orchestrator. This is why `AgentEvent` includes a `Malformed` variant.

## 6. Decision — **subprocess for v1**

| Criterion                             | Subprocess (CLI `-p --output-format json`)                                                     | In-process SDK (`@github/copilot`)                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Availability (installed 1.0.64-3)** | ✅ works today, verified by PoC                                                                | ❌ `./sdk` export **removed** in 1.0.64-3                                       |
| **Stability of the contract**         | ✅ CLI flags + JSONL are the supported public surface                                          | ❌ export churned between two consecutive prereleases                           |
| **Isolation**                         | ✅ separate PID, own `cwd`, own env — killable on stall/cancel (`TurnTimeout`, reconciliation) | ⚠️ shares the daemon process; a crash/leak can take down the orchestrator fiber |
| **Safety Invariant 1 (§9.5)**         | ✅ enforce `cwd === workspacePath` at `spawn`                                                  | ⚠️ must be emulated; agent may not honor per-call cwd                           |
| **Mapping cost**                      | ✅ JSONL → `AgentEvent` is a line decoder                                                      | ✅ typed events, but to an unstable type                                        |
| **Resource teardown**                 | ✅ kill PID + `Scope` finalizer                                                                | ⚠️ in-process cancellation only                                                 |
| **Secrets**                           | ✅ token via child env, never logged                                                           | ✅ same                                                                         |

**Rationale:** the subprocess is the only mechanism that is (1) actually present and
working in the installed version, (2) backed by a stable public contract, and (3)
gives us a **killable, cwd-isolated** unit — which the orchestrator needs for stall
detection, reconciliation cancellation, and the workspace safety invariants. The SDK's
removal of its `./sdk` export between `1.0.63` and `1.0.64-3` is a strong instability
signal; binding the core to it now would be a liability. Default-to-subprocess is also
exactly the brief's stated posture (PROJECT_BRIEF §3).

### Runner shape for Sprint 1 (subprocess)

- `@effect/platform` `Command` to spawn `copilot` with the §3 flags; `cwd` =
  `workspacePath`; child env carries the resolved `$VAR` token (never logged).
- Stream stdout lines → `Schema.decodeUnknown(CopilotEnvelope)` → map to `AgentEvent`
  (§7 of `agent-event.ts`). Unparseable lines → `Malformed`.
- `Scope` finalizer kills the PID on interruption; non-zero exit or absent `result` →
  `AgentProcessExit`. `read_timeout_ms` / `turn_timeout_ms` / `stall_timeout_ms` from
  `copilot` config drive `ResponseTimeout` / `TurnTimeout` / stall handling.
- Session continuation (`LiveSession.session_id`) via `--resume <id>` /
  `--session-id <uuid>` for multi-turn issues.

## 7. Future upgrade path — ACP (kept open, not built)

`copilot --acp` exposes an **Agent Client Protocol** (JSON-RPC) server: a longer-lived,
bidirectional, in-process-friendly channel that would avoid per-turn process spawn and
give first-class permission/turn control. It is the natural v2 transport once the
surface stabilizes. Because everything lives behind the `AgentRunner` port, swapping the
subprocess runner for an ACP runner is a **layer swap, no core change**. Recorded here
so we don't forget it exists.

## 8. `AgentEvent` Schema sketch (normalized, vendor-neutral)

The orchestrator never sees Copilot's wire format. The runner maps the raw JSONL into
this discriminated union (implemented in full at
`src/core/domain/agent-event.ts` — this is the spike's sketch that drove it):

```ts
import { Schema } from "effect";

// Usage accounting, attached where reported (mirrors result.usage + assistant.message).
const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Int),
  output_tokens: Schema.optional(Schema.Int),
  total_tokens: Schema.optional(Schema.Int),
  premium_requests: Schema.optional(Schema.Number), // Copilot result.usage.premiumRequests
  total_api_duration_ms: Schema.optional(Schema.Number),
});

// Common envelope spread into every variant.
const EventEnvelope = {
  timestamp: Schema.Date,
  agent_pid: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Usage),
};

// One TaggedStruct per normalized kind; union discriminates on `_tag`.
const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  ...EventEnvelope,
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
});
const StartupFailed = Schema.TaggedStruct("StartupFailed", {
  ...EventEnvelope,
  message: Schema.String,
});
const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {
  ...EventEnvelope,
  turn_id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const TurnFailed = Schema.TaggedStruct("TurnFailed", {
  ...EventEnvelope,
  message: Schema.String,
});
const TurnCancelled = Schema.TaggedStruct("TurnCancelled", {
  ...EventEnvelope,
  reason: Schema.optional(Schema.String),
});
const TurnEndedWithError = Schema.TaggedStruct("TurnEndedWithError", {
  ...EventEnvelope,
  message: Schema.String,
});
const TurnInputRequired = Schema.TaggedStruct("TurnInputRequired", {
  ...EventEnvelope,
  prompt: Schema.optional(Schema.String),
});
const ApprovalAutoApproved = Schema.TaggedStruct("ApprovalAutoApproved", {
  ...EventEnvelope,
  kind: Schema.optional(Schema.String),
});
const UnsupportedToolCall = Schema.TaggedStruct("UnsupportedToolCall", {
  ...EventEnvelope,
  tool: Schema.String,
});
const Notification = Schema.TaggedStruct("Notification", {
  ...EventEnvelope,
  message: Schema.String,
});
const AgentMessage = Schema.TaggedStruct("AgentMessage", {
  ...EventEnvelope,
  role: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const Malformed = Schema.TaggedStruct("Malformed", {
  ...EventEnvelope,
  raw: Schema.String,
});

export const AgentEvent = Schema.Union(
  SessionStarted,
  StartupFailed,
  TurnCompleted,
  TurnFailed,
  TurnCancelled,
  TurnEndedWithError,
  TurnInputRequired,
  ApprovalAutoApproved,
  UnsupportedToolCall,
  Notification,
  AgentMessage,
  Malformed,
);
export type AgentEvent = typeof AgentEvent.Type;
```

### Copilot JSONL → `AgentEvent` mapping table (for Sprint 1)

> **Superseded by the Sprint 7 first-contact smoke (`docs/sprint-7/`).** The mapper is now
> pinned to _observed_ output via `test/fixtures/copilot-jsonl/` — see `test/agent-copilot.test.ts`
> ("pinned to the live standalone capture"). Two rows below misled the Sprint 1 implementation
> and are corrected there: **(a)** the turn's only token count is the per-message
> `assistant.message.outputTokens` — `result.usage` carries **no token fields at all** (this very
> §4 capture already showed `usage = {premiumRequests, totalApiDurationMs, sessionDurationMs,
codeChanges}`); so `output_tokens` rides the `AgentMessage`, not `TurnCompleted`. **(b)** the
> Copilot CLI emits **no `input_tokens`/`total_tokens`** (observed n=2: Sprint 0 + Sprint 7,
> both no-tool turns) — so the `budget.max_total_tokens` ceiling, which gates on `total_tokens`,
> cannot bind on Copilot output (feeds the deferred #8 USD-ceiling follow-up). Whether a
> _tool-using_ turn reports more is still uncaptured.

| Copilot `type`                                               | → `AgentEvent._tag`                                 | notes                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| (process spawn ok, first `assistant.turn_start`)             | `SessionStarted`                                    | synthesize `session_id` from `result.sessionId`/`--session-id`; `turn_id` from `turnId`                        |
| `assistant.turn_start`                                       | (internal turn bookkeeping)                         | not necessarily surfaced                                                                                       |
| `assistant.message`                                          | `AgentMessage` (+ `Notification` for surfaced text) | carries `content`, `toolRequests[]`, per-msg `outputTokens` → `usage.output_tokens` on the `AgentMessage` only |
| `assistant.turn_end` + `result.exitCode == 0`                | `TurnCompleted`                                     | attach `result.usage` (`premium_requests` + `total_api_duration_ms`; **no token counts**)                      |
| `tool.call` for an unsupported tool                          | `UnsupportedToolCall`                               | `tool` = requested name                                                                                        |
| `permission.*` auto-granted (`--allow-all-tools`)            | `ApprovalAutoApproved`                              | high-trust policy                                                                                              |
| `session.error` / `model.call_failure`                       | `TurnFailed` / `TurnEndedWithError`                 | `message` from payload                                                                                         |
| `result.exitCode != 0` (or process exit ≠ 0, or no `result`) | (runner error) `AgentProcessExit`                   | terminal failure → orchestrator retries                                                                        |
| any unrecognized line / bad JSON                             | `Malformed`                                         | `raw` = the line; never crash                                                                                  |

## 9. Open items handed to Sprint 1

- Confirm the exact `session.error` / `model.call_failure` `data` shapes against a
  forced-failure run (the PoC was happy-path only).
- Decide whether to surface `assistant.message_delta` as live streaming output (TUI,
  post-v1) or keep v1 to completed-message granularity.
- Map `--resume`/`--session-id` continuation precisely onto `LiveSession.session_id`.
- Verify `--allow-all-tools` fully suppresses `permission.request` in the target CI/host.

## 10. Reproduce

```bash
# from repo root; uses the already-authenticated copilot CLI (~/.copilot)
mkdir -p /tmp/orchestra-poc && \
COPILOT_AUTO_UPDATE=false copilot -p "Reply with exactly: pong. Do not call any tools." \
  --output-format json -C "/tmp/orchestra-poc" --allow-all-tools --no-color --log-level none \
  | jq -c '{type, dataKeys: (.data | keys?)}'
# (costs ~1 premium request; the PoC's throwaway workspace lived under a gitignored dir)
```
