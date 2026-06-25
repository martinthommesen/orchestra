import { Schema } from "effect";

/**
 * Normalized issue record (SPEC §4.1.1) used by orchestration, prompt rendering,
 * and observability. Adapters (e.g. the GitHub tracker) decode their wire payloads
 * into this shape so the orchestrator never sees tracker-specific types.
 */

/**
 * A label normalized per SPEC §4.2 / §11.3: trimmed and lowercased. Encoding this
 * as a schema transform means *any* decoded {@link Issue} is guaranteed to carry
 * normalized labels — the invariant lives in the type, not in adapter discipline.
 */
const NormalizedLabel = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: (raw) => raw.trim().toLowerCase(),
  encode: (normalized) => normalized,
}).annotations({ identifier: "NormalizedLabel" });

/** Pure helper mirroring {@link NormalizedLabel} for use in comparisons/filtering. */
export const normalizeLabel = (raw: string): string => raw.trim().toLowerCase();

/** Normalize a tracker state for case-insensitive comparison (SPEC §4.2). */
export const normalizeState = (raw: string): string => raw.trim().toLowerCase();

/** Blocker ref nested in {@link Issue.blocked_by} (SPEC §4.1.1). All fields nullable. */
export const BlockerRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
}).annotations({ identifier: "BlockerRef" });
export type BlockerRef = typeof BlockerRef.Type;

export const Issue = Schema.Struct({
  /** Stable tracker-internal ID — use for lookups and map keys. */
  id: Schema.String,
  /** Human-readable ticket key (e.g. `ABC-123`) — use for logs and workspace naming. */
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Lower numbers are higher priority in dispatch sorting. */
  priority: Schema.NullOr(Schema.Int),
  /** Current tracker state name (compare after {@link normalizeState}). */
  state: Schema.String,
  branch_name: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  /** Normalized to lowercase via {@link NormalizedLabel}. */
  labels: Schema.Array(NormalizedLabel),
  blocked_by: Schema.Array(BlockerRef),
  created_at: Schema.NullOr(Schema.Date),
  updated_at: Schema.NullOr(Schema.Date),
}).annotations({ identifier: "Issue" });
export type Issue = typeof Issue.Type;

/** The wire/encoded form of an {@link Issue} (timestamps as ISO strings). */
export type IssueEncoded = typeof Issue.Encoded;

/**
 * Lightweight issue snapshot returned by reconciliation refresh
 * (`fetch_issue_states_by_ids`, SPEC §11.1). Includes labels so the orchestrator
 * can observe label removal and release work (SPEC §11.2).
 */
export const IssueStateRef = Schema.Struct({
  id: Schema.String,
  identifier: Schema.NullOr(Schema.String),
  state: Schema.String,
  labels: Schema.Array(NormalizedLabel),
}).annotations({ identifier: "IssueStateRef" });
export type IssueStateRef = typeof IssueStateRef.Type;
