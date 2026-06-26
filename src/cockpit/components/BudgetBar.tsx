import type { BudgetVM } from "../model/fleet";

/**
 * Budget progress bar — visualizes `spent / limit` as a filled track, colored by state (active =
 * info, paused = warn), with the existing summary text below. The fraction is clamped in the
 * view-model so the fill never overflows. Color is reinforced by the text label (state + summary),
 * so the bar is not the only signal.
 */
export const BudgetBar = ({ budget }: { budget: BudgetVM }) => (
  <div className="budget-bar">
    <div className="budget-bar__head">
      <span className="budget-bar__state" style={{ color: budget.colorVar }}>
        {budget.stateLabel}
      </span>
      <span className="budget-bar__pct mono">{budget.percentLabel}</span>
    </div>
    <progress
      className="budget-bar__track"
      value={Math.round(budget.fraction * 100)}
      max={100}
      aria-label={`Budget ${budget.stateLabel}: ${budget.percentLabel} spent`}
      style={{ accentColor: budget.colorVar }}
    >
      {budget.percentLabel}
    </progress>
    <p className="budget-bar__summary muted mono">{budget.summary}</p>
  </div>
);
