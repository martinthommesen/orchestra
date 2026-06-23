import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentEvent, Issue, normalizeLabel, ServiceConfig } from "../src/core/domain";

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
