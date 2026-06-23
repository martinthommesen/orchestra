import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Effect, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import { layerCopilotRunner } from "../src/adapters/agent-copilot/copilot-runner";
import { mapCopilotLine, mapUsage } from "../src/adapters/agent-copilot/map";
import { ServiceConfig } from "../src/core/domain/workflow";
import { AgentRunner } from "../src/core/ports/agent-runner";
import { makeIssue } from "./fakes/harness";

const NOW = new Date("2026-01-01T00:00:00.000Z");

// ───────────────────────────── pure mapper ─────────────────────────────

describe("mapCopilotLine (JSONL → AgentEvent)", () => {
  it("drops blank lines", () => {
    expect(mapCopilotLine("   ", NOW)).toEqual({ events: [] });
  });

  it("maps unparseable lines to Malformed", () => {
    const r = mapCopilotLine("{not json", NOW);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?._tag).toBe("Malformed");
  });

  it("maps a typeless object to Malformed", () => {
    const r = mapCopilotLine(JSON.stringify({ data: {} }), NOW);
    expect(r.events[0]?._tag).toBe("Malformed");
  });

  it("maps assistant.message to AgentMessage + Notification", () => {
    const r = mapCopilotLine(
      JSON.stringify({ type: "assistant.message", data: { role: "assistant", content: "pong" } }),
      NOW,
    );
    expect(r.events.map((e) => e._tag)).toEqual(["AgentMessage", "Notification"]);
    const msg = r.events[0];
    if (msg?._tag === "AgentMessage") {
      expect(msg.text).toBe("pong");
      expect(msg.role).toBe("assistant");
    }
    expect(r.terminal).toBeUndefined();
  });

  it("emits only AgentMessage when the message has no text", () => {
    const r = mapCopilotLine(JSON.stringify({ type: "assistant.message", data: {} }), NOW);
    expect(r.events.map((e) => e._tag)).toEqual(["AgentMessage"]);
  });

  it("maps a successful result to TurnCompleted + completed terminal", () => {
    const r = mapCopilotLine(
      JSON.stringify({
        type: "result",
        exitCode: 0,
        usage: { premiumRequests: 2, outputTokens: 4 },
      }),
      NOW,
    );
    expect(r.events.map((e) => e._tag)).toEqual(["TurnCompleted"]);
    expect(r.terminal?._tag).toBe("completed");
    if (r.terminal?._tag === "completed") {
      expect(r.terminal.usage?.premium_requests).toBe(2);
      expect(r.terminal.usage?.output_tokens).toBe(4);
    }
  });

  it("maps a non-zero result to a failed terminal (AgentProcessExit)", () => {
    const r = mapCopilotLine(JSON.stringify({ type: "result", exitCode: 2 }), NOW);
    expect(r.events).toEqual([]);
    expect(r.terminal?._tag).toBe("failed");
    if (r.terminal?._tag === "failed") {
      expect(r.terminal.error._tag).toBe("AgentProcessExit");
    }
  });

  it("maps session.error to TurnFailed + failed terminal", () => {
    const r = mapCopilotLine(
      JSON.stringify({ type: "session.error", data: { message: "boom" } }),
      NOW,
    );
    expect(r.events[0]?._tag).toBe("TurnFailed");
    if (r.terminal?._tag === "failed") {
      expect(r.terminal.error._tag).toBe("TurnFailed");
    }
  });

  it("maps model.call_failure to TurnEndedWithError + ResponseError terminal", () => {
    const r = mapCopilotLine(
      JSON.stringify({ type: "model.call_failure", data: { message: "503" } }),
      NOW,
    );
    expect(r.events[0]?._tag).toBe("TurnEndedWithError");
    if (r.terminal?._tag === "failed") {
      expect(r.terminal.error._tag).toBe("ResponseError");
    }
  });

  it("maps turn_input_required to a failed terminal (TurnInputRequired)", () => {
    const r = mapCopilotLine(
      JSON.stringify({ type: "turn_input_required", data: { prompt: "need a token" } }),
      NOW,
    );
    expect(r.events[0]?._tag).toBe("TurnInputRequired");
    if (r.terminal?._tag === "failed") {
      expect(r.terminal.error._tag).toBe("TurnInputRequired");
    }
  });

  it("maps permission.* to ApprovalAutoApproved", () => {
    const r = mapCopilotLine(
      JSON.stringify({ type: "permission.completed", data: { tool: "shell" } }),
      NOW,
    );
    expect(r.events[0]?._tag).toBe("ApprovalAutoApproved");
  });

  it("drops recognized-but-unsurfaced events without crashing", () => {
    for (const type of ["session.idle", "assistant.turn_start", "assistant.message_delta"]) {
      expect(mapCopilotLine(JSON.stringify({ type, ephemeral: true }), NOW)).toEqual({
        events: [],
      });
    }
  });
});

