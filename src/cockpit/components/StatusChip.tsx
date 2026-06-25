import type { StatusBadgeVM } from "../model/fleet";

/**
 * Shared status chip (#68) — the single place a status badge is rendered. Consumes the
 * render-ready `StatusBadgeVM` derived once in `model/fleet.ts` (glyph + label + color var) so
 * Fleet (#69) and Kanban (#70) stay markup-free and can't drift. The visible label always carries
 * the status (color is never the only signal — parity with the CLI's accessibility note); the
 * glyph is decorative, so it's `aria-hidden` and the chip needs no extra ARIA role/label.
 */
export const StatusChip = ({ badge }: { badge: StatusBadgeVM }) => (
  <span className="status-chip" style={{ color: badge.colorVar, borderColor: badge.colorVar }}>
    <span className="status-chip__glyph" aria-hidden="true">
      {badge.glyph}
    </span>
    <span className="status-chip__label">{badge.label}</span>
  </span>
);
