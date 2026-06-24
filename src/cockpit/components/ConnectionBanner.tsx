import type { ConnectionState } from "../model/poller";

/**
 * Sprint 6 / #69 — the connection banner: a small live/stale/connecting indicator plus the last
 * poll error and an "updated Ns ago" hint. Honest by design: a failed poll flips to `stale`
 * while the last-good data stays on screen (never blanks).
 */

const CONNECTION_STYLE: Record<ConnectionState, { label: string; colorVar: string }> = {
  live: { label: "live", colorVar: "var(--status-success)" },
  stale: { label: "stale", colorVar: "var(--status-warn)" },
  connecting: { label: "connecting", colorVar: "var(--status-info)" },
};

export const ConnectionBanner = ({
  connection,
  error,
  updatedLabel,
}: {
  connection: ConnectionState;
  error: string | null;
  updatedLabel: string | null;
}) => {
  const style = CONNECTION_STYLE[connection];
  return (
    <div className="conn-banner" role="status">
      <span
        className="conn-banner__dot"
        style={{ background: style.colorVar }}
        aria-hidden="true"
      />
      <span className="conn-banner__label" style={{ color: style.colorVar }}>
        {style.label}
      </span>
      {updatedLabel ? <span className="conn-banner__updated">{updatedLabel}</span> : null}
      {error ? <span className="conn-banner__error">· {error}</span> : null}
    </div>
  );
};
