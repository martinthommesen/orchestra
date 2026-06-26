import type { CSSProperties } from "react";
import type { Accent } from "../design/tokens";
import { COLOR_TOKEN_BG_VAR, COLOR_TOKEN_VAR } from "../design/tokens";
import type { MetricVM } from "../model/fleet";

/**
 * Accent metric card — a count with a colored top rule tied to its design-system accent. `neutral`
 * (e.g. Max agents) uses the border color so it recedes; status-tied counts (running=info,
 * retrying=warn, …) lead the eye. The value stays mono + tabular for scan-ability.
 */
const accentColor = (accent: Accent): string =>
  accent === "neutral" ? "var(--border-strong)" : `var(${COLOR_TOKEN_VAR[accent]})`;

const accentBg = (accent: Accent): string =>
  accent === "neutral" ? "transparent" : `var(${COLOR_TOKEN_BG_VAR[accent]})`;

export const Metric = ({ metric }: { metric: MetricVM }) => (
  <div
    className="metric"
    style={
      {
        "--metric-accent": accentColor(metric.accent),
        "--metric-accent-bg": accentBg(metric.accent),
      } as CSSProperties
    }
  >
    <span className="metric__value">{metric.value}</span>
    <span className="metric__label">{metric.label}</span>
  </div>
);
