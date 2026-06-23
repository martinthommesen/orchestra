import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { layerWorkspaceManager } from "../src/adapters/workspace/workspace-manager";
import { ServiceConfig } from "../src/core/domain/workflow";
import { Workspace } from "../src/core/domain/workspace";
import { WorkspaceManager } from "../src/core/ports/workspace-manager";
import { makeIssue } from "./fakes/harness";

const platform = NodeContext.layer;

/** Build a ServiceConfig rooted at `root` with the given hook scripts. */
const config = (root: string, hooks: Record<string, unknown> = {}): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)({
    tracker: { kind: "github", repo: "o/r", api_key: "t" },
    workspace: { root },
    hooks,
  });

/** Provide a scoped temp root + the live WorkspaceManager for a test body. */
const withManager = <A, E>(
  hooks: Record<string, unknown>,
  body: (
    mgr: typeof WorkspaceManager.Service,
    root: string,
    fs: FileSystem.FileSystem,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-ws-" });
    const mgr = yield* Effect.provide(WorkspaceManager, layerWorkspaceManager(config(root, hooks)));
    return yield* body(mgr, root, fs);
  }).pipe(Effect.provide(platform));

describe("WorkspaceManager (filesystem adapter)", () => {
  it.scopedLive("ensureWorkspace creates the dir once (created_now toggles)", () =>
    withManager({}, (mgr, root, fs) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "1", identifier: "ABC-1", state: "Todo" });
        const first = yield* mgr.ensureWorkspace(issue);
        expect(first.workspace_key).toBe("ABC-1");
        expect(first.path).toBe(`${root}/ABC-1`);
        expect(first.created_now).toBe(true);
        expect(yield* fs.exists(first.path)).toBe(true);

        const second = yield* mgr.ensureWorkspace(issue);
        expect(second.created_now).toBe(false);
      }),
    ),
  );

  it.scopedLive("sanitizes disallowed key characters", () =>
    withManager({}, (mgr, root) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "2", identifier: "feature/login bug", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        expect(ws.workspace_key).toBe("feature_login_bug");
        expect(ws.path).toBe(`${root}/feature_login_bug`);
      }),
    ),
  );

  it.scopedLive("rejects an identifier that escapes the root", () =>
    withManager({}, (mgr) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "3", identifier: "..", state: "Todo" });
        const exit = yield* Effect.exit(mgr.ensureWorkspace(issue));
        expect(exit._tag).toBe("Failure");
      }),
    ),
  );

  it.scopedLive("runs after_create only on first creation", () =>
    withManager({ after_create: "echo created > marker.txt" }, (mgr, _root, fs) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "4", identifier: "HOOK-1", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        expect(yield* fs.exists(`${ws.path}/marker.txt`)).toBe(true);

        yield* fs.remove(`${ws.path}/marker.txt`);
        yield* mgr.ensureWorkspace(issue); // already exists → no after_create
        expect(yield* fs.exists(`${ws.path}/marker.txt`)).toBe(false);
      }),
    ),
  );

  it.scopedLive("runHook runs a named script in the workspace dir", () =>
    withManager({ before_run: "echo ran > ran.txt" }, (mgr, _root, fs) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "5", identifier: "HOOK-2", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        yield* mgr.runHook("before_run", ws);
        expect(yield* fs.exists(`${ws.path}/ran.txt`)).toBe(true);
      }),
    ),
  );

  it.scopedLive("runHook is a no-op when the hook is unset", () =>
    withManager({}, (mgr) =>
      Effect.gen(function* () {
        const ws = Workspace.make({ path: "/nonexistent", workspace_key: "x", created_now: false });
        const exit = yield* Effect.exit(mgr.runHook("before_run", ws));
        expect(exit._tag).toBe("Success");
      }),
    ),
  );

  it.scopedLive("a failing hook surfaces WorkspaceHookFailed", () =>
    withManager({ before_run: "exit 3" }, (mgr) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "6", identifier: "HOOK-3", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        const exit = yield* Effect.exit(mgr.runHook("before_run", ws));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(String(exit.cause)).toContain("WorkspaceHookFailed");
        }
      }),
    ),
  );

  it.scopedLive("a hook exceeding the timeout surfaces WorkspaceHookTimeout", () =>
    withManager({ before_run: "sleep 5", timeout_ms: 100 }, (mgr) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "7", identifier: "HOOK-4", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        const exit = yield* Effect.exit(mgr.runHook("before_run", ws));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(String(exit.cause)).toContain("WorkspaceHookTimeout");
        }
      }),
    ),
  );

  it.scopedLive("removeWorkspace runs before_remove then deletes the dir", () =>
    withManager({ before_remove: "echo bye > $PWD/../bye.txt" }, (mgr, root, fs) =>
      Effect.gen(function* () {
        const issue = makeIssue({ id: "8", identifier: "RM-1", state: "Todo" });
        const ws = yield* mgr.ensureWorkspace(issue);
        yield* mgr.removeWorkspace(ws);
        expect(yield* fs.exists(ws.path)).toBe(false);
        expect(yield* fs.exists(`${root}/bye.txt`)).toBe(true);
      }),
    ),
  );

  it.scopedLive("cleanupTerminalWorkspaces removes existing dirs and returns keys", () =>
    withManager({}, (mgr, root, fs) =>
      Effect.gen(function* () {
        const a = yield* mgr.ensureWorkspace(
          makeIssue({ id: "9", identifier: "T-1", state: "Todo" }),
        );
        yield* mgr.ensureWorkspace(makeIssue({ id: "10", identifier: "T-2", state: "Todo" }));
        // "T-3" was never created → must be skipped silently.
        const removed = yield* mgr.cleanupTerminalWorkspaces(["T-1", "T-2", "T-3"]);
        expect([...removed].sort()).toEqual(["T-1", "T-2"]);
        expect(yield* fs.exists(a.path)).toBe(false);
        expect(yield* fs.exists(`${root}/T-3`)).toBe(false);
      }),
    ),
  );
});
