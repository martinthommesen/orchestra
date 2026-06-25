import type { ReactNode } from "react";

/**
 * Shared panel primitive (#68) — a titled card reused across Fleet/Events/Kanban/Settings. The
 * additive snapshot contract means a panel is simply omitted when its data is absent, so callers
 * conditionally render `<Panel>` rather than showing an empty shell.
 *
 * `variant` sets visual weight: `primary` (default) is a full-strength panel that leads a view;
 * `aux` is a quieter companion (muted title, no shadow) for the additive side panels so the
 * primary content reads first.
 */
export const Panel = ({
  title,
  actions,
  variant = "primary",
  children,
}: {
  title: string;
  actions?: ReactNode;
  variant?: "primary" | "aux";
  children: ReactNode;
}) => (
  <section className={`panel panel--${variant}`} aria-label={title}>
    <header className="panel__header">
      <h2 className="panel__title">{title}</h2>
      {actions ? <div className="panel__actions">{actions}</div> : null}
    </header>
    <div className="panel__body">{children}</div>
  </section>
);
