import type { ReactNode } from "react";

/**
 * Shared panel primitive (#68) — a titled card reused across Fleet/Events/Kanban/Settings. The
 * additive snapshot contract means a panel is simply omitted when its data is absent, so callers
 * conditionally render `<Panel>` rather than showing an empty shell.
 */
export const Panel = ({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <section className="panel" aria-label={title}>
    <header className="panel__header">
      <h2 className="panel__title">{title}</h2>
      {actions ? <div className="panel__actions">{actions}</div> : null}
    </header>
    <div className="panel__body">{children}</div>
  </section>
);
