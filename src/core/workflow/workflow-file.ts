import { randomBytes } from "node:crypto";
import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema } from "effect";
import { parseDocument } from "yaml";
import { PositiveInt, ServiceConfig } from "../domain/workflow";
import { type LoadWorkflowError, SettingsRejected } from "../errors";
import { errorMessage } from "../util/error";
import { loadWorkflow } from "./loader";

/**
 * Sprint 6 / #66 — the `WorkflowFile` service (DD-4): the cockpit's settings read/persist
 * surface. It edits a **whitelisted subset of the RAW `WORKFLOW.md` front matter** and never
 * touches anything else — so `tracker.api_key` (a literal or a `$VAR`) and the Liquid body
 * pass through **byte-for-byte**. The resolved secret (which lives only in the in-memory
 * `ServiceConfig`) is never read for, sent to, or written by this path.
 *
 * Persist discipline mirrors the Sprint-4 checkpoint: validate the merged document, then
 * write a temp file and `rename(2)` it into place (atomic on a single filesystem). An invalid
 * patch — or one that would produce a `WORKFLOW.md` that no longer parses — is rejected
 * BEFORE the write lands.
 */

// ───────────────────────────── Wire / patch schemas ─────────────────────────────

/**
 * The whitelisted editable subset — the only keys the cockpit may read or write (DD-4).
 * Exactly the hot-applicable orchestration knobs; **no secrets**.
 */
export const EditableSettings = Schema.Struct({
  polling: Schema.Struct({ interval_ms: PositiveInt }),
  agent: Schema.Struct({
    max_concurrent_agents: PositiveInt,
    max_concurrent_agents_by_state: Schema.Record({ key: Schema.String, value: PositiveInt }),
    max_turns: PositiveInt,
    max_retry_backoff_ms: PositiveInt,
  }),
  budget: Schema.Struct({ max_total_tokens: Schema.NullOr(PositiveInt) }),
}).annotations({ identifier: "EditableSettings" });
export type EditableSettings = typeof EditableSettings.Type;

/**
 * A typed PUT patch — every key optional, so the operator may change one knob at a time.
 * `budget.max_total_tokens: null` clears the ceiling (deletes the key). The `PositiveInt`
 * bounds make an invalid patch (e.g. negative concurrency) fail decoding at the boundary,
 * BEFORE it can reach disk.
 */
export const SettingsPatch = Schema.Struct({
  polling: Schema.optional(Schema.Struct({ interval_ms: Schema.optional(PositiveInt) })),
  agent: Schema.optional(
    Schema.Struct({
      max_concurrent_agents: Schema.optional(PositiveInt),
      max_concurrent_agents_by_state: Schema.optional(
        Schema.Record({ key: Schema.String, value: PositiveInt }),
      ),
      max_turns: Schema.optional(PositiveInt),
      max_retry_backoff_ms: Schema.optional(PositiveInt),
    }),
  ),
  budget: Schema.optional(
    Schema.Struct({ max_total_tokens: Schema.optional(Schema.NullOr(PositiveInt)) }),
  ),
}).annotations({ identifier: "SettingsPatch" });
export type SettingsPatch = typeof SettingsPatch.Type;

// ───────────────────────────── Service ─────────────────────────────

/** The result of a successful persist: the new editable view + the new resolved config. */
export interface SettingsApplied {
  readonly settings: EditableSettings;
  /** Fully resolved config (incl. `$VAR`/path resolution) for the in-process `ReloadConfig`. */
  readonly config: ServiceConfig;
}

export class WorkflowFile extends Context.Tag("orchestra/WorkflowFile")<
  WorkflowFile,
  {
    /** Read the whitelisted editable subset from the raw front matter (no secrets). */
    readonly read: Effect.Effect<EditableSettings, SettingsRejected | LoadWorkflowError>;
    /** Validate + atomically persist a patch, then return the new view + resolved config. */
    readonly applyPatch: (
      patch: SettingsPatch,
    ) => Effect.Effect<SettingsApplied, SettingsRejected | LoadWorkflowError>;
  }
>() {}

/** Project the whitelisted view from a (decoded) config — defaults already applied. */
const project = (c: ServiceConfig): EditableSettings => ({
  polling: { interval_ms: c.polling.interval_ms },
  agent: {
    max_concurrent_agents: c.agent.max_concurrent_agents,
    max_concurrent_agents_by_state: { ...c.agent.max_concurrent_agents_by_state },
    max_turns: c.agent.max_turns,
    max_retry_backoff_ms: c.agent.max_retry_backoff_ms,
  },
  budget: { max_total_tokens: c.budget.max_total_tokens ?? null },
});

/** Split raw content into the front-matter text and the **verbatim** body (preserving EOL). */
const splitForEdit = (
  content: string,
): Effect.Effect<{ frontMatter: string; body: string; eol: string }, SettingsRejected> => {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return Effect.fail(
      new SettingsRejected({ message: "WORKFLOW.md has no front matter to edit" }),
    );
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return Effect.fail(
      new SettingsRejected({ message: "WORKFLOW.md front matter is unterminated" }),
    );
  }
  return Effect.succeed({
    frontMatter: lines.slice(1, close).join(eol),
    body: lines.slice(close + 1).join(eol),
    eol,
  });
};

/** The whitelisted (path → patched value) edits, with `null` budget meaning "delete the key". */
type Edit = { readonly path: ReadonlyArray<string>; readonly value: unknown };

