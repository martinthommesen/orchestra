/**
 * Loading skeletons — shimmer placeholders that stand in for not-yet-arrived content (the first
 * snapshot, the settings form) instead of plain "Waiting…" text. CSS-only shimmer (in `app.css`),
 * disabled under `prefers-reduced-motion` (the tokens reset freezes it to a static tint). No layout
 * shift once real data arrives: skeletons mirror the shape of the rows/cards they replace.
 */

export const SkeletonRow = ({ columns = 6 }: { columns?: number }) => (
  <div className="skeleton-row" aria-hidden="true">
    {Array.from({ length: columns }, (_, i) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton bars are purely positional placeholders
        key={`s${i}`}
        className="skeleton-bar"
        style={{ width: `${[40, 60, 30, 20, 70, 45][i % 6]}%` }}
      />
    ))}
  </div>
);

export const SkeletonTable = ({ rows = 4, columns = 6 }: { rows?: number; columns?: number }) => (
  <div className="skeleton-table" aria-hidden="true">
    {Array.from({ length: rows }, (_, r) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are purely positional placeholders
      <SkeletonRow key={`r${r}`} columns={columns} />
    ))}
  </div>
);

export const SkeletonCards = ({ count = 3 }: { count?: number }) => (
  <div className="skeleton-cards" aria-hidden="true">
    {Array.from({ length: count }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cards are purely positional placeholders
      <div key={`c${i}`} className="skeleton-card">
        <span className="skeleton-bar skeleton-bar--sm" style={{ width: "45%" }} />
        <span className="skeleton-bar" style={{ width: "80%" }} />
        <span className="skeleton-bar skeleton-bar--sm" style={{ width: "30%" }} />
      </div>
    ))}
  </div>
);

export const SkeletonForm = ({ fields = 4 }: { fields?: number }) => (
  <div className="skeleton-form" aria-hidden="true">
    {Array.from({ length: fields }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: skeleton fields are purely positional placeholders
      <div key={`f${i}`} className="skeleton-field">
        <span className="skeleton-bar skeleton-bar--sm" style={{ width: "30%" }} />
        <span className="skeleton-bar" style={{ width: "100%" }} />
      </div>
    ))}
  </div>
);
