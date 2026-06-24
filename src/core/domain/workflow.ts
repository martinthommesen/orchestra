import { Schema } from "effect";

/**
 * Typed view of `WORKFLOW.md` front matter (SPEC §4.1.2/§4.1.3, §5.3, cheat sheet
 * §6.4). The schema bakes in the SPEC's built-in defaults so decoding an empty
 * front-matter map yields a fully-populated config. Unknown keys are stripped
 * (Effect `Struct` default) for the forward-compatibility the SPEC asks for.
 *
 * Orchestra adapts the spec's Linear/Codex flavor to GitHub + Copilot:
 *   - `tracker.kind` default supported value is `github` (not `linear`); the spec's
 *     `project_slug` becomes `repo` (`owner/name`); canonical api-key env is
 *     `GITHUB_TOKEN`; endpoint defaults to the GitHub API base.
 *   - the spec's `codex` block becomes {@link CopilotConfig} (`copilot`), since the
 *     coding agent is GitHub Copilot. Codex-only sandbox/approval fields are dropped.
 * These deviations are intentional and recorded in docs/sprint-0/progress.md.
 *
 * Presence checks the spec defers to dispatch preflight (§6.3) — `tracker.kind`
 * supported, `repo`/`api_key` present — are NOT enforced here (decoding stays
 * lenient per §5.5); they surface later as the relevant tagged errors.
 */

const PositiveInt = Schema.Int.pipe(Schema.positive());

/** `tracker` block (SPEC §5.3.1), GitHub-flavored. */
export const TrackerConfig = Schema.Struct({
  /** REQUIRED for dispatch. v1 supports `github` (validated at preflight). */
  kind: Schema.optional(Schema.String),
  /** GitHub `owner/name`. REQUIRED for dispatch when `kind == "github"` (spec `project_slug`). */
  repo: Schema.optional(Schema.String),
  endpoint: Schema.optionalWith(Schema.String, {
    default: () => "https://api.github.com",
  }),
  /** Literal token or `$VAR` (canonical env `GITHUB_TOKEN`); resolved by the loader. */
  api_key: Schema.optional(Schema.String),
  /** An issue must carry every configured label to dispatch (case/space-insensitive). */
  required_labels: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  active_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["Todo", "In Progress"],
  }),
  terminal_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  }),
}).annotations({ identifier: "TrackerConfig" });
export type TrackerConfig = typeof TrackerConfig.Type;

/** `polling` block (SPEC §5.3.2). */
export const PollingConfig = Schema.Struct({
  interval_ms: Schema.optionalWith(PositiveInt, { default: () => 30_000 }),
}).annotations({ identifier: "PollingConfig" });
export type PollingConfig = typeof PollingConfig.Type;

/**
 * `workspace` block (SPEC §5.3.3). `root` stays optional/raw here; the loader
 * applies the `<system-temp>/orchestra_workspaces` default and resolves `$VAR`,
 * `~`, and relative paths (relative to the WORKFLOW.md directory) to an absolute
 * path per §6.1.
 */
export const WorkspaceConfig = Schema.Struct({
  root: Schema.optional(Schema.String),
}).annotations({ identifier: "WorkspaceConfig" });
export type WorkspaceConfig = typeof WorkspaceConfig.Type;

/** `hooks` block (SPEC §5.3.4). Each hook is an optional shell script. */
export const HooksConfig = Schema.Struct({
  after_create: Schema.optional(Schema.String),
  before_run: Schema.optional(Schema.String),
  after_run: Schema.optional(Schema.String),
  before_remove: Schema.optional(Schema.String),
  timeout_ms: Schema.optionalWith(PositiveInt, { default: () => 60_000 }),
}).annotations({ identifier: "HooksConfig" });
export type HooksConfig = typeof HooksConfig.Type;

/** `agent` block (SPEC §5.3.5) — orchestration knobs (concurrency, turns, backoff). */
export const AgentConfig = Schema.Struct({
  max_concurrent_agents: Schema.optionalWith(PositiveInt, { default: () => 10 }),
  max_turns: Schema.optionalWith(PositiveInt, { default: () => 20 }),
  max_retry_backoff_ms: Schema.optionalWith(PositiveInt, {
    default: () => 300_000,
  }),
  /** `state -> positive int` cap; state keys are compared lowercased. */
  max_concurrent_agents_by_state: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: PositiveInt }),
    { default: () => ({}) },
  ),
}).annotations({ identifier: "AgentConfig" });
export type AgentConfig = typeof AgentConfig.Type;

