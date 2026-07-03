import type { ReactNode } from "react";

/**
 * Shared panel primitive — a titled card for primary content areas (data tables, event feeds).
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
