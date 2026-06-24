import type { AgentEventTag } from "../domain/agent-event";

/**
 * Sprint 5 / #55 — **pure agent-event humanizer**. The `AgentEvent` observation carries a
 * raw `eventTag` (one of the {@link AgentEventTag} `_tag`s the runner normalizes to). On its
 * own that reads fairly raw in the logfmt line and the dashboard's per-session activity
 * label; this maps each known tag to a friendly, operator-facing one-liner
 * ("started session", "finished turn", "waiting for input") while the caller keeps the raw
 * tag on the wire for fidelity/debugging.
 *
 * Design rules (mirroring `glyphs.ts`): a pure, total function, no Effect, no IO — safe to
 * call from any layer. Crucially it is **display-only** and maps **by tag only**: it never
 * echoes any agent payload text (messages, prompts, tool args), so a summary can never leak
 * issue content into logs/snapshots (PROJECT_BRIEF §9.2).
 *
 * The map is typed `Record<AgentEventTag, string>` so adding a new event variant to the
 * union forces a compile error here — the humanizer can never silently miss a known tag.
 * Unknown/unmapped tags fall back to the raw label, and a (defensively) blank tag falls back
 * to a generic label, so a humanized summary is **never blank**.
 */

/** Friendly one-line summary for each known agent-event tag. */
export const AGENT_EVENT_SUMMARIES: Record<AgentEventTag, string> = {
  SessionStarted: "started session",
  StartupFailed: "failed to start session",
  TurnCompleted: "finished turn",
  TurnFailed: "turn failed",
  TurnCancelled: "turn cancelled",
  TurnEndedWithError: "turn ended with error",
  TurnInputRequired: "waiting for input",
  ApprovalAutoApproved: "auto-approved an action",
  UnsupportedToolCall: "requested an unsupported tool",
  Notification: "sent a notification",
  AgentMessage: "working",
  Malformed: "emitted an unrecognized event",
};

/** Fallback when an event tag is itself blank (defensive — tags are normally non-empty). */
const GENERIC_AGENT_EVENT = "agent event";

/**
 * Map a raw agent-event tag to a friendly operator summary. Total and never blank:
 *   - a known tag → its mapped summary;
 *   - an unknown tag → the raw tag verbatim (fidelity over invention);
 *   - a blank/whitespace tag → a generic label, never an empty string.
 */
export const humanizeAgentEvent = (eventTag: string): string => {
  const mapped = AGENT_EVENT_SUMMARIES[eventTag as AgentEventTag];
  if (mapped !== undefined) {
    return mapped;
  }
  const raw = eventTag.trim();
  return raw.length > 0 ? raw : GENERIC_AGENT_EVENT;
};
