import type { Status } from "../design/tokens";
import { statusVisual } from "../design/tokens";

/**
 * Shared status chip (#68) — reused by Fleet (#69) and Kanban (#70). Renders the status' glyph
 * **and** label (color is never the only signal — parity with the CLI accessibility note) and
 * colors itself from the one design-token source.
 */
export const StatusChip = ({ status }: { status: Status }) => {
  const v = statusVisual(status);
  return (
    <span
      className="status-chip"
      role="img"
      style={{ color: v.colorVar, borderColor: v.colorVar }}
      aria-label={`status: ${v.label}`}
    >
      <span className="status-chip__glyph" aria-hidden="true">
        {v.glyph}
      </span>
      <span className="status-chip__label">{v.label}</span>
    </span>
  );
};
