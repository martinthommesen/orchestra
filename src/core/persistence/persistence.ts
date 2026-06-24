import * as nodePath from "node:path";
import { FileSystem } from "@effect/platform";
import { Clock, Context, Duration, Effect, Layer, Option, Queue, type Scope } from "effect";
import type { ServiceConfig } from "../domain/workflow";
import { errorMessage } from "../util/error";
import { decodePersisted, encodePersisted, type PersistedState } from "./persisted-state";

/**
 * Sprint 4 / #40 — the durable persistence boundary (durability spike §2.3, §2.7).
 *
 * `Persistence` owns the on-disk checkpoint and the debounced write machinery:
 *   - {@link Persistence.load} — read + validate the checkpoint; missing → `none`,
 *     corrupt → rename-aside + `none` (never throws, never crashes the daemon, §2.4).
 *   - {@link Persistence.save} — one **atomic** write (temp file + `rename`, same dir →
 *     same filesystem); total (IO faults are logged, not raised, so a final flush on
 *     shutdown can never fail teardown).
 *   - {@link Persistence.markDirty} — coalescing dirty signal from the store mutator
 *     chokepoint (§2.4).
 *   - {@link Persistence.runWriter} — the single scoped, debounced writer fiber + a
 *     guaranteed final flush on scope teardown (§2.3).
 *
 * Backed by `@effect/platform` `FileSystem` (ambient via `NodeContext.layer`), so the
 * whole path stays inside Effect and is `TestClock`-controllable (the debounce uses
 * `Effect.sleep`).
 */

/** Checkpoint filename within the state dir; its temp sibling shares the directory. */
export const STATE_FILE = "state.json";
const TMP_FILE = `${STATE_FILE}.tmp`;

/** Resolved persistence paths/knobs derived from the service config. */
export interface PersistencePaths {
  /** Absolute state directory. */
  readonly dir: string;
  /** Absolute checkpoint path (`<dir>/state.json`). */
  readonly file: string;
  /** Absolute temp sibling (`<dir>/state.json.tmp`) — same dir guarantees same-fs rename. */
  readonly tmp: string;
  /** Debounce window (ms) coalescing bursts into one write. */
  readonly debounceMs: number;
}

/**
 * Resolve the effective persistence paths. Default dir is `<workspace.root>/.orchestra`;
 * an explicit `persistence.dir` is used as-is when absolute, else resolved against the
 * (already absolute) workspace root.
 */
export const resolvePersistencePaths = (config: ServiceConfig): PersistencePaths => {
  // `workspace.root` is resolved to an absolute path by the loader; the schema type stays
  // optional, so fall back to cwd defensively (never hit in a loaded config).
  const root = config.workspace.root ?? process.cwd();
  const raw = config.persistence.dir;
  let dir: string;
  if (raw === undefined || raw === "") {
    dir = nodePath.join(root, ".orchestra");
  } else if (nodePath.isAbsolute(raw)) {
    dir = nodePath.normalize(raw);
  } else {
    dir = nodePath.resolve(root, raw);
  }
  return {
    dir,
    file: nodePath.join(dir, STATE_FILE),
    tmp: nodePath.join(dir, TMP_FILE),
    debounceMs: config.persistence.debounce_ms,
  };
};

