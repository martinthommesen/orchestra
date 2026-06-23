import { Effect, Layer, Ref } from "effect";
import type { Issue } from "../../src/core/domain/issue";
import type { Workspace } from "../../src/core/domain/workspace";
import { type HookName, WorkspaceManager } from "../../src/core/ports/workspace-manager";
import { computeWorkspacePath, sanitizeWorkspaceKey } from "../../src/core/workspace/safety";

/**
 * `FakeWorkspaceManager` (Task 10 — added for the loop's {@link WorkspaceManager}
 * dependency; not separately listed in the plan, noted in progress.md). Fully in-memory:
 * it reuses the real {@link computeWorkspacePath}/{@link sanitizeWorkspaceKey} safety
 * helpers so the §9.5 invariants are exercised, but never touches the filesystem. It
 * records hook invocations and removals so scenario tests can assert lifecycle ordering
 * (`after_create` on first ensure, `before_run`/`after_run` per turn, cleanup on terminal).
 */
interface HookCall {
  readonly hook: HookName;
  readonly key: string;
}

interface WsState {
  readonly created: ReadonlySet<string>;
  readonly hooks: ReadonlyArray<HookCall>;
  readonly removed: ReadonlyArray<string>;
}

export interface FakeWorkspaceControl {
  readonly created: Effect.Effect<ReadonlyArray<string>>;
  readonly hooks: Effect.Effect<ReadonlyArray<HookCall>>;
  readonly removed: Effect.Effect<ReadonlyArray<string>>;
}

export interface FakeWorkspaceManager {
  readonly layer: Layer.Layer<WorkspaceManager>;
  readonly control: FakeWorkspaceControl;
}

export const makeFakeWorkspaceManager = (root: string): Effect.Effect<FakeWorkspaceManager> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<WsState>({ created: new Set(), hooks: [], removed: [] });

    const ensureWorkspace = (issue: Issue) =>
      computeWorkspacePath(root, issue.identifier).pipe(
        Effect.flatMap((ws) =>
          Ref.modify(ref, (st) => {
            const createdNow = !st.created.has(ws.path);
            const created = new Set(st.created);
            created.add(ws.path);
            const hooks: ReadonlyArray<HookCall> = createdNow
              ? [...st.hooks, { hook: "after_create", key: ws.workspace_key }]
              : st.hooks;
            const out: Workspace = { ...ws, created_now: createdNow };
            return [out, { ...st, created, hooks }];
          }),
        ),
      );

    const runHook = (hook: HookName, workspace: Workspace) =>
      Ref.update(ref, (st) => ({
        ...st,
        hooks: [...st.hooks, { hook, key: workspace.workspace_key }],
      }));

    const removeWorkspace = (workspace: Workspace) =>
      Ref.update(ref, (st) => {
        const created = new Set(st.created);
        created.delete(workspace.path);
        return { ...st, created, removed: [...st.removed, workspace.workspace_key] };
      });

    const cleanupTerminalWorkspaces = (identifiers: ReadonlyArray<string>) =>
      Ref.modify(ref, (st) => {
        const keys = identifiers.map(sanitizeWorkspaceKey);
        return [keys as ReadonlyArray<string>, { ...st, removed: [...st.removed, ...keys] }];
      });

    const layer = Layer.succeed(WorkspaceManager, {
      ensureWorkspace,
      runHook,
      removeWorkspace,
      cleanupTerminalWorkspaces,
    });

    const control: FakeWorkspaceControl = {
      created: Ref.get(ref).pipe(Effect.map((s) => [...s.created])),
      hooks: Ref.get(ref).pipe(Effect.map((s) => s.hooks)),
      removed: Ref.get(ref).pipe(Effect.map((s) => s.removed)),
    };

    return { layer, control };
  });
