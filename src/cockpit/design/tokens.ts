import {
  type ColorToken,
  PHASE_TO_STATUS,
  phaseStatus,
  STATUS_STYLES,
  type Status,
} from "../../core/observability/glyphs";

/**
 * Sprint 6 / #68 — the cockpit's web design tokens. There is **one** status vocabulary in
 * Orchestra (`core/observability/glyphs.ts`, mirrored in `docs/design-system.md`): the five
 * worker statuses, their glyphs/ASCII fallbacks/labels, and their semantic color tokens. This
 * module **reuses that source directly** — `glyphs.ts` is pure and its only import is a
 * `import type`, so the bundler erases it and no Effect/Schema reaches the browser — and adds
 * only the web-specific binding: each semantic color token → a CSS custom property (defined in
 * `tokens.css`). That keeps color + glyph parity structural, not duplicated.
 */

export type { ColorToken, Status };
export { PHASE_TO_STATUS, phaseStatus, STATUS_STYLES };

/** Each semantic color token → the CSS custom property carrying its value (see `tokens.css`). */
export const COLOR_TOKEN_VAR: Record<ColorToken, string> = {
  info: "--status-info",
  warn: "--status-warn",
  muted: "--status-muted",
  success: "--status-success",
  danger: "--status-danger",
};

/** Everything a chip/cell needs to render a status: glyph + label + a CSS color reference. */
export interface StatusVisual {
  readonly status: Status;
  readonly glyph: string;
  readonly ascii: string;
  readonly label: string;
  /** A `var(--status-…)` reference for `color`/`border-color`. */
  readonly colorVar: string;
}

/** Resolve the full visual for a status (glyph/label from the one source; color → CSS var). */
export const statusVisual = (status: Status): StatusVisual => {
  const style = STATUS_STYLES[status];
  return {
    status,
    glyph: style.glyph,
    ascii: style.ascii,
    label: style.label,
    colorVar: `var(${COLOR_TOKEN_VAR[style.color]})`,
  };
};

/** Event-feed level → semantic color token (info reads muted; warn is highlighted). */
export const LEVEL_COLOR_TOKEN: Record<"info" | "warn", ColorToken> = {
  info: "muted",
  warn: "warn",
};

/** Event-feed level → a `var(--status-…)` color reference. */
export const levelColorVar = (level: "info" | "warn"): string =>
  `var(${COLOR_TOKEN_VAR[LEVEL_COLOR_TOKEN[level]]})`;