/** The persistence service (durability spike §2.7). */
export class Persistence extends Context.Tag("orchestra/Persistence")<
  Persistence,
  {
    /** Load + validate the checkpoint. Missing/corrupt → `none` (clean start). */
    readonly load: Effect.Effect<Option.Option<PersistedState>>;
    /** Atomic temp-file + rename write. Total: IO faults are logged, not raised. */
    readonly save: (value: PersistedState) => Effect.Effect<void>;
    /** Signal that state changed (coalesced — bursts collapse to one write). */
    readonly markDirty: Effect.Effect<void>;
    /**
     * Fork the single debounced writer fiber into the caller's scope and register the
     * guaranteed final-flush finalizer. `source` yields the latest value to persist.
     */
    readonly runWriter: (
      source: Effect.Effect<PersistedState>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>() {}

/** Build the {@link Persistence} service for a resolved config. */
export const makePersistence = (
  config: ServiceConfig,
): Effect.Effect<typeof Persistence.Service, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = resolvePersistencePaths(config);
    // Sliding(1): a coalescing dirty flag — many mutations within a window collapse into
    // at most one pending signal, so the writer does at most one write per debounce.
    const dirty = yield* Queue.sliding<void>(1);
    // Serialize writes so the debounced loop and the shutdown flush can never race on the
    // shared temp file.
    const writeLock = yield* Effect.makeSemaphore(1);

    const annotate = (event: string, fields: Record<string, string>) =>
      Effect.annotateLogs({ event, state_file: paths.file, ...fields });

    const load: Effect.Effect<Option.Option<PersistedState>> = Effect.gen(function* () {
      const present = yield* fs.exists(paths.file).pipe(Effect.orElseSucceed(() => false));
      if (!present) {
        return Option.none<PersistedState>();
      }
      const read = yield* Effect.either(fs.readFileString(paths.file));
      if (read._tag === "Left") {
        yield* Effect.logWarning("persistence: checkpoint read failed; starting clean").pipe(
          annotate("persistence_load_failed", { error: errorMessage(read.left) }),
        );
        return Option.none<PersistedState>();
      }
      const decoded = yield* Effect.either(decodePersisted(read.right));
      if (decoded._tag === "Left") {
        // Corruption ⇒ clean start. Rename the bad file aside (best-effort) so it is
        // preserved for diagnosis but can never re-poison a subsequent boot.
        const now = yield* Clock.currentTimeMillis;
        const aside = `${paths.file}.corrupt-${now}`;
        yield* fs.rename(paths.file, aside).pipe(Effect.ignore);
        yield* Effect.logWarning(
          "persistence: corrupt checkpoint; renamed aside, starting clean",
        ).pipe(
          annotate("persistence_corrupt", {
            renamed_to: aside,
            error: errorMessage(decoded.left),
          }),
        );
        return Option.none<PersistedState>();
      }
      const restored = decoded.right;
      yield* Effect.logInfo("persistence: checkpoint restored").pipe(
        annotate("persistence_restored", {
          completed: String(restored.state.completed.length),
          running: String(Object.keys(restored.state.running).length),
          retrying: String(Object.keys(restored.state.retry_attempts).length),
        }),
      );
      return Option.some(restored);
    });

    const save = (value: PersistedState): Effect.Effect<void> =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dir, { recursive: true });
          const json = yield* encodePersisted(value);
          yield* fs.writeFileString(paths.tmp, json);
          // rename(2) is atomic on a single filesystem: a reader/crash sees either the
          // complete old file or the complete new file, never a half-written one.
          yield* fs.rename(paths.tmp, paths.file);
        }).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("persistence: checkpoint write failed").pipe(
              annotate("persistence_save_failed", { error: errorMessage(e) }),
            ),
          ),
        ),
      );

    const markDirty: Effect.Effect<void> = Queue.offer(dirty, undefined).pipe(Effect.asVoid);

    const runWriter = (
      source: Effect.Effect<PersistedState>,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const flush = source.pipe(Effect.flatMap(save));
        // Register the final flush FIRST so it runs LAST on scope close (finalizers are
        // LIFO): the writer fiber is interrupted before the flush, so the flush captures
        // the latest state without racing an in-flight debounced write.
        yield* Effect.addFinalizer(() => flush);
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(dirty).pipe(
              Effect.zipRight(Effect.sleep(Duration.millis(paths.debounceMs))),
              Effect.zipRight(flush),
            ),
          ),
        );
      });

    return { load, save, markDirty, runWriter };
  });

/** Layer providing {@link Persistence} for a resolved config. */
export const layerPersistence = (
  config: ServiceConfig,
): Layer.Layer<Persistence, never, FileSystem.FileSystem> =>
  Layer.effect(Persistence, makePersistence(config));