describe("mapUsage", () => {
  it("maps camelCase Copilot usage to normalized fields", () => {
    expect(
      mapUsage({
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        premiumRequests: 4,
        totalApiDurationMs: 5,
      }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      premium_requests: 4,
      total_api_duration_ms: 5,
    });
  });
  it("returns undefined when nothing usable is present", () => {
    expect(mapUsage({})).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
  });
});

// ───────────────────────── subprocess integration ─────────────────────────

const platform = NodeContext.layer;

const config = (command: string): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)({
    tracker: { kind: "github", repo: "o/r", api_key: "t" },
    copilot: { command },
  });

/** Stand up a fake `copilot` script + a workspace dir, then run the real runner. */
const runFakeCopilot = (
  script: string,
  body: (
    events: ReadonlyArray<{ readonly _tag: string }>,
    exit: { readonly _tag: "Success" | "Failure"; readonly cause?: unknown },
  ) => void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-copilot-" });
    const ws = `${root}/work`;
    yield* fs.makeDirectory(ws, { recursive: true });
    const bin = `${root}/fake-copilot`;
    yield* fs.writeFileString(bin, script);
    yield* fs.chmod(bin, 0o755);

    const runner = yield* Effect.provide(AgentRunner, layerCopilotRunner(config(bin)));
    const params = {
      issue: makeIssue({ id: "1", identifier: "ABC-1", state: "Todo" }),
      workspacePath: ws,
      prompt: "do the thing",
      attempt: null,
    } as const;

    const exit = yield* Effect.exit(Stream.runCollect(runner.run(params)));
    const events =
      exit._tag === "Success" ? Chunk.toReadonlyArray(exit.value) : ([] as ReadonlyArray<never>);
    body(events, exit);
    return ws;
  }).pipe(Effect.provide(platform));

const HAPPY = `#!/bin/sh
echo "$PWD" > cwd.txt
echo '{"type":"session.idle","ephemeral":true}'
echo '{"type":"assistant.message","data":{"role":"assistant","content":"pong"}}'
echo '{"type":"result","exitCode":0,"usage":{"premiumRequests":2,"outputTokens":4}}'
exit 0
`;

const CRASH = `#!/bin/sh
echo '{"type":"assistant.message","data":{"content":"partial"}}'
exit 5
`;

const SESSION_ERROR = `#!/bin/sh
echo '{"type":"session.error","data":{"message":"upstream exploded"}}'
echo '{"type":"result","exitCode":0}'
exit 0
`;

describe("CopilotRunner (subprocess)", () => {
  it.scopedLive("streams SessionStarted → events → TurnCompleted on a clean turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ws = yield* runFakeCopilot(HAPPY, (events, exit) => {
        expect(exit._tag).toBe("Success");
        const tags = events.map((e) => e._tag);
        expect(tags[0]).toBe("SessionStarted");
        expect(tags).toContain("AgentMessage");
        expect(tags).toContain("Notification");
        expect(tags.at(-1)).toBe("TurnCompleted");
      });
      // The relative `cwd.txt` exists *at the workspace path* ⇒ Safety Invariant 1 held.
      expect(yield* fs.exists(`${ws}/cwd.txt`)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );

  it.scopedLive("fails the stream with AgentProcessExit when the process crashes", () =>
    runFakeCopilot(CRASH, (_events, exit) => {
      expect(exit._tag).toBe("Failure");
      expect(String(exit.cause)).toContain("AgentProcessExit");
    }),
  );

  it.scopedLive("fails the stream when a session.error terminal arrives", () =>
    runFakeCopilot(SESSION_ERROR, (_events, exit) => {
      // runCollect discards buffered events on failure; the cause carries the error.
      expect(exit._tag).toBe("Failure");
      expect(String(exit.cause)).toContain("TurnFailed");
    }),
  );
});
