import type { StatusBadgeVM } from "../model/fleet";

/**
 * Shared status chip — the single place a status badge is rendered. Consumes the render-ready
 * `StatusBadgeVM` derived once in `model/fleet.ts` (glyph + label + color var + tint var) so Fleet
 * and Kanban stay markup-free and can't drift. The visible label always carries the status (color
 * is never the only signal — parity with the CLI's accessibility note); the glyph is decorative, so
 * it's `aria-hidden` and the chip needs no extra ARIA role/label.
 *
 * Filled semantic style: a tinted background + colored text + colored border (was outline-only),
 * so a status reads at a glance without sacrificing the glyph+label redundancy.
 */
export const StatusChip = ({
  badge,
  size = "md",
}: {
  badge: StatusBadgeVM;
  size?: "sm" | "md";
}) => (
  <span
    className={`status-chip status-chip--${size}`}
    style={{ color: badge.colorVar, background: badge.bgVar, borderColor: badge.colorVar }}
  >
    <span className="status-chip__glyph" aria-hidden="true">
      {badge.glyph}
    </span>
    <span className="status-chip__label">{badge.label}</span>
  </span>
);
