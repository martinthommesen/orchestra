import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  Issue,
  normalizeLabel,
  RetryEntry,
  RunAttempt,
  ServiceConfig,
} from "../src/core/domain";

describe("Issue schema", () => {
  it("decodes a wire issue and normalizes labels to lowercase", () => {
    const issue = Schema.decodeUnknownSync(Issue)({
      id: "iss_1",
      identifier: "ABC-123",
      title: "Do the thing",
      description: null,
      priority: 2,
      state: "In Progress",
      branch_name: null,
      url: null,
      labels: ["  Bug ", "P1", "ready-for-dev"],
      blocked_by: [{ id: "iss_0", identifier: "ABC-100", state: "Todo" }],
      created_at: "2024-01-02T03:04:05.000Z",
      updated_at: null,
    });
    expect(issue.labels).toEqual(["bug", "p1", "ready-for-dev"]);
    expect(issue.created_at).toBeInstanceOf(Date);
    expect((issue.created_at as Date).toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(issue.blocked_by[0]?.identifier).toBe("ABC-100");
  });

  it("normalizeLabel trims and lowercases", () => {
    expect(normalizeLabel("  Ready For Dev ")).toBe("ready for dev");
  });

  it("rejects a missing required field", () => {
    expect(() => Schema.decodeUnknownSync(Issue)({ id: "x" })).toThrow();
  });
});

describe("ServiceConfig schema (front matter defaults, SPEC §6.4)", () => {
  it("decodes an empty map to a fully-defaulted config", () => {
    const cfg = Schema.decodeUnknownSync(ServiceConfig)({});
    expect(cfg.tracker.endpoint).toBe("https://api.github.com");
    expect(cfg.tracker.required_labels).toEqual([]);
    expect(cfg.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(cfg.tracker.terminal_states).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(cfg.polling.interval_ms).toBe(30_000);
    expect(cfg.hooks.timeout_ms).toBe(60_000);
    expect(cfg.agent.max_concurrent_agents).toBe(10);
    expect(cfg.agent.max_turns).toBe(20);
    expect(cfg.agent.max_retry_backoff_ms).toBe(300_000);
    expect(cfg.copilot.command).toBe("copilot");
    expect(cfg.copilot.turn_timeout_ms).toBe(3_600_000);
    expect(cfg.copilot.read_timeout_ms).toBe(5_000);
    expect(cfg.copilot.stall_timeout_ms).toBe(300_000);
  });

  it("strips unknown keys for forward compatibility (SPEC §5.3)", () => {
    const cfg = Schema.decodeUnknownSync(ServiceConfig)({
      tracker: { kind: "github", future_field: "ignored" },
      experimental_block: { anything: true },
    });
    expect(cfg.tracker.kind).toBe("github");
    expect((cfg.tracker as Record<string, unknown>).future_field).toBeUndefined();
    expect((cfg as Record<string, unknown>).experimental_block).toBeUndefined();
  });

  it("overrides defaults when provided", () => {
    const cfg = Schema.decodeUnknownSync(ServiceConfig)({
      polling: { interval_ms: 5000 },
      agent: { max_turns: 3 },
    });
    expect(cfg.polling.interval_ms).toBe(5000);
    expect(cfg.agent.max_turns).toBe(3);
  });

  it("rejects a non-positive max_turns (SPEC: invalid values fail validation)", () => {
    expect(() => Schema.decodeUnknownSync(ServiceConfig)({ agent: { max_turns: 0 } })).toThrow();
  });
});

describe("AgentEvent union (SPEC §10.4)", () => {
  it("decodes a tagged variant and round-trips through encode", () => {
    const decoded = Schema.decodeUnknownSync(AgentEvent)({
      _tag: "SessionStarted",
      timestamp: "2024-05-06T07:08:09.000Z",
      session_id: "thread-1-turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    expect(decoded._tag).toBe("SessionStarted");
    if (decoded._tag === "SessionStarted") {
      expect(decoded.session_id).toBe("thread-1-turn-1");
      expect(decoded.timestamp).toBeInstanceOf(Date);
    }
    const encoded = Schema.encodeSync(AgentEvent)(decoded);
    expect((encoded as { timestamp: string }).timestamp).toBe("2024-05-06T07:08:09.000Z");
  });

  it("carries optional usage on a TurnCompleted", () => {
    const decoded = Schema.decodeUnknownSync(AgentEvent)({
      _tag: "TurnCompleted",
      timestamp: "2024-05-06T07:08:09.000Z",
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });
    if (decoded._tag === "TurnCompleted") {
      expect(decoded.usage?.total_tokens).toBe(30);
    }
  });

  it("rejects an unknown _tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentEvent)({
        _tag: "NotAThing",
        timestamp: "2024-05-06T07:08:09.000Z",
      }),
    ).toThrow();
  });
});

describe("session_id continuity field (#42 — additive, opt-in resume)", () => {
  it("RunAttempt round-trips an optional session_id (present and null)", () => {
    const base = {
      issue_id: "i1",
      issue_identifier: "ORC-1",
      attempt: 2,
      workspace_path: "/ws/ORC-1",
      started_at: "2026-06-24T10:00:00.000Z",
      status: "StreamingTurn" as const,
    };
    const withId = Schema.decodeUnknownSync(RunAttempt)({ ...base, session_id: "sess-abc" });
    expect(withId.session_id).toBe("sess-abc");
    expect(Schema.encodeSync(RunAttempt)(withId).session_id).toBe("sess-abc");

    const withNull = Schema.decodeUnknownSync(RunAttempt)({ ...base, session_id: null });
    expect(withNull.session_id).toBeNull();
  });

  it("RunAttempt decodes a pre-#42 checkpoint with session_id ABSENT", () => {
    const decoded = Schema.decodeUnknownSync(RunAttempt)({
      issue_id: "i1",
      issue_identifier: "ORC-1",
      attempt: null,
      workspace_path: "/ws/ORC-1",
      started_at: "2026-06-24T10:00:00.000Z",
      status: "PreparingWorkspace",
    });
    expect(decoded.session_id).toBeUndefined();
  });

  it("RetryEntry round-trips an optional session_id on a continuation retry", () => {
    const decoded = Schema.decodeUnknownSync(RetryEntry)({
      issue_id: "i1",
      identifier: "ORC-1",
      attempt: 2,
      due_at_ms: 123,
      kind: "continuation",
      session_id: "sess-xyz",
      error: null,
    });
    expect(decoded.session_id).toBe("sess-xyz");
    expect(Schema.encodeSync(RetryEntry)(decoded).session_id).toBe("sess-xyz");

    // Pre-#42 entry: session_id absent → undefined, still decodes.
    const legacy = Schema.decodeUnknownSync(RetryEntry)({
      issue_id: "i1",
      identifier: "ORC-1",
      attempt: 1,
      due_at_ms: 1,
      error: "boom",
    });
    expect(legacy.session_id).toBeUndefined();
  });
});
