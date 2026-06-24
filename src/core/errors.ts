import { Data } from "effect";

/**
 * One Effect tagged error per SPEC error class. Every error is `_tag`-discriminable
 * (via `Data.TaggedError`) so call sites can `Effect.catchTag`/match exhaustively.
 *
 * Naming: PascalCase `_tag`s; the SPEC's snake_case category is preserved in each
 * doc comment for traceability. Orchestra generalizes the spec's vendor-specific
 * names — `linear_*` → `Tracker*`, `codex_*` → `Agent*` — because the tracker is
 * GitHub and the agent is Copilot. The mapping is exhaustive and recorded here.
 *
 * Security: error payloads MUST NOT carry secrets (tokens, resolved `$VAR`s).
 */

// ───────────────────────────── Workflow (SPEC §5.5) ─────────────────────────────

/** `missing_workflow_file` — the workflow file could not be read. */
export class MissingWorkflowFile extends Data.TaggedError("MissingWorkflowFile")<{
  /** Actionable top-line message (path + real cause, no secrets) for the log stream. */
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}> {}

/** `workflow_parse_error` — YAML front matter failed to parse. */
export class WorkflowParseError extends Data.TaggedError("WorkflowParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `workflow_front_matter_not_a_map` — front matter decoded to a non-map YAML value. */
export class WorkflowFrontMatterNotAMap extends Data.TaggedError("WorkflowFrontMatterNotAMap")<{
  readonly message: string;
}> {}

/**
 * `settings_rejected` — a cockpit `PUT /api/v1/settings` patch was rejected (Sprint 6 / #66,
 * DD-4). Either the patch failed validation, or applying it would produce a `WORKFLOW.md`
 * that no longer parses — in both cases the write is refused BEFORE it lands on disk. The
 * message is actionable and secret-free (it never echoes resolved credentials).
 */
export class SettingsRejected extends Data.TaggedError("SettingsRejected")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `template_parse_error` — prompt template has invalid Liquid syntax. */
export class TemplateParseError extends Data.TaggedError("TemplateParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `template_render_error` — unknown variable/filter or invalid interpolation at render. */
export class TemplateRenderError extends Data.TaggedError("TemplateRenderError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ───────────────────────────── Agent (SPEC §10.6) ──────────────────────────────
// Generalized from the spec's `codex_*` categories to `Agent*` (Orchestra → Copilot).

/** `codex_not_found` — the configured agent command is not on PATH / not executable. */
export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
  readonly command: string;
  readonly cause?: unknown;
}> {}

/** `invalid_workspace_cwd` — Safety Invariant 1 violated: cwd != workspace path (§9.5). */
export class InvalidWorkspaceCwd extends Data.TaggedError("InvalidWorkspaceCwd")<{
  readonly expected: string;
  readonly actual: string;
}> {}

/** `response_timeout` — a startup/sync request exceeded `copilot.read_timeout_ms`. */
export class ResponseTimeout extends Data.TaggedError("ResponseTimeout")<{
  readonly timeout_ms: number;
}> {}

/** `turn_timeout` — the turn stream exceeded `copilot.turn_timeout_ms`. */
export class TurnTimeout extends Data.TaggedError("TurnTimeout")<{
  readonly timeout_ms: number;
}> {}

/** `port_exit` — the agent subprocess exited unexpectedly. */
export class AgentProcessExit extends Data.TaggedError("AgentProcessExit")<{
  readonly code: number | null;
  readonly signal: string | null;
}> {}

/** `response_error` — the agent returned an error response to a request. */
export class ResponseError extends Data.TaggedError("ResponseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `turn_failed` — the agent reported the turn failed. */
export class TurnFailed extends Data.TaggedError("TurnFailed")<{
  readonly message: string;
}> {}

/** `turn_cancelled` — the turn was cancelled (e.g. by reconciliation). */
export class TurnCancelled extends Data.TaggedError("TurnCancelled")<{
  readonly reason?: string;
}> {}

/** `turn_input_required` — the agent blocked awaiting user input (hard-fail per policy). */
export class TurnInputRequired extends Data.TaggedError("TurnInputRequired")<{
  readonly prompt?: string;
}> {}

// ──────────────────────────── Tracker (SPEC §11.4) ─────────────────────────────
// Generalized from the spec's `linear_*` categories to `Tracker*` (Orchestra → GitHub).

/** `unsupported_tracker_kind` — `tracker.kind` is missing or not supported. */
export class UnsupportedTrackerKind extends Data.TaggedError("UnsupportedTrackerKind")<{
  readonly kind: string | null;
}> {}

/** `missing_tracker_api_key` — no api key after `$VAR` resolution. */
export class MissingTrackerApiKey extends Data.TaggedError("MissingTrackerApiKey")<{
  readonly env_var?: string;
}> {}

/** `missing_tracker_project_slug` — required `tracker.repo` (spec `project_slug`) absent. */
export class MissingTrackerRepo extends Data.TaggedError("MissingTrackerRepo")<{
  readonly message: string;
}> {}

/** `linear_api_request` — transport-level failure calling the tracker API. */
export class TrackerApiRequest extends Data.TaggedError("TrackerApiRequest")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `linear_api_status` — tracker API returned a non-success HTTP status. */
export class TrackerApiStatus extends Data.TaggedError("TrackerApiStatus")<{
  readonly status: number;
  readonly message?: string;
}> {}

/** `linear_graphql_errors` — the GraphQL response carried top-level `errors`. */
export class TrackerGraphqlErrors extends Data.TaggedError("TrackerGraphqlErrors")<{
  readonly errors: ReadonlyArray<unknown>;
}> {}

/** `linear_unknown_payload` — the tracker response did not match the expected shape. */
export class TrackerUnknownPayload extends Data.TaggedError("TrackerUnknownPayload")<{
  readonly message: string;
}> {}

/** `linear_missing_end_cursor` — pagination integrity error (no end cursor). */
export class TrackerMissingEndCursor extends Data.TaggedError("TrackerMissingEndCursor")<{
  readonly message: string;
}> {}

// ─────────────────────── Workspace safety (SPEC §9.4 / §9.5) ────────────────────
// Not numbered SPEC error classes, but the §9.5 safety invariants and §9.4 hook
// failures need typed channels. Invariant 1 (cwd) is `InvalidWorkspaceCwd` above.

/** Safety Invariant 2 (§9.5): a workspace path escaped the workspace root. */
export class PathOutsideWorkspaceRoot extends Data.TaggedError("PathOutsideWorkspaceRoot")<{
  readonly path: string;
  readonly root: string;
}> {}

/** Workspace directory could not be created/prepared (§9.2/§9.3). */
export class WorkspaceCreationFailed extends Data.TaggedError("WorkspaceCreationFailed")<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

/** A workspace hook exited non-zero (§9.4). Fatality depends on which hook. */
export class WorkspaceHookFailed extends Data.TaggedError("WorkspaceHookFailed")<{
  readonly hook: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A workspace hook exceeded `hooks.timeout_ms` (§9.4). */
export class WorkspaceHookTimeout extends Data.TaggedError("WorkspaceHookTimeout")<{
  readonly hook: string;
  readonly timeout_ms: number;
}> {}

// ───────────────────────────── Error unions ────────────────────────────────────

/** Errors from loading/parsing `WORKFLOW.md` — block new dispatches until fixed (§5.5). */
export type LoadWorkflowError =
  | MissingWorkflowFile
  | WorkflowParseError
  | WorkflowFrontMatterNotAMap;

/** Errors from rendering the prompt template — fail only the affected attempt (§5.5). */
export type TemplateError = TemplateParseError | TemplateRenderError;

/** The full SPEC §5.5 workflow error surface. */
export type WorkflowError = LoadWorkflowError | TemplateError;

/** Normalized agent-runner errors (SPEC §10.6). */
export type AgentError =
  | AgentNotFound
  | InvalidWorkspaceCwd
  | ResponseTimeout
  | TurnTimeout
  | AgentProcessExit
  | ResponseError
  | TurnFailed
  | TurnCancelled
  | TurnInputRequired;

/** Normalized issue-tracker errors (SPEC §11.4). */
export type TrackerError =
  | UnsupportedTrackerKind
  | MissingTrackerApiKey
  | MissingTrackerRepo
  | TrackerApiRequest
  | TrackerApiStatus
  | TrackerGraphqlErrors
  | TrackerUnknownPayload
  | TrackerMissingEndCursor;

/** Workspace lifecycle + safety-invariant errors (SPEC §9.2/§9.4/§9.5). */
export type WorkspaceError =
  | InvalidWorkspaceCwd
  | PathOutsideWorkspaceRoot
  | WorkspaceCreationFailed
  | WorkspaceHookFailed
  | WorkspaceHookTimeout;

/** Every Orchestra domain error. */
export type OrchestraError = WorkflowError | AgentError | TrackerError | WorkspaceError;
