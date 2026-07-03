import type { CSSProperties } from "react";
import type { Accent } from "../design/tokens";
import { COLOR_TOKEN_VAR } from "../design/tokens";
import type { MetricVM } from "../model/fleet";

/**
 * One cell in the Fleet metric strip — a big tabular-mono count with an uppercase micro-label. The
 * number stays neutral (monochrome chrome); the only chroma is a small status dot before the label
 * for status-tied counts (running=info, retrying=warn, …). `neutral` counts (Claimed, Max agents)
 * carry no dot, so the eye lands on the live states first.
 */
const dotColor = (accent: Accent): string | null =>
  accent === "neutral" ? null : `var(${COLOR_TOKEN_VAR[accent]})`;

export const Metric = ({ metric }: { metric: MetricVM }) => {
  const dot = dotColor(metric.accent);
  return (
    <div className="metric">
      <span className="metric__value">{metric.value}</span>
      <span className="metric__label">
        {dot ? <span className="metric__dot" style={{ background: dot } as CSSProperties} /> : null}
        {metric.label}
      </span>
    </div>
  );
};
