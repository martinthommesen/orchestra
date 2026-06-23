import { Context, type Effect } from "effect";
import type { Issue } from "../domain/issue";
import type { Workspace } from "../domain/workspace";
import type { WorkspaceError } from "../errors";

/** The four workspace hook points (SPEC §9.4). */
export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

/**
 * Workspace-manager port (SPEC §9). Owns per-issue workspace lifecycle, hook
 * execution, and the §9.5 safety invariants. The Sprint 1 implementation enforces
 * key sanitization and path-under-root (the pure helpers already live in
 * {@link file://../workspace/safety.ts}). Signatures only — no impl in Sprint 0.
 */
export class WorkspaceManager extends Context.Tag("orchestra/WorkspaceManager")<
  WorkspaceManager,
  {
    /**
     * Ensure the per-issue workspace exists (`<root>/<sanitized_key>`), creating it
     * if needed; runs `after_create` when newly created (SPEC §9.2). `created_now`
     * on the result gates that hook.
     */
    readonly ensureWorkspace: (issue: Issue) => Effect.Effect<Workspace, WorkspaceError>;
    /** Run a named hook in the workspace dir with `hooks.timeout_ms` (SPEC §9.4). */
    readonly runHook: (hook: HookName, workspace: Workspace) => Effect.Effect<void, WorkspaceError>;
    /** Remove a workspace (runs `before_remove` first if the dir exists) (SPEC §9.4). */
    readonly removeWorkspace: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>;
    /**
     * Startup cleanup: remove workspaces for issues now in terminal states
     * (SPEC §8.6). Returns the keys removed.
     */
    readonly cleanupTerminalWorkspaces: (
      terminalIssueIdentifiers: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
  }
>() {}
