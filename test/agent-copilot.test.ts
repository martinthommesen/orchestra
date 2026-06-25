import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Deferred, Duration, Effect, Fiber, Schema, Stream } from "effect";
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

// Emits the terminal `result` with NO trailing newline (printf, not echo) — the splitter
// must still flush the final partial segment or the turn would look like a crash (#22).
const NO_TRAILING_NEWLINE = `#!/bin/sh
printf '{"type":"result","exitCode":0,"usage":{"outputTokens":4}}'
exit 0
`;

const ENV_SCRUB = `#!/bin/sh
printf "%s" "$ORCHESTRA_COCKPIT_TOKEN" > cockpit-token.txt
printf "%s" "$GITHUB_TOKEN" > github-token.txt
echo '{"type":"result","exitCode":0}'
exit 0
`;

// Replaces the shell image with sleep so the spawned PID is exactly the one the run scope
// must SIGTERM on interrupt — no lingering grandchild to leak (#22).
const HANG = `#!/bin/sh
exec sleep 30
`;

/** Is `pid` still a live OS process? `kill(pid, 0)` throws ESRCH once it is gone. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll (live clock) until `pid` is no longer alive, up to ~5s. */
const waitUntilDead = (pid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 250; i++) {
      if (!isAlive(pid)) {
        return;
      }
      yield* Effect.sleep(Duration.millis(20));
    }
  });

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

  it.scopedLive("recognizes a final result line with no trailing newline (#22)", () =>
    runFakeCopilot(NO_TRAILING_NEWLINE, (events, exit) => {
      // The splitter must flush the unterminated final segment; otherwise the terminal
      // `result` is lost and the clean turn is misread as an AgentProcessExit crash.
      expect(exit._tag).toBe("Success");
      const tags = events.map((e) => e._tag);
      expect(tags).toContain("TurnCompleted");
      expect(tags.at(-1)).toBe("TurnCompleted");
    }),
  );

  it.scopedLive("scrubs daemon-only environment variables from the child process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.ORCHESTRA_COCKPIT_TOKEN;
          process.env.ORCHESTRA_COCKPIT_TOKEN = "daemon-token-must-not-leak"; // gitleaks:allow — fake fixture token
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.ORCHESTRA_COCKPIT_TOKEN;
            } else {
              process.env.ORCHESTRA_COCKPIT_TOKEN = previous;
            }
          }),
      );

      const ws = yield* runFakeCopilot(ENV_SCRUB, (events, exit) => {
        expect(exit._tag).toBe("Success");
        expect(events.map((e) => e._tag)).toContain("TurnCompleted");
      });

      expect(yield* fs.readFileString(`${ws}/cockpit-token.txt`)).toBe("");
      expect(yield* fs.readFileString(`${ws}/github-token.txt`)).toBe("t");
    }).pipe(Effect.provide(platform)),
  );

  it.scopedLive("interrupting a worker SIGTERMs the subprocess (no orphan) (#22)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-copilot-kill-" });
      const ws = `${root}/work`;
      yield* fs.makeDirectory(ws, { recursive: true });
      const bin = `${root}/fake-copilot`;
      yield* fs.writeFileString(bin, HANG);
      yield* fs.chmod(bin, 0o755);

      const runner = yield* Effect.provide(AgentRunner, layerCopilotRunner(config(bin)));
      const params = {
        issue: makeIssue({ id: "1", identifier: "ABC-1", state: "Todo" }),
        workspacePath: ws,
        prompt: "hang",
        attempt: null,
      } as const;

      // Drive the worker in a forked fiber and capture the child PID from SessionStarted.
      const pidLatch = yield* Deferred.make<number>();
      const fiber = yield* Effect.forkScoped(
        runner.run(params).pipe(
          Stream.tap((e) =>
            e._tag === "SessionStarted" && e.agent_pid != null
              ? Deferred.succeed(pidLatch, Number(e.agent_pid))
              : Effect.void,
          ),
          Stream.runDrain,
        ),
      );

      const pid = yield* Deferred.await(pidLatch);
      expect(isAlive(pid)).toBe(true);

      // Interrupting the worker must close the run scope, whose finalizer SIGTERMs the child.
      yield* Fiber.interrupt(fiber);
      yield* waitUntilDead(pid);
      expect(isAlive(pid)).toBe(false);
    }).pipe(Effect.provide(platform)),
  );
});