const collectEdits = (patch: SettingsPatch): { sets: Edit[]; deletes: ReadonlyArray<string>[] } => {
  const sets: Edit[] = [];
  const deletes: ReadonlyArray<string>[] = [];
  if (patch.polling?.interval_ms !== undefined) {
    sets.push({ path: ["polling", "interval_ms"], value: patch.polling.interval_ms });
  }
  if (patch.agent?.max_concurrent_agents !== undefined) {
    sets.push({
      path: ["agent", "max_concurrent_agents"],
      value: patch.agent.max_concurrent_agents,
    });
  }
  if (patch.agent?.max_concurrent_agents_by_state !== undefined) {
    sets.push({
      path: ["agent", "max_concurrent_agents_by_state"],
      value: { ...patch.agent.max_concurrent_agents_by_state },
    });
  }
  if (patch.agent?.max_turns !== undefined) {
    sets.push({ path: ["agent", "max_turns"], value: patch.agent.max_turns });
  }
  if (patch.agent?.max_retry_backoff_ms !== undefined) {
    sets.push({ path: ["agent", "max_retry_backoff_ms"], value: patch.agent.max_retry_backoff_ms });
  }
  if (patch.budget?.max_total_tokens !== undefined) {
    if (patch.budget.max_total_tokens === null) {
      deletes.push(["budget", "max_total_tokens"]);
    } else {
      sets.push({ path: ["budget", "max_total_tokens"], value: patch.budget.max_total_tokens });
    }
  }
  return { sets, deletes };
};

const FILE_MODE = 0o600;

/** Build the {@link WorkflowFile} service bound to a concrete `WORKFLOW.md` path. */
export const WorkflowFileLive = (
  workflowPath: string,
): Layer.Layer<WorkflowFile, never, FileSystem.FileSystem> =>
  Layer.effect(
    WorkflowFile,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      // Serialize the read→edit→write→rename cycle. The cockpit runs each PUT on its own
      // fiber, so two overlapping writes would otherwise interleave (lost update, or an
      // ENOENT on the second rename). A single-permit lock makes each apply atomic against
      // every other apply; a unique temp suffix below is belt-and-suspenders against clobber.
      const writeLock = yield* Effect.makeSemaphore(1);

      /** Decode the whole config from a raw front-matter map (defaults; no $VAR resolution). */
      const decodeRaw = (raw: unknown) =>
        Schema.decodeUnknown(ServiceConfig)(raw).pipe(
          Effect.mapError(
            (e) =>
              new SettingsRejected({
                message: `patched WORKFLOW.md is invalid: ${errorMessage(e)}`,
                cause: e,
              }),
          ),
        );

      const read: Effect.Effect<EditableSettings, SettingsRejected | LoadWorkflowError> =
        Effect.gen(function* () {
          // Read RAW front matter (not the resolved config) so we never read a secret value.
          const content = yield* fs.readFileString(workflowPath).pipe(
            Effect.mapError(
              (e) =>
                new SettingsRejected({
                  message: `could not read WORKFLOW.md: ${errorMessage(e)}`,
                }),
            ),
          );
          const { frontMatter } = yield* splitForEdit(content);
          const doc = parseDocument(frontMatter);
          const config = yield* decodeRaw(doc.toJS() ?? {});
          return project(config);
        });

      const applyPatch = (
        patch: SettingsPatch,
      ): Effect.Effect<SettingsApplied, SettingsRejected | LoadWorkflowError> =>
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            const content = yield* fs.readFileString(workflowPath).pipe(
              Effect.mapError(
                (e) =>
                  new SettingsRejected({
                    message: `could not read WORKFLOW.md: ${errorMessage(e)}`,
                  }),
              ),
            );
            const { frontMatter, body, eol } = yield* splitForEdit(content);

            // Edit the parsed DOCUMENT (not a re-stringified object): untouched nodes —
            // including `tracker.api_key` and any `$VAR` — keep their exact representation.
            const doc = parseDocument(frontMatter);
            const { sets, deletes } = collectEdits(patch);
            for (const edit of sets) {
              doc.setIn([...edit.path], edit.value);
            }
            for (const path of deletes) {
              doc.deleteIn([...path]);
            }

            // Validate-then-write: refuse a patch that would yield an unparseable WORKFLOW.md.
            yield* decodeRaw(doc.toJS() ?? {});

            const newFrontMatter = doc
              .toString()
              .replace(/\r?\n/g, eol)
              .replace(new RegExp(`${eol}$`), "");
            const newContent = `---${eol}${newFrontMatter}${eol}---${eol}${body}`;

            // Preserve the file's existing permission bits (it may hold a literal credential).
            const stat = yield* fs.stat(workflowPath).pipe(Effect.option);
            const mode = stat._tag === "Some" ? stat.value.mode & 0o777 : FILE_MODE;

            // Atomic temp + rename (mirrors the Sprint-4 checkpoint discipline). A unique
            // suffix means an unexpected overlapping writer can never clobber our temp file.
            const tmp = `${workflowPath}.${randomBytes(6).toString("hex")}.orchestra.tmp`;
            yield* fs.writeFileString(tmp, newContent, { mode }).pipe(
              Effect.mapError(
                (e) =>
                  new SettingsRejected({
                    message: `could not write WORKFLOW.md: ${errorMessage(e)}`,
                  }),
              ),
            );
            yield* fs.rename(tmp, workflowPath).pipe(
              Effect.mapError(
                (e) =>
                  new SettingsRejected({
                    message: `could not commit WORKFLOW.md: ${errorMessage(e)}`,
                  }),
              ),
            );

            // Re-load the written file for the fully resolved config the loop hot-applies.
            const def = yield* loadWorkflow(workflowPath).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
            );
            return { settings: project(def.config), config: def.config };
          }),
        );

      return { read, applyPatch };
    }),
  );
