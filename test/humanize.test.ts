import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentEvent } from "../src/core/domain/agent-event";
import { AGENT_EVENT_SUMMARIES, humanizeAgentEvent } from "../src/core/observability/humanize";

/**
 * Sprint 5 / #55 — pure coverage for the agent-event humanizer. Known tags map to friendly
 * one-liners; unknown tags fall back to the raw label; the result is never blank; and the
 * map covers exactly the tags the `AgentEvent` union actually emits (no speculative
 * taxonomy). The wiring (logfmt line + LiveActivity message + cockpit per-session activity
 * label) is proven in `live-observer.test.ts`, `recent-events.test.ts`, and the cockpit Fleet
 * mapper suite (`cockpit-fleet.test.ts`, which asserts `running[].lastActivityLabel`).
 */

// The literal tags the AgentEvent union actually emits (the humanizer maps exactly these,
// with a raw-label fallback for anything unseen). `Record<AgentEventTag, string>` already
// enforces exhaustiveness at compile time; these runtime checks guard the count/keys too.
const TAGS: ReadonlyArray<string> = [
  "SessionStarted",
  "StartupFailed",
  "TurnCompleted",
  "TurnFailed",
  "TurnCancelled",
  "TurnEndedWithError",
  "TurnInputRequired",
  "ApprovalAutoApproved",
  "UnsupportedToolCall",
  "Notification",
  "AgentMessage",
  "Malformed",
];

describe("humanizeAgentEvent (#55)", () => {
  it("maps every known tag to a non-empty friendly summary", () => {
    for (const tag of TAGS) {
      const summary = humanizeAgentEvent(tag);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toBe(AGENT_EVENT_SUMMARIES[tag as keyof typeof AGENT_EVENT_SUMMARIES]);
    }
  });

  it("maps representative tags to their expected operator summaries", () => {
    expect(humanizeAgentEvent("SessionStarted")).toBe("started session");
    expect(humanizeAgentEvent("TurnCompleted")).toBe("finished turn");
    expect(humanizeAgentEvent("TurnFailed")).toBe("turn failed");
    expect(humanizeAgentEvent("TurnInputRequired")).toBe("waiting for input");
    expect(humanizeAgentEvent("UnsupportedToolCall")).toBe("requested an unsupported tool");
    expect(humanizeAgentEvent("AgentMessage")).toBe("working");
  });

  it("falls back to the raw label for an unknown tag (never blank)", () => {
    expect(humanizeAgentEvent("SomeFutureTag")).toBe("SomeFutureTag");
    expect(humanizeAgentEvent("turn_completed")).toBe("turn_completed");
  });

  it("never returns blank, even for an empty or whitespace tag", () => {
    expect(humanizeAgentEvent("")).toBe("agent event");
    expect(humanizeAgentEvent("   ")).toBe("agent event");
    expect(humanizeAgentEvent("\n\t")).toBe("agent event");
  });

  it("covers exactly the tags the AgentEvent union emits (no speculative taxonomy)", () => {
    expect(new Set(Object.keys(AGENT_EVENT_SUMMARIES))).toEqual(new Set(TAGS));
    expect(AgentEvent.members.length).toBe(TAGS.length);
  });

  it("is total and never blank over an arbitrary string (property)", () => {
    // Bias the input domain to include the `Object.prototype` member names that
    // previously slipped through a prototype-chain lookup (#60). Including them
    // explicitly makes that class of regression fail every run, not ~1-in-8.
    const PROTOTYPE_KEYS = [
      "toString",
      "valueOf",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    const tag = fc.oneof(fc.string(), fc.constantFrom(...PROTOTYPE_KEYS));
    fc.assert(
      fc.property(tag, (t) => {
        const summary = humanizeAgentEvent(t);
        return typeof summary === "string" && summary.length > 0;
      }),
    );
  });
});
