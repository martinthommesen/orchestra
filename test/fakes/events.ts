import type { AgentEvent, Usage } from "../../src/core/domain/agent-event";

/**
 * Builders for normalized {@link AgentEvent} values used by {@link makeFakeAgentRunner}
 * scripts. They construct the *decoded* domain shape directly (no Schema round-trip),
 * so tests read declaratively: `sessionStarted("s1")`, `turnCompleted(usage)`, etc.
 * Timestamps default to the epoch — irrelevant under `TestClock`, where the loop reads
 * time from the {@link Clock} port, not from event payloads.
 */

const ts = (ms = 0): Date => new Date(ms);

export const sessionStarted = (
  sessionId: string,
  threadId: string = sessionId,
  turnId = "1",
): AgentEvent => ({
  _tag: "SessionStarted",
  timestamp: ts(),
  session_id: sessionId,
  thread_id: threadId,
  turn_id: turnId,
});

export const agentMessage = (text: string): AgentEvent => ({
  _tag: "AgentMessage",
  timestamp: ts(),
  text,
});

export const turnCompleted = (usage?: Usage): AgentEvent => ({
  _tag: "TurnCompleted",
  timestamp: ts(),
  ...(usage ? { usage } : {}),
});
