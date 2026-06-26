import type { AgentEvent, Usage } from "../../core/domain/agent-event";
import {
  type AgentError,
  AgentProcessExit,
  ResponseError,
  TurnFailed,
  TurnInputRequired,
} from "../../core/errors";

/**
 * Pure Copilot-JSONL → {@link AgentEvent} mapper (Task 9, per the Sprint 0 spike's
 * mapping table in `docs/sprint-0/spike-copilot.md` §8). Kept transport-free and
 * unit-tested so the orchestrator-facing vocabulary is verified without spawning a
 * process. The streaming runner ({@link file://./copilot-runner.ts}) feeds it one
 * stdout line at a time and acts on the returned {@link MappedLine}.
 *
 * Contract: **never throw**. Unparseable / typeless lines become a `Malformed` event;
 * recognized-but-unsurfaced events (status noise, streaming deltas) are dropped; only
 * the handful that matter are surfaced, and `terminal` marks the end of the turn.
 */

/** How a mapped line ends the turn, if at all. */
export type Terminal =
  | { readonly _tag: "completed"; readonly usage?: Usage }
  | { readonly _tag: "failed"; readonly error: AgentError };

/** Events to emit downstream for one line, plus an optional terminal signal. */
export interface MappedLine {
  readonly events: ReadonlyArray<AgentEvent>;
  readonly terminal?: Terminal;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
// Finite-only: a vendor JSON number can be non-finite (`1e400` parses to `Infinity`,
// `typeof === "number"`), which would silently corrupt the durable checkpoint —
// `runtime_seconds` accumulates `total_api_duration_ms`, and `JSON.stringify(Infinity)`
// emits `null`, which then fails the strict re-decode on the next boot and discards the
// whole state file. A non-finite measurement is meaningless; drop it like any non-number.
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const parseTimestamp = (raw: unknown, fallback: Date): Date => {
  const s = str(raw);
  if (s !== undefined) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return fallback;
};

/**
 * Map Copilot's terminal `result.usage` into the normalized {@link Usage}. Observed live
 * (Sprint 7, `docs/sprint-7/captured-jsonl.raw`): `result.usage` carries only request /
 * duration accounting (`premiumRequests`, `totalApiDurationMs`, plus `sessionDurationMs` and
 * a `codeChanges` summary we don't surface) — it reports **no token counts**. Per-message
 * `output_tokens` arrives on `assistant.message` instead (see that case below).
 */
export const mapUsage = (raw: unknown): Usage | undefined => {
  const o = asRecord(raw);
  const usage: Record<string, number> = {};
  const premium = num(o.premiumRequests);
  const apiMs = num(o.totalApiDurationMs);
  if (premium !== undefined) usage.premium_requests = premium;
  if (apiMs !== undefined) usage.total_api_duration_ms = apiMs;
  return Object.keys(usage).length > 0 ? (usage as Usage) : undefined;
};

const malformed = (line: string, ts: Date): MappedLine => ({
  events: [{ _tag: "Malformed", timestamp: ts, raw: line }],
});

/**
 * Map one Copilot stdout JSONL line. `now` is the fallback timestamp when the line
 * carries none (e.g. a malformed line).
 */
export const mapCopilotLine = (line: string, now: Date): MappedLine => {
  const trimmed = line.trim();
  if (trimmed === "") {
    return { events: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return malformed(line, now);
  }
  if (typeof json !== "object" || json === null) {
    return malformed(line, now);
  }
  const obj = json as Record<string, unknown>;
  const type = str(obj.type) ?? "";
  const ts = parseTimestamp(obj.timestamp, now);
  const data = asRecord(obj.data);

  switch (type) {
    case "result": {
      // Terminal: dual success signal is `result.exitCode` (and the process exit). A clean
      // turn is exitCode 0; an entirely absent field keeps the historical "completed"
      // default. But a PRESENT-but-non-numeric value (e.g. the string "5") must NOT coerce
      // to success — that would mask a failed turn (and the runner's `sawCompleted` latch
      // would then also swallow the process's own non-zero exit). Map any present
      // non-numeric/non-finite code to a non-zero (failure) exit.
      const rawExit = obj.exitCode;
      const exitCode =
        rawExit === undefined
          ? 0
          : typeof rawExit === "number" && Number.isFinite(rawExit)
            ? rawExit
            : 1;
      const usage = mapUsage(obj.usage);
      if (exitCode === 0) {
        return {
          events: [{ _tag: "TurnCompleted", timestamp: ts, ...(usage ? { usage } : {}) }],
          terminal: { _tag: "completed", ...(usage ? { usage } : {}) },
        };
      }
      return {
        events: [],
        terminal: { _tag: "failed", error: new AgentProcessExit({ code: exitCode, signal: null }) },
      };
    }

    case "assistant.message": {
      // The substantive payload: assistant text. Live Copilot reports this message's
      // output-token count here (`data.outputTokens`) — `result.usage` carries none — so the
      // turn's token total is the sum of these. The orchestrator folds `usage` per event
      // (loop.ts `handleAgentEvent`), so attach it to the AgentMessage ONLY: also tagging the
      // sibling Notification would double-count the same tokens.
      const text = str(data.content);
      const outputTokens = num(data.outputTokens);
      const usage = outputTokens !== undefined ? { output_tokens: outputTokens } : undefined;
      const events: AgentEvent[] = [
        {
          _tag: "AgentMessage",
          timestamp: ts,
          ...(text ? { text } : {}),
          ...(usage ? { usage } : {}),
        },
      ];
      if (text !== undefined && text.trim() !== "") {
        events.push({ _tag: "Notification", timestamp: ts, message: text });
      }
      return { events };
    }

    case "session.error": {
      const message = str(data.message) ?? "session error";
      return {
        events: [{ _tag: "TurnFailed", timestamp: ts, message }],
        terminal: { _tag: "failed", error: new TurnFailed({ message }) },
      };
    }

    case "model.call_failure": {
      const message = str(data.message) ?? "model call failure";
      return {
        events: [{ _tag: "TurnEndedWithError", timestamp: ts, message }],
        terminal: { _tag: "failed", error: new ResponseError({ message }) },
      };
    }

    case "turn_input_required":
    case "assistant.turn_input_required": {
      const prompt = str(data.prompt);
      return {
        events: [{ _tag: "TurnInputRequired", timestamp: ts, ...(prompt ? { prompt } : {}) }],
        terminal: {
          _tag: "failed",
          error: new TurnInputRequired(prompt !== undefined ? { prompt } : {}),
        },
      };
    }

    default: {
      // If the CLI ever surfaces an explicit permission decision, record it. NOTE: the Sprint 7
      // tool-use capture (`test/fixtures/copilot-jsonl/tool-use.jsonl`) shows that under
      // `--allow-all-tools` — the only mode the runner spawns — Copilot emits **no `permission.*`
      // events at all**; tools just run (`tool.execution_*`). This branch is therefore unexercised
      // in practice, kept only as a forward-safe net for other approval modes.
      if (type.startsWith("permission.")) {
        const kind = str(data.tool) ?? type;
        return { events: [{ _tag: "ApprovalAutoApproved", timestamp: ts, kind }] };
      }
      // Everything else recognized-but-unsurfaced is dropped for forward-compatibility — turn
      // start/end, streaming/reasoning deltas (`assistant.message_delta`, `assistant.reasoning*`),
      // tool execution (`tool.execution_start|partial_result|complete`), and the ephemeral
      // `session.*` status/background-task noise. A tool-call `assistant.message` (empty `content`
      // + `toolRequests`) maps to a benign empty AgentMessage above. A line with no `type` is
      // structurally unexpected → Malformed so visibility is preserved.
      return type === "" ? malformed(line, ts) : { events: [] };
    }
  }
};
