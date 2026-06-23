import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Duration, Effect, Layer } from "effect";
import type { Issue } from "../../core/domain/issue";
import type { ServiceConfig } from "../../core/domain/workflow";
import { Workspace } from "../../core/domain/workspace";
import {
  WorkspaceCreationFailed,
  type WorkspaceError,
  WorkspaceHookFailed,
  WorkspaceHookTimeout,
} from "../../core/errors";
import { type HookName, WorkspaceManager } from "../../core/ports/workspace-manager";
import { computeWorkspacePath } from "../../core/workspace/safety";

/**
 * Filesystem WorkspaceManager (Task 8, SPEC §9). Owns the per-issue workspace
 * lifecycle and hook execution on top of `@effect/platform` FileSystem + Command, so
 * the core stays Promise-free and platform errors are mapped to the §9.5 tagged
 * channels.
 *
 * ## Safety invariants (SPEC §9.5)
 * - **Invariant 2/3** — every path is derived via {@link computeWorkspacePath}, which
 *   sanitizes the identifier to `[A-Za-z0-9._-]` and rejects any result that escapes
 *   `workspace.root` ({@link WorkspaceError} `PathOutsideWorkspaceRoot`). Nothing here
 *   constructs a path by string concatenation.
 * - **Invariant 1** (cwd == workspace dir) is enforced by the agent runner; this
 *   manager only ever creates/removes directories *inside* the root.
 *
 * ## Hooks (SPEC §9.4)
 * Each hook is run as `sh -lc <script>` with the working directory pinned to the
 * workspace and a `hooks.timeout_ms` deadline (timeout ⇒ {@link WorkspaceHookTimeout},
 * the interrupted process is SIGTERM'd by the Command scope). The child inherits the
 * orchestrator env so hooks see `$GITHUB_TOKEN` etc.; we never echo that env ourselves.
 * `after_create` runs only on first creation (gated by `created_now`) and is fatal for
 * the issue; `before_remove` is best-effort so teardown still removes the directory.
 */
export const makeWorkspaceManager = (
  config: ServiceConfig,
): Effect.Effect<
  typeof WorkspaceManager.Service,
  never,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const executor = yield* CommandExecutor.CommandExecutor;
    const root = config.workspace.root;
    const timeoutMs = config.hooks.timeout_ms;

    /** Map a platform FS fault on `path` to the typed workspace-dir error. */
    const mapFs = (path: string) =>
      Effect.mapError((cause: PlatformError) => new WorkspaceCreationFailed({ path, cause }));

    /** Run one hook script in `cwd` with the configured timeout. */
    const runHookScript = (
      hook: HookName,
      script: string,
      cwd: string,
    ): Effect.Effect<void, WorkspaceError> =>
      Command.make("sh", "-lc", script).pipe(
        Command.workingDirectory(cwd),
        Command.stdout("inherit"),
        Command.stderr("inherit"),
        Command.exitCode,
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.mapError(
          (cause: PlatformError) =>
            new WorkspaceHookFailed({ hook, message: `hook '${hook}' could not run`, cause }),
        ),
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new WorkspaceHookTimeout({ hook, timeout_ms: timeoutMs }),
        }),
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(
                new WorkspaceHookFailed({
                  hook,
                  message: `hook '${hook}' exited with code ${code}`,
                }),
              ),
        ),
      );

    const scriptFor = (hook: HookName): string | undefined => config.hooks[hook];

    const runHook = (hook: HookName, workspace: Workspace): Effect.Effect<void, WorkspaceError> => {
      const script = scriptFor(hook);
      return script === undefined ? Effect.void : runHookScript(hook, script, workspace.path);
    };

    const ensureWorkspace = (issue: Issue): Effect.Effect<Workspace, WorkspaceError> =>
      Effect.gen(function* () {
        if (root === undefined) {
          return yield* new WorkspaceCreationFailed({
            path: issue.identifier,
            cause: "workspace.root is unresolved",
          });
        }
        const base = yield* computeWorkspacePath(root, issue.identifier);
        const existed = yield* fs.exists(base.path).pipe(mapFs(base.path));
        if (!existed) {
          yield* fs.makeDirectory(base.path, { recursive: true }).pipe(mapFs(base.path));
        }
        const ws = Workspace.make({
          path: base.path,
          workspace_key: base.workspace_key,
          created_now: !existed,
        });
        if (ws.created_now) {
          yield* runHook("after_create", ws);
        }
        return ws;
      });

    const removeWorkspace = (workspace: Workspace): Effect.Effect<void, WorkspaceError> =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(workspace.path).pipe(mapFs(workspace.path));
        if (!exists) {
          return;
        }
        // before_remove is best-effort: a failing teardown hook must not strand the dir.
        yield* runHook("before_remove", workspace).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning(
              `before_remove hook failed for ${workspace.workspace_key}: ${e._tag}`,
            ),
          ),
        );
        yield* fs.remove(workspace.path, { recursive: true }).pipe(mapFs(workspace.path));
      });

    const cleanupTerminalWorkspaces = (
      terminalIssueIdentifiers: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
      Effect.gen(function* () {
        if (root === undefined) {
          return [];
        }
        const removed: string[] = [];
        for (const identifier of terminalIssueIdentifiers) {
          const base = yield* computeWorkspacePath(root, identifier);
          const exists = yield* fs.exists(base.path).pipe(mapFs(base.path));
          if (exists) {
            yield* fs.remove(base.path, { recursive: true }).pipe(mapFs(base.path));
            removed.push(base.workspace_key);
          }
        }
        return removed;
      });

    return { ensureWorkspace, runHook, removeWorkspace, cleanupTerminalWorkspaces };
  });

/** Layer providing the filesystem {@link WorkspaceManager} for a resolved config. */
export const layerWorkspaceManager = (
  config: ServiceConfig,
): Layer.Layer<WorkspaceManager, never, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Layer.effect(WorkspaceManager, makeWorkspaceManager(config));
