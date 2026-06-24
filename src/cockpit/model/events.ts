import { truncateOneLine } from "../../core/observability/glyphs";
import type { EventEnvelopeWire, SnapshotWire } from "../api/types";
import type { ColorToken } from "../design/tokens";
import { COLOR_TOKEN_VAR } from "../design/tokens";
import { formatRelative } from "./format";

/**
 * Sprint 6 / #69 — the pure Events-feed view-model. `recent_events` rides the wire newest-last
 * (an append-only ring); this mapper reverses it to newest-first and precomputes the glyph/color
 * per event kind (reusing the `glyphs.ts` status vocabulary). `filterEvents` is a pure predicate
 * over the derived rows so the React view only owns the filter UI state. All unit-tested.
 */

const MESSAGE_MAX = 200;

interface FeedGlyph {
  readonly color: ColorToken;
  readonly glyph: string;
}

/** Glyph + color per lifecycle `kind`, reusing the design-system status vocabulary. */
const EVENT_KIND_STYLE: Record<string, FeedGlyph> = {
  started: { color: "info", glyph: "▶" },
  dispatched: { color: "info", glyph: "▶" },
  retry_scheduled: { color: "warn", glyph: "⏳" },
  retry_fired: { color: "warn", glyph: "⏳" },
  completed: { color: "success", glyph: "✓" },
  workspace_cleaned: { color: "muted", glyph: "✓" },
  startup_cleanup: { color: "muted", glyph: "✓" },
  failed: { color: "danger", glyph: "✗" },
  killed: { color: "danger", glyph: "✗" },
  preflight_failed: { color: "danger", glyph: "✗" },
};

const WARN_GLYPH: FeedGlyph = { color: "warn", glyph: "⚠" };
const INFO_GLYPH: FeedGlyph = { color: "muted", glyph: "·" };

const eventGlyph = (level: "info" | "warn", kind: string): FeedGlyph =>
  EVENT_KIND_STYLE[kind] ?? (level === "warn" ? WARN_GLYPH : INFO_GLYPH);

export interface EventRowVM {
  readonly seq: number;
  readonly glyph: string;
  readonly colorVar: string;
  readonly level: "info" | "warn";
  readonly kind: string;
  readonly message: string;
  readonly relativeLabel: string;
  readonly identifier: string | null;
}

const toEventRow = (now: number, e: EventEnvelopeWire): EventRowVM => {
  const style = eventGlyph(e.level, e.kind);
  return {
    seq: e.seq,
    glyph: style.glyph,
    colorVar: `var(${COLOR_TOKEN_VAR[style.color]})`,
    level: e.level,
    kind: e.kind,
    message: truncateOneLine(e.message, MESSAGE_MAX),
    relativeLabel: formatRelative(now, e.emitted_at),
    identifier: e.identifier ?? null,
  };
};

/** Derive the full event feed, newest-first. */
export const toEventsView = (s: SnapshotWire, now: number): ReadonlyArray<EventRowVM> =>
  [...s.recent_events].reverse().map((e) => toEventRow(now, e));

/** The distinct event kinds present (sorted) — feeds the filter dropdown. */
export const eventKinds = (rows: ReadonlyArray<EventRowVM>): ReadonlyArray<string> =>
  [...new Set(rows.map((r) => r.kind))].sort();

export interface EventFilter {
  /** "all" | a specific level. */
  readonly level: "all" | "info" | "warn";
  /** "all" | a specific kind. */
  readonly kind: string;
  /** Free-text match against message + identifier (case-insensitive). */
  readonly query: string;
}

export const EMPTY_FILTER: EventFilter = { level: "all", kind: "all", query: "" };

/** Pure predicate filter over derived rows (newest-first order preserved). */
export const filterEvents = (
  rows: ReadonlyArray<EventRowVM>,
  filter: EventFilter,
): ReadonlyArray<EventRowVM> => {
  const q = filter.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.level !== "all" && r.level !== filter.level) return false;
    if (filter.kind !== "all" && r.kind !== filter.kind) return false;
    if (q !== "") {
      const hay = `${r.message} ${r.identifier ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
};
