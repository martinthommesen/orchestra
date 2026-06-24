import { randomBytes } from "node:crypto";
import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema } from "effect";
import { CST, isMap, isScalar, parseDocument } from "yaml";
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
 * **Surgical-edit guarantee (#73).** The dominant case — changing a scalar value on a key that
 * already exists (`interval_ms`, `max_concurrent_agents`, `max_turns`, `max_retry_backoff_ms`,
 * `budget.max_total_tokens`) — is **fully byte-verbatim**: only the bytes of the edited value
 * move. We rewrite just that scalar's CST source token (`CST.setScalarValue`) and re-emit the
 * concrete syntax tree (`CST.stringify`), so trailing-comment alignment, flow-vs-block style,
 * key order, blank lines, and every untouched line are preserved exactly. The rarer
 * **structural** edits — clearing a ceiling (delete a key), setting the
 * `max_concurrent_agents_by_state` map, or introducing a whitelisted key that is **absent**
 * from the raw file — fall back to a Document re-serialize with `flowCollectionPadding:false`
 * (so flow arrays don't gain `[ x ]` padding). That path is **best-effort**: comment alignment
 * on untouched lines may normalize, and a now-empty parent map (e.g. a cleared `budget:`) is
 * pruned rather than left dangling.
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
    /**
     * Validate + stage a patch, run `gate` with the fully-resolved new config, and only
     * **commit** the atomic write once the gate succeeds — so the persist is all-or-nothing
     * with whatever the gate gates on (the cockpit gates on the owner fiber accepting the
     * `ReloadConfig`, so a timed-out reload → 503 leaves the file AND the live config
     * unchanged). On gate failure/interrupt nothing is persisted and the staged temp is removed.
     */
    readonly applyPatch: <E, R>(
      patch: SettingsPatch,
      gate: (config: ServiceConfig) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<SettingsApplied, SettingsRejected | LoadWorkflowError | E, R>;
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

/** A scalar JS value — the only kind we can rewrite in place via a CST source token. */
const isScalarValue = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

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

      const applyPatch = <E, R>(
        patch: SettingsPatch,
        gate: (config: ServiceConfig) => Effect.Effect<void, E, R>,
      ): Effect.Effect<SettingsApplied, SettingsRejected | LoadWorkflowError | E, R> =>
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
            // `keepSourceTokens` links each node to its CST token so we can rewrite a single
            // scalar's bytes without re-serializing its neighbours.
            const doc = parseDocument(frontMatter, { keepSourceTokens: true });
            const { sets, deletes } = collectEdits(patch);

            // Prefer the byte-verbatim path: it applies iff every edit is a scalar value
            // landing on a key that already exists as a scalar, and nothing structural
            // (a delete) is involved. Otherwise we fall back to the Document re-serialize.
            const scalarEdits: Array<{ token: CST.Token; value: string }> = [];
            let byteVerbatim = deletes.length === 0;
            if (byteVerbatim) {
              for (const edit of sets) {
                const node = doc.getIn([...edit.path], true);
                if (isScalar(node) && node.srcToken !== undefined && isScalarValue(edit.value)) {
                  scalarEdits.push({ token: node.srcToken, value: String(edit.value) });
                } else {
                  byteVerbatim = false;
                  break;
                }
              }
            }

            let newFrontMatter: string;
            if (byteVerbatim && doc.contents?.srcToken !== undefined) {
              // Rewrite ONLY the edited scalar tokens; every other byte is source-identical.
              for (const { token, value } of scalarEdits) CST.setScalarValue(token, value);
              newFrontMatter = CST.stringify(doc.contents.srcToken);
            } else {
              // Structural edits (delete / map / absent key) — best-effort: re-serialize via
              // the Document model with flow padding off so `[orchestra]` arrays don't gain
              // `[ orchestra ]` padding. Untouched comment alignment may normalize here.
              for (const edit of sets) doc.setIn([...edit.path], edit.value);
              for (const path of deletes) {
                doc.deleteIn([...path]);
                // Drop a now-empty parent map so a cleared ceiling leaves no dangling
                // `budget: {}`, not the whole block re-indented.
                if (path.length > 1) {
                  const parentPath = path.slice(0, -1);
                  const parent = doc.getIn([...parentPath], true);
                  if (isMap(parent) && parent.items.length === 0) doc.deleteIn([...parentPath]);
                }
              }
              newFrontMatter = doc.toString({ flowCollectionPadding: false });
            }

            newFrontMatter = newFrontMatter
              .replace(/\r?\n/g, eol)
              .replace(new RegExp(`${eol}$`), "");

            // Validate-then-write: refuse a patch that would yield an unparseable or
            // schema-invalid WORKFLOW.md. We parse the ACTUAL output bytes (not the in-memory
            // model) so a CST-level or structural slip is caught before the write lands.
            const reparsed = parseDocument(newFrontMatter);
            if (reparsed.errors.length > 0) {
              return yield* Effect.fail(
                new SettingsRejected({
                  message: `patched WORKFLOW.md is invalid: ${reparsed.errors[0]?.message}`,
                }),
              );
            }
            yield* decodeRaw(reparsed.toJS() ?? {});

            const newContent = `---${eol}${newFrontMatter}${eol}---${eol}${body}`;

            // Preserve the file's existing permission bits (it may hold a literal credential).
            const stat = yield* fs.stat(workflowPath).pipe(Effect.option);
            const mode = stat._tag === "Some" ? stat.value.mode & 0o777 : FILE_MODE;

            // Atomic temp + rename (mirrors the Sprint-4 checkpoint discipline). A unique
            // suffix means an unexpected overlapping writer can never clobber our temp file.
            // The temp sits in the SAME directory as `workflowPath`, so its `dirname` — and
            // thus every relative path the loader resolves — is identical to the live file.
            const tmp = `${workflowPath}.${randomBytes(6).toString("hex")}.orchestra.tmp`;
            yield* fs.writeFileString(tmp, newContent, { mode }).pipe(
              Effect.mapError(
                (e) =>
                  new SettingsRejected({
                    message: `could not write WORKFLOW.md: ${errorMessage(e)}`,
                  }),
              ),
            );

            // Stage → gate → commit. Resolve the STAGED file (incl. `$VAR`/path resolution)
            // for the config the gate hot-applies; run the gate (the cockpit sends the owner
            // a `ReloadConfig` and awaits its ack); only `rename(2)` the temp into place once
            // the gate succeeds. On ANY failure/interrupt before the commit we remove the
            // staged temp, so a 503 (or a resolution error) persists nothing and applies
            // nothing — a clean all-or-nothing failure.
            return yield* Effect.gen(function* () {
              const def = yield* loadWorkflow(tmp).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              );
              yield* gate(def.config);
              yield* fs.rename(tmp, workflowPath).pipe(
                Effect.mapError(
                  (e) =>
                    new SettingsRejected({
                      message: `could not commit WORKFLOW.md: ${errorMessage(e)}`,
                    }),
                ),
              );
              return { settings: project(def.config), config: def.config };
            }).pipe(Effect.onError(() => fs.remove(tmp).pipe(Effect.ignore)));
          }),
        );

      return { read, applyPatch };
    }),
  );
