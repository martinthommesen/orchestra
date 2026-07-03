import { readFileSync } from "node:fs";
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

  it("maps assistant.message to AgentMessage + Notification, with output tokens on the AgentMessage only", () => {
    const r = mapCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: { content: "pong", model: "claude-opus-4.8", outputTokens: 5 },
      }),
      NOW,
    );
    expect(r.events.map((e) => e._tag)).toEqual(["AgentMessage", "Notification"]);
    const [msg, note] = r.events;
    if (msg?._tag === "AgentMessage") {
      expect(msg.text).toBe("pong");
      // Per-message token count lives on `assistant.message` (the terminal `result` carries
      // none). The orchestrator folds `usage` per event, so it rides the AgentMessage ONLY —
      // tagging the sibling Notification too would double-count the same 5 tokens.
      expect(msg.usage?.output_tokens).toBe(5);
    }
    expect(note?.usage).toBeUndefined();
    expect(r.terminal).toBeUndefined();
  });

  it("emits only AgentMessage when the message has no text", () => {
    const r = mapCopilotLine(JSON.stringify({ type: "assistant.message", data: {} }), NOW);
    expect(r.events.map((e) => e._tag)).toEqual(["AgentMessage"]);
  });

  it("maps a successful result to TurnCompleted + completed terminal (request/duration usage, no tokens)", () => {
    // Observed live: `result.usage` reports request/duration accounting only — no token
    // counts (those arrive per `assistant.message`). `sessionDurationMs`/`codeChanges` are
    // present in the wire shape but deliberately not surfaced into normalized Usage.
    const r = mapCopilotLine(
      JSON.stringify({
        type: "result",
        exitCode: 0,
        usage: {
          premiumRequests: 15,
          totalApiDurationMs: 1748,
          sessionDurationMs: 8859,
          codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        },
      }),
      NOW,
    );
    expect(r.events.map((e) => e._tag)).toEqual(["TurnCompleted"]);
    expect(r.terminal?._tag).toBe("completed");
    if (r.terminal?._tag === "completed") {
      expect(r.terminal.usage?.premium_requests).toBe(15);
      expect(r.terminal.usage?.total_api_duration_ms).toBe(1748);
      expect(r.terminal.usage?.output_tokens).toBeUndefined();
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

  it("treats a present-but-non-numeric exitCode as a failure, not success (DEF-006)", () => {
    // A `result` whose exitCode is the STRING "5" must NOT be coerced to a clean turn — that
    // would mask a failed turn and the runner's sawCompleted latch would then also swallow
    // the process's own non-zero exit.
    const r = mapCopilotLine(JSON.stringify({ type: "result", exitCode: "5" }), NOW);
    expect(r.terminal?._tag).toBe("failed");
    if (r.terminal?._tag === "failed") {
      expect(r.terminal.error._tag).toBe("AgentProcessExit");
    }
  });

  it("keeps the completed default for a result with no exitCode field", () => {
    const r = mapCopilotLine(JSON.stringify({ type: "result", usage: { outputTokens: 1 } }), NOW);
    expect(r.terminal?._tag).toBe("completed");
  });

  it("drops an overflowing duration parsed from a raw result line (DEF-002)", () => {
    // JSON.parse turns an overflowing literal (1e400) into Infinity; left in usage it would
    // make runtime_seconds non-finite and corrupt the durable checkpoint on the next boot.
    // The non-finite duration is dropped while a finite sibling field (premiumRequests) survives.
    const r = mapCopilotLine(
      '{"type":"result","exitCode":0,"usage":{"totalApiDurationMs":1e400,"premiumRequests":4}}',
      NOW,
    );
    expect(r.terminal?._tag).toBe("completed");
    if (r.terminal?._tag === "completed") {
      expect(r.terminal.usage?.total_api_duration_ms).toBeUndefined();
      expect(r.terminal.usage?.premium_requests).toBe(4);
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

  it("maps recognized-but-unsurfaced events to a single AgentProgress (liveness pulse)", () => {
    for (const type of ["session.idle", "assistant.turn_start", "assistant.message_delta"]) {
      const r = mapCopilotLine(JSON.stringify({ type, ephemeral: true }), NOW);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?._tag).toBe("AgentProgress");
      expect(r.terminal).toBeUndefined();
    }
  });

  it("maps tool.execution_* and assistant.reasoning* lines to AgentProgress (not dropped)", () => {
    for (const type of [
      "tool.execution_start",
      "tool.execution_complete",
      "tool.execution_partial_result",
      "assistant.reasoning",
      "assistant.reasoning_summary",
    ]) {
      const r = mapCopilotLine(JSON.stringify({ type, data: {} }), NOW);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?._tag).toBe("AgentProgress");
      expect(r.terminal).toBeUndefined();
    }
  });

  it("empty/whitespace lines still yield no events (blank output is not work)", () => {
    expect(mapCopilotLine("", NOW)).toEqual({ events: [] });
    expect(mapCopilotLine("   \t  ", NOW)).toEqual({ events: [] });
  });

  it("falls back to the injected `now` for a missing or invalid timestamp (never throws)", () => {
    const missing = mapCopilotLine(
      JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
      NOW,
    );
    expect(missing.events[0]?.timestamp).toEqual(NOW);
    const invalid = mapCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        timestamp: "not-a-date",
        data: { content: "hi" },
      }),
      NOW,
    );
    expect(invalid.events[0]?.timestamp).toEqual(NOW);
  });
});

