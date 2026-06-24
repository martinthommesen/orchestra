import { type Effect, ParseResult, Schema } from "effect";
import { OrchestratorState } from "../domain/orchestrator-state";

/**
 * Sprint 4 / #40 — the versioned on-disk shape of the orchestrator checkpoint
 * (durability spike §2.2). The file is a **superset** of the `/api/v1/state` snapshot:
 * it carries the full authoritative {@link OrchestratorState} plus a `version`
 * discriminant and a diagnostic `saved_at` instant.
 *
 * Serialization goes through `Schema`, never raw `JSON.stringify`, so `Date`s round-trip
 * as ISO strings and decode is validated (a corrupt file fails with a `ParseError` the
 * loader maps to a clean start, §2.8). The `version` literal anchors the **forward-only**
 * migration seam below.
 */

/** The schema version the running daemon writes. Bump only on incompatible changes. */
export const CURRENT_VERSION = 1 as const;

/** V1 — the only version today: `{ version, saved_at, state }`. */
export const PersistedStateV1 = Schema.Struct({
  version: Schema.Literal(1),
  /** Wall-clock at write; diagnostic only (never used for scheduling). */
  saved_at: Schema.Date,
  /** The authoritative serializable orchestrator state. */
  state: OrchestratorState,
}).annotations({ identifier: "PersistedStateV1" });
export type PersistedStateV1 = typeof PersistedStateV1.Type;

/** The current persisted shape (alias tracks {@link CURRENT_VERSION}). */
export const PersistedState = PersistedStateV1;
export type PersistedState = PersistedStateV1;

/**
 * Forward-only migration seam. Today there is a single known version, so the union is
 * `V1` and {@link migrateToCurrent} is the identity. Adding V2 is mechanical and local:
 *   1. add `PersistedStateV2` + bump {@link CURRENT_VERSION},
 *   2. widen `KnownPersisted` to `Schema.Union(PersistedStateV1, PersistedStateV2)`,
 *   3. add `migrateV1toV2: (v1) => v2` and fold it into `migrateToCurrent`'s switch.
 * Older files always decode (their version's decoder runs, then the chain lifts them to
 * current); the daemon never writes an older version.
 */
const KnownPersisted = PersistedStateV1;
type KnownPersisted = typeof KnownPersisted.Type;

const migrateToCurrent = (known: KnownPersisted): PersistedState => {
  switch (known.version) {
    case 1:
      return known;
  }
};

/** `string <-> KnownPersisted` JSON codec (parses, validates, round-trips Dates). */
const KnownPersistedJson = Schema.parseJson(KnownPersisted);

/** Encode the current persisted shape to a JSON string (Dates → ISO). */
export const encodePersisted = (
  value: PersistedState,
): Effect.Effect<string, ParseResult.ParseError> => Schema.encode(KnownPersistedJson)(value);

/**
 * Decode a raw JSON string to the current {@link PersistedState}, applying the
 * forward-only migration chain. Any parse/validation fault surfaces as a `ParseError`
 * the loader treats as corruption → clean start (§2.4, §2.8).
 */
export const decodePersisted = (
  raw: string,
): Effect.Effect<PersistedState, ParseResult.ParseError> =>
  ParseResult.map(Schema.decodeUnknown(KnownPersistedJson)(raw), migrateToCurrent);

/** Wrap an {@link OrchestratorState} into the current persisted envelope. */
export const toPersisted = (state: OrchestratorState, savedAt: Date): PersistedState =>
  PersistedStateV1.make({ version: CURRENT_VERSION, saved_at: savedAt, state });

/** True when `value` survives `JSON.stringify` (no BigInt / circular ref / throwing toJSON). */
const isJsonEncodable = (value: unknown): boolean => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * #50 / durability spike §2.2 — the field-level guard for `agent_rate_limits`, the **only**
 * `Schema.Unknown` field (vendor JSON passthrough decoded from agent events). It is normally
 * JSON-origin and encodes cleanly, but a pathological non-JSON value (BigInt, circular ref)
 * would otherwise fail `encodePersisted` and — via `save`'s `catchAll` — drop the *whole*
 * atomic checkpoint, losing the durable progress of every other field for that window.
 *
 * This degrades **just that one field** to `null` (valid per `Schema.NullOr(Schema.Unknown)`)
 * so the rest of the state still persists. Every other field is strongly typed and cannot
 * fault the JSON encode, so the guard is deliberately scoped to this single known-fragile
 * field — not a blanket defensive wrap. Returns `degraded: false` (value untouched) on the
 * normal path so the caller can decide whether to emit the structured degradation log.
 */
export const guardRateLimits = (
  value: PersistedState,
): { readonly value: PersistedState; readonly degraded: boolean } => {
  const rateLimits = value.state.agent_rate_limits;
  if (rateLimits === null || isJsonEncodable(rateLimits)) {
    return { value, degraded: false };
  }
  return {
    value: { ...value, state: { ...value.state, agent_rate_limits: null } },
    degraded: true,
  };
};
