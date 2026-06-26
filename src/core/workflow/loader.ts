import * as os from "node:os";
import * as nodePath from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { ServiceConfig, type WorkflowDefinition } from "../domain/workflow";
import {
  type LoadWorkflowError,
  MissingWorkflowFile,
  WorkflowFrontMatterNotAMap,
  WorkflowParseError,
} from "../errors";
import { errorMessage } from "../util/error";
import { type PathContext, resolveWorkspaceRoot } from "./paths";
import { resolveOptionalValue } from "./var";

/**
 * `WORKFLOW.md` loader (SPEC §5–§6). Split into a pure {@link parseWorkflow} (string
 * → typed config, no IO) and a thin {@link loadWorkflow} that reads the file via the
 * Effect `FileSystem` service. This keeps the parse/validation/`$VAR`/path-resolution
 * logic fully unit-testable without touching disk.
 */

/** Split a raw `WORKFLOW.md` into YAML front matter (or null) and the trimmed body. */
export const splitFrontMatter = (
  content: string,
): { readonly frontMatter: string | null; readonly body: string } => {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { frontMatter: null, body: content.trim() };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    // Unterminated fence: treat everything after the opening `---` as front matter.
    return { frontMatter: lines.slice(1).join("\n"), body: "" };
  }
  return {
    frontMatter: lines.slice(1, closing).join("\n"),
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
  };
};

/** Apply `$VAR` resolution + path coercion to a decoded config (SPEC §6.1). */
const resolveServiceConfig = (config: ServiceConfig, ctx: PathContext): ServiceConfig => {
  const apiKey = resolveOptionalValue(config.tracker.api_key, ctx.env);
  // Drop api_key when resolution yields "missing" so dispatch preflight surfaces
  // MissingTrackerApiKey rather than seeing a stale/unresolved `$VAR`.
  const { api_key: _omit, ...trackerRest } = config.tracker;
  const tracker = apiKey === undefined ? trackerRest : { ...trackerRest, api_key: apiKey };

  // The agent subprocess credential (F1) is resolved the same way and dropped when missing, so
  // the runner sees a real token or nothing — never a stale `$VAR` it would inject verbatim.
  const ghToken = resolveOptionalValue(config.copilot.github_token, ctx.env);
  const { github_token: _omitGh, ...copilotRest } = config.copilot;
  const copilot = ghToken === undefined ? copilotRest : { ...copilotRest, github_token: ghToken };

  return {
    ...config,
    tracker,
    copilot,
    workspace: {
      ...config.workspace,
      root: resolveWorkspaceRoot(config.workspace.root, ctx),
    },
  };
};

/**
 * Pure parse: raw file content + host context → typed {@link WorkflowDefinition}.
 * Errors map to the SPEC §5.5 load errors. Template parsing is intentionally NOT
 * done here (template errors fail only the affected attempt, see {@link renderPrompt}).
 */
export const parseWorkflow = (
  content: string,
  ctx: PathContext,
): Effect.Effect<WorkflowDefinition, LoadWorkflowError> =>
  Effect.gen(function* () {
    const { frontMatter, body } = splitFrontMatter(content);

    let raw: unknown = {};
    if (frontMatter !== null && frontMatter.trim().length > 0) {
      const parsed = yield* Effect.try({
        try: () => parseYaml(frontMatter) as unknown,
        catch: (e) => new WorkflowParseError({ message: errorMessage(e), cause: e }),
      });
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          return yield* new WorkflowFrontMatterNotAMap({
            message: `front matter must be a map, got ${
              Array.isArray(parsed) ? "array" : typeof parsed
            }`,
          });
        }
        raw = parsed;
      }
    }

    const decoded = yield* Schema.decodeUnknown(ServiceConfig)(raw).pipe(
      Effect.mapError((e) => new WorkflowParseError({ message: errorMessage(e), cause: e })),
    );

    return { config: resolveServiceConfig(decoded, ctx), prompt_template: body };
  });

/** Build the host {@link PathContext} for the running process. */
const hostContext = (path: string): Effect.Effect<PathContext> =>
  Effect.sync(() => ({
    env: process.env,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    workflowDir: nodePath.dirname(nodePath.resolve(path)),
  }));

/** Read `WORKFLOW.md` from disk and parse it (SPEC §5.1). */
export const loadWorkflow = (
  path: string,
): Effect.Effect<WorkflowDefinition, LoadWorkflowError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (e) =>
          new MissingWorkflowFile({
            // Actionable top line: without an explicit message the tagged error renders
            // as the generic "An error has occurred", burying the real ENOENT/path in a
            // nested cause (#21). The path is not a secret.
            message: `could not read workflow file '${path}': ${errorMessage(e)}`,
            path,
            cause: e,
          }),
      ),
    );
    const ctx = yield* hostContext(path);
    return yield* parseWorkflow(content, ctx);
  });
