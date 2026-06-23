import * as nodePath from "node:path";
import { Effect } from "effect";
import { Workspace } from "../domain/workspace";
import { PathOutsideWorkspaceRoot } from "../errors";

/**
 * Workspace safety invariants (SPEC §9.5) as pure, unit-tested helpers. The
 * WorkspaceManager (Sprint 1) composes these before touching the filesystem or
 * launching the agent. Encoding them here — not inline in the manager — keeps the
 * "most important portability constraint" testable in isolation.
 */

const DISALLOWED_KEY_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * Invariant 3: sanitize an issue identifier into a workspace key — only
 * `[A-Za-z0-9._-]` survive; every other character becomes `_` (SPEC §4.2/§9.5).
 *
 * NOTE: this can still yield path-traversal-ish keys like `.` or `..` (those chars
 * are individually allowed); {@link computeWorkspacePath} closes that hole via the
 * path-under-root check (Invariant 2).
 */
export const sanitizeWorkspaceKey = (identifier: string): string =>
  identifier.replace(DISALLOWED_KEY_CHARS, "_");

/**
 * Invariant 2 predicate: is `candidate` strictly *inside* `root`? Both are
 * resolved to absolute first. Equal paths (candidate === root) are NOT inside.
 */
export const isPathUnderRoot = (root: string, candidate: string): boolean => {
  const resolvedRoot = nodePath.resolve(root);
  const resolvedCandidate = nodePath.resolve(candidate);
  const rel = nodePath.relative(resolvedRoot, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
};

/**
 * Compose Invariants 2 + 3: sanitize the identifier, place it under `root`, and
 * fail with {@link PathOutsideWorkspaceRoot} if the result escapes the root.
 * Returns a {@link Workspace} (with `created_now: false`; the manager flips it).
 */
export const computeWorkspacePath = (
  root: string,
  identifier: string,
): Effect.Effect<Workspace, PathOutsideWorkspaceRoot> =>
  Effect.gen(function* () {
    const workspace_key = sanitizeWorkspaceKey(identifier);
    const resolvedRoot = nodePath.resolve(root);
    const path = nodePath.resolve(resolvedRoot, workspace_key);
    if (!isPathUnderRoot(resolvedRoot, path)) {
      return yield* new PathOutsideWorkspaceRoot({ path, root: resolvedRoot });
    }
    return Workspace.make({ path, workspace_key, created_now: false });
  });