describe("mapUsage", () => {
  it("maps the observed result.usage request/duration fields, ignoring non-usage extras", () => {
    expect(
      mapUsage({
        premiumRequests: 15,
        totalApiDurationMs: 1748,
        sessionDurationMs: 8859,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
      }),
    ).toEqual({
      premium_requests: 15,
      total_api_duration_ms: 1748,
    });
  });
  it("returns undefined when nothing usable is present", () => {
    expect(mapUsage({})).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
    // `result.usage` with only the non-token extras yields no normalized Usage.
    expect(mapUsage({ sessionDurationMs: 10, codeChanges: { filesModified: [] } })).toBeUndefined();
  });
});

// ─────────────────────── mapper pinned to the live capture ───────────────────────
// Reconciles map.ts to *observed* Copilot output (Sprint 7 standalone smoke; raw at
// docs/sprint-7/captured-jsonl.raw, scrubbed + trimmed into this fixture), superseding the
// Sprint 0 spike's assumed mapping table. NOTE: this is the trivial no-tool "Print DONE" turn
// — it pins the streaming + terminal/usage paths only. Tool-use paths (permission.*,
// toolRequests, multi-message turns, error terminals) are NOT exercised and remain pinned to
// spike assumptions until a tool-using run is captured (see docs/sprint-7/progress.md F2).
describe("mapCopilotLine pinned to the live standalone capture", () => {
  const lines = readFileSync(
    new URL("./fixtures/copilot-jsonl/standalone-result.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim() !== "");

  it("maps every captured line without a single Malformed event", () => {
    const tags = lines.flatMap((l) => mapCopilotLine(l, NOW).events.map((e) => e._tag));
    expect(tags).not.toContain("Malformed");
  });

  it("reaches exactly one terminal, completed, at the result line", () => {
    const terminals = lines.map((l) => mapCopilotLine(l, NOW).terminal).filter((t) => t != null);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?._tag).toBe("completed");
  });

  it("accounts the turn's output tokens exactly once across the whole stream", () => {
    // The only token count Copilot emits is the per-`assistant.message` `outputTokens` (5);
    // summed over every emitted event it must total 5 — proving it rides exactly one event,
    // not both AgentMessage and its sibling Notification.
    const total = lines
      .flatMap((l) => mapCopilotLine(l, NOW).events)
      .reduce((n, e) => n + (e.usage?.output_tokens ?? 0), 0);
    expect(total).toBe(5);
  });
});

// ─────────────────── mapper pinned to a TOOL-USING capture ───────────────────
// Sprint 7 / #78 — the happy-path fixture above is no-tool. This second capture forces shell +
// file-write tools, exercising the paths the spike got wrong: the agent emits `tool.execution_*`
// (NOT `tool.call`) and — under `--allow-all-tools` — **no `permission.*` events at all**, plus
// `assistant.reasoning*` and `session.background_tasks_changed`. The point is that the mapper is
// *robust* to all of it: every unrecognized family falls through to the forward-compat drop, so
// the stream maps with ZERO Malformed and no functional map.ts change was needed for tool use.
describe("mapCopilotLine pinned to a tool-using capture (#78)", () => {
  const lines = readFileSync(
    new URL("./fixtures/copilot-jsonl/tool-use.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim() !== "");

  it("maps a real tool-using turn with zero Malformed and one completed terminal", () => {
    const events = lines.flatMap((l) => mapCopilotLine(l, NOW).events);
    expect(events.map((e) => e._tag)).not.toContain("Malformed");
    const terminals = lines.map((l) => mapCopilotLine(l, NOW).terminal).filter((t) => t != null);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?._tag).toBe("completed");
  });

  it("maps tool-execution / reasoning event families to AgentProgress liveness pulses", () => {
    // tool.execution_* and assistant.reasoning* are recognized non-empty subprocess lines —
    // each now produces exactly one AgentProgress to refresh the stall clock.
    // A tool-call `assistant.message` (empty `content` + toolRequests) stays a benign
    // empty AgentMessage (no Notification); the `session.*` / `background_tasks_changed`
    // lines also surface an AgentProgress (all liveness, no stall).
    for (const type of ["tool.execution_start", "tool.execution_complete", "assistant.reasoning"]) {
      const line = lines.find((l) => (JSON.parse(l) as { type?: string }).type === type);
      expect(line, `fixture is missing a ${type} line`).toBeDefined();
      const r = mapCopilotLine(line as string, NOW);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?._tag).toBe("AgentProgress");
      expect(r.terminal).toBeUndefined();
    }
  });

  it("sums per-message output tokens across the multi-message turn", () => {
    const total = lines
      .flatMap((l) => mapCopilotLine(l, NOW).events)
      .reduce((n, e) => n + (e.usage?.output_tokens ?? 0), 0);
    expect(total).toBe(147);
  });
  it("drops non-finite numeric fields so they can't corrupt the durable checkpoint (DEF-002)", () => {
    // A non-finite measurement (Infinity/NaN) is meaningless and, if it reached
    // agent_totals.runtime_seconds, JSON.stringify would emit `null` and the next-boot
    // re-decode would discard the whole state file. Drop it like any non-number, while a
    // finite sibling field survives.
    const u = mapUsage({
      totalApiDurationMs: Number.POSITIVE_INFINITY,
      premiumRequests: 7,
    });
    expect(u).toEqual({ premium_requests: 7 });
  });
});

// ───────────────────────── subprocess integration ─────────────────────────

const platform = NodeContext.layer;

const config = (command: string, githubToken?: string): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)({
    tracker: { kind: "github", repo: "o/r", api_key: "t" },
    copilot: { command, ...(githubToken !== undefined ? { github_token: githubToken } : {}) },
  });

