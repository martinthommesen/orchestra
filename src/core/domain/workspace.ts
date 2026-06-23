import { Schema } from "effect";

/**
 * Filesystem workspace assigned to one issue identifier (SPEC §4.1.4). Construction
 * and the safety invariants that gate it (key sanitization, path-under-root) live in
 * {@link file://../../core/workspace/safety.ts}; this is just the validated shape.
 */
export const Workspace = Schema.Struct({
  /** Absolute workspace path: `<workspace.root>/<workspace_key>`. */
  path: Schema.String,
  /** Sanitized issue identifier (`[A-Za-z0-9._-]`, others → `_`) — SPEC §4.2/§9.5. */
  workspace_key: Schema.String,
  /** True only when this call created the directory — gates the `after_create` hook. */
  created_now: Schema.Boolean,
}).annotations({ identifier: "Workspace" });
export type Workspace = typeof Workspace.Type;
