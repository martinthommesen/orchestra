import type { ColorToken, Status } from "../../core/observability/glyphs";

/**
 * The cockpit's web design tokens. There is **one** status vocabulary in Orchestra
 * (`core/observability/glyphs.ts`, mirrored in `docs/design-system.md`): the five worker statuses,
 * their glyphs/ASCII fallbacks/labels, and their semantic color tokens. This module **reuses that
 * source directly** — `glyphs.ts` is pure and its only import is a `import type`, so the bundler
 * erases it and no Effect/Schema reaches the browser — and adds only the web-specific binding: each
 * semantic color token → the CSS custom properties carrying its value and its tint background
 * (defined in `tokens.css`). The render-ready status badge (glyph + label + color var) is derived
 * once in `model/fleet.ts` (`badgeOf`/`badgeForPhase`) and consumed by `StatusChip`, so color +
 * glyph parity stays structural, not duplicated.
 */

export type { ColorToken, Status };

/** Each semantic color token → the CSS custom property carrying its foreground value. */
export const COLOR_TOKEN_VAR: Record<ColorToken, string> = {
  info: "--status-info",
  warn: "--status-warn",
  muted: "--status-muted",
  success: "--status-success",
  danger: "--status-danger",
};

/** Each semantic color token → the CSS custom property carrying its tint background. */
export const COLOR_TOKEN_BG_VAR: Record<ColorToken, string> = {
  info: "--status-info-bg",
  warn: "--status-warn-bg",
  muted: "--status-muted-bg",
  success: "--status-success-bg",
  danger: "--status-danger-bg",
};

/** `"neutral"` is the non-status accent used by chrome that isn't tied to a worker state. */
export type Accent = ColorToken | "neutral";