/** Scoped override of `process.env` keys, restored (set or deleted) on scope close. */
const withProcessEnv = (vars: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]] as const));
      for (const [k, v] of Object.entries(vars)) process.env[k] = v;
      return prev;
    }),
    (prev) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }),
  );

/** Stand up a fake `copilot` script + a workspace dir, then run the real runner. */
const runFakeCopilot = (
  script: string,
  body: (
    events: ReadonlyArray<{ readonly _tag: string }>,
    exit: { readonly _tag: "Success" | "Failure"; readonly cause?: unknown },
  ) => void,
  githubToken?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-copilot-" });
    const ws = `${root}/work`;
    yield* fs.makeDirectory(ws, { recursive: true });
    const bin = `${root}/fake-copilot`;
    yield* fs.writeFileString(bin, script);
    yield* fs.chmod(bin, 0o755);

    const runner = yield* Effect.provide(AgentRunner, layerCopilotRunner(config(bin, githubToken)));
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
echo '{"type":"assistant.message","data":{"content":"pong","model":"claude-opus-4.8","outputTokens":4}}'
echo '{"type":"result","exitCode":0,"usage":{"premiumRequests":2,"totalApiDurationMs":1748}}'
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
printf '{"type":"result","exitCode":0,"usage":{"premiumRequests":2,"totalApiDurationMs":1748}}'
exit 0
`;

// Distinguishes UNSET from empty: `${VAR-__UNSET__}` writes the sentinel only when the var is
// genuinely absent (the proven-good state for the agent token), not merely blank.
const ENV_SCRUB = `#!/bin/sh
printf "%s" "$ORCHESTRA_COCKPIT_TOKEN" > cockpit-token.txt
printf "%s" "\${GITHUB_TOKEN-__UNSET__}" > github-token.txt
printf "%s" "$HTTPS_PROXY" > proxy.txt
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

  it.scopedLive(
    "injects copilot.github_token as the agent credential — never the tracker token (F1)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Simulate the daemon carrying the operator's tracker credential in its own env: the
        // child must NOT inherit it. Distinct sentinel values prove which one wins.
        yield* withProcessEnv({
          ORCHESTRA_COCKPIT_TOKEN: "daemon-token-must-not-leak", // gitleaks:allow — fake fixture
          HTTPS_PROXY: "http://proxy.internal:8080",
          GITHUB_TOKEN: "tracker-token-must-not-leak", // gitleaks:allow — fake fixture
        });

        const ws = yield* runFakeCopilot(
          ENV_SCRUB,
          (events, exit) => {
            expect(exit._tag).toBe("Success");
            expect(events.map((e) => e._tag)).toContain("TurnCompleted");
          },
          "agent-token-distinct", // gitleaks:allow — fake fixture (copilot.github_token)
        );

        // The child sees the configured agent token, NOT the daemon's tracker token; the
        // daemon-only cockpit secret is blanked and connectivity env passes through.
        expect(yield* fs.readFileString(`${ws}/github-token.txt`)).toBe("agent-token-distinct");
        expect(yield* fs.readFileString(`${ws}/cockpit-token.txt`)).toBe("");
        expect(yield* fs.readFileString(`${ws}/proxy.txt`)).toBe("http://proxy.internal:8080");
      }).pipe(Effect.provide(platform)),
  );

  it.scopedLive(
    "leaves GITHUB_TOKEN UNSET (not blank) when no copilot.github_token is configured (F1)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The daemon's own env carries the tracker token under the canonical GITHUB_TOKEN. With
        // no agent token configured, the child must fall back to the CLI's ambient /login —
        // which requires the var to be genuinely UNSET, not the inherited value and not "".
        yield* withProcessEnv({
          GITHUB_TOKEN: "tracker-token-must-not-leak", // gitleaks:allow — fake fixture
          GH_TOKEN: "tracker-token-must-not-leak", // gitleaks:allow — fake fixture
          COPILOT_GITHUB_TOKEN: "tracker-token-must-not-leak", // gitleaks:allow — fake fixture
        });

        const ws = yield* runFakeCopilot(ENV_SCRUB, (events, exit) => {
          expect(exit._tag).toBe("Success");
          expect(events.map((e) => e._tag)).toContain("TurnCompleted");
        });

        // Sentinel proves true-unset under the executor's {...process.env, ...env} merge — a
        // regression to inherit-from-parent would surface the tracker token here instead.
        expect(yield* fs.readFileString(`${ws}/github-token.txt`)).toBe("__UNSET__");
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
