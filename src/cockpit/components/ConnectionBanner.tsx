import type { ConnectionState } from "../model/poller";
import { RefreshIcon } from "./icons";

/**
 * The connection banner: a live/stale/connecting pill plus the last poll error and an "updated Ns
 * ago" hint. Honest by design: a failed poll flips to `stale` while the last-good data stays on
 * screen (never blanks). A thin refresh-cycle indicator animates over the poll interval and
 * restarts each time a fresh snapshot lands (`key`ed on `lastUpdatedAtMs`); it is decorative — the
 * dot + label carry the connection state, and it freezes under reduced-motion.
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
  intervalMs,
  lastUpdatedAtMs,
}: {
  connection: ConnectionState;
  error: string | null;
  updatedLabel: string | null;
  intervalMs: number;
  lastUpdatedAtMs: number | null;
}) => {
  const style = CONNECTION_STYLE[connection];
  return (
    <output className="conn-banner">
      <span
        className="conn-banner__pill"
        style={{ color: style.colorVar, borderColor: style.colorVar }}
      >
        <span
          className={`conn-banner__dot conn-banner__dot--${connection}`}
          style={{ background: style.colorVar }}
          aria-hidden="true"
        />
        <span className="conn-banner__label">{style.label}</span>
      </span>
      {updatedLabel ? <span className="conn-banner__updated">{updatedLabel}</span> : null}
      {lastUpdatedAtMs !== null ? (
        <span
          className="conn-banner__cycle"
          aria-hidden="true"
          style={{ animationDuration: `${intervalMs}ms` }}
          key={lastUpdatedAtMs}
        >
          <RefreshIcon />
        </span>
      ) : null}
      {error ? <span className="conn-banner__error">· {error}</span> : null}
    </output>
  );
};