/**
 * `copilot` block — Orchestra's rename of the spec's `codex` block (§5.3.6), since
 * the coding agent is GitHub Copilot. `command` is the base executable; the runner
 * (Sprint 1) appends the headless flags pinned by the Sprint 0 spike.
 */
export const CopilotConfig = Schema.Struct({
  command: Schema.optionalWith(Schema.String, { default: () => "copilot" }),
  /** Optional model override (e.g. `claude-opus-4.8`); default chosen by Copilot. */
  model: Schema.optional(Schema.String),
  /** Total turn-stream timeout. */
  turn_timeout_ms: Schema.optionalWith(PositiveInt, {
    default: () => 3_600_000,
  }),
  /** Request/response timeout during startup and sync requests. */
  read_timeout_ms: Schema.optionalWith(PositiveInt, { default: () => 5_000 }),
  /** Event-inactivity stall timeout; `<= 0` disables stall detection. */
  stall_timeout_ms: Schema.optionalWith(Schema.Int, { default: () => 300_000 }),
}).annotations({ identifier: "CopilotConfig" });
export type CopilotConfig = typeof CopilotConfig.Type;

/**
 * `persistence` block (Sprint 4 / #40) — durable orchestrator state. Additive and
 * all-defaults so an unchanged `WORKFLOW.md` still decodes. `dir` is left optional/raw
 * (no default baked in): the persistence layer falls back to `<workspace.root>/.orchestra`
 * when it is absent, and resolves a relative `dir` against the resolved workspace root.
 */
export const PersistenceConfig = Schema.Struct({
  /** State directory. Default `<workspace.root>/.orchestra` (resolved by the layer). */
  dir: Schema.optional(Schema.String),
  /** Debounce window (ms) coalescing bursts of mutations into one atomic write. */
  debounce_ms: Schema.optionalWith(PositiveInt, { default: () => 500 }),
}).annotations({ identifier: "PersistenceConfig" });
export type PersistenceConfig = typeof PersistenceConfig.Type;

/**
 * The fully-typed, defaulted service configuration (SPEC §4.1.3). Each block is
 * optional at the top level and falls back to its own all-defaults form, so a
 * `WORKFLOW.md` with no front matter still decodes to a complete config.
 */
export const ServiceConfig = Schema.Struct({
  tracker: Schema.optionalWith(TrackerConfig, {
    default: () => TrackerConfig.make({}),
  }),
  polling: Schema.optionalWith(PollingConfig, {
    default: () => PollingConfig.make({}),
  }),
  workspace: Schema.optionalWith(WorkspaceConfig, {
    default: () => WorkspaceConfig.make({}),
  }),
  hooks: Schema.optionalWith(HooksConfig, {
    default: () => HooksConfig.make({}),
  }),
  agent: Schema.optionalWith(AgentConfig, {
    default: () => AgentConfig.make({}),
  }),
  copilot: Schema.optionalWith(CopilotConfig, {
    default: () => CopilotConfig.make({}),
  }),
  persistence: Schema.optionalWith(PersistenceConfig, {
    default: () => PersistenceConfig.make({}),
  }),
}).annotations({ identifier: "ServiceConfig" });
export type ServiceConfig = typeof ServiceConfig.Type;
export type ServiceConfigEncoded = typeof ServiceConfig.Encoded;

/**
 * Parsed `WORKFLOW.md` payload (SPEC §4.1.2): the typed {@link ServiceConfig} plus
 * the trimmed Markdown prompt body. (Orchestra stores the *typed* config here for
 * ergonomics rather than the spec's raw map.)
 */
export const WorkflowDefinition = Schema.Struct({
  config: ServiceConfig,
  prompt_template: Schema.String,
}).annotations({ identifier: "WorkflowDefinition" });
export type WorkflowDefinition = typeof WorkflowDefinition.Type;
