import { COCKPIT_POLL_MS, client } from "../api/instance";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Panel } from "../components/Panel";
import { toFleetView } from "../model/fleet";
import { formatDuration } from "../model/format";
import { usePolling } from "../usePolling";

/**
 * Sprint 6 / #69 — the Fleet / session-overview view (the cockpit default). Non-overlapping poll
 * of `GET /api/v1/state` with last-good-on-error (via `usePolling`/`Poller`); the pure
 * `toFleetView` mapper turns each snapshot into render-ready rows/panels. Additive blocks
 * (budget/restore/rate-limits/control) are omitted when the daemon doesn't send them.
 */
export const FleetView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const now = Date.now();
  const updatedLabel =
    poll.lastUpdatedAtMs === null
      ? null
      : `updated ${formatDuration(now - poll.lastUpdatedAtMs)} ago`;

  if (poll.data === null) {
    return (
      <>
        <ConnectionBanner connection={poll.connection} error={poll.error} updatedLabel={null} />
        <Panel title="Fleet">
          <p className="view-placeholder">Waiting for the first snapshot…</p>
        </Panel>
      </>
    );
  }

  const vm = toFleetView(poll.data, now);

  return (
    <>
      <ConnectionBanner
        connection={poll.connection}
        error={poll.error}
        updatedLabel={updatedLabel}
      />

      {vm.control ? (
        <div
          className="control-banner"
          role="status"
          style={{
            borderColor:
              vm.control.pausedBy === "operator" ? "var(--status-info)" : "var(--status-warn)",
          }}
        >
          <span className="control-banner__glyph" aria-hidden="true">
            ⏸
          </span>
          <span>{vm.control.message}</span>
        </div>
      ) : null}

      <div className="metric-row">
        <Metric label="Running" value={vm.counts.running} />
        <Metric label="Retrying" value={vm.counts.retrying} />
        <Metric label="Completed" value={vm.counts.completed} />
        <Metric label="Claimed" value={vm.counts.claimed} />
        <Metric label="Max agents" value={vm.maxConcurrentAgents} />
      </div>

      <Panel title={`Running sessions (${vm.running.length})`}>
        {vm.running.length === 0 ? (
          <p className="view-placeholder">No sessions running right now.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Status</th>
                <th>Elapsed</th>
                <th>Attempt</th>
                <th>Workspace</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {vm.running.map((r) => (
                <tr key={r.issueId}>
                  <td className="mono">{r.identifier}</td>
                  <td>
                    <span
                      className="status-chip"
                      role="img"
                      aria-label={`status: ${r.badge.label}`}
                      style={{ color: r.badge.colorVar, borderColor: r.badge.colorVar }}
                    >
                      <span aria-hidden="true">{r.badge.glyph}</span>
                      <span>{r.badge.label}</span>
                    </span>
                    {r.badge.known ? null : <span className="phase-hint"> phase={r.phase}</span>}
                  </td>
                  <td className="mono">{r.elapsedLabel}</td>
                  <td className="mono">{r.attemptLabel}</td>
                  <td className="mono workspace">{r.workspace}</td>
                  <td className="muted">{r.lastActivityLabel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="panel-grid">
        <Panel title="Totals">
          <dl className="kv">
            <Kv k="Input tokens" v={vm.totals.inputTokens.toLocaleString()} />
            <Kv k="Output tokens" v={vm.totals.outputTokens.toLocaleString()} />
            <Kv k="Total tokens" v={vm.totals.totalTokens.toLocaleString()} />
            <Kv k="Runtime" v={vm.totals.runtimeLabel} />
          </dl>
        </Panel>

        {vm.budget ? (
          <Panel title="Budget">
            <p>
              <span style={{ color: vm.budget.colorVar }}>{vm.budget.stateLabel}</span> ·{" "}
              {vm.budget.summary}
            </p>
          </Panel>
        ) : null}

        {vm.restore ? (
          <Panel title="Restore">
            <p className="muted">{vm.restore.summary}</p>
          </Panel>
        ) : null}

        {vm.rateLimits.available ? (
          <Panel title="Rate limits">
            <p className="mono muted">{vm.rateLimits.summary}</p>
          </Panel>
        ) : null}
      </div>
    </>
  );
};

const Metric = ({ label, value }: { label: string; value: number }) => (
  <div className="metric">
    <span className="metric__value">{value}</span>
    <span className="metric__label">{label}</span>
  </div>
);

const Kv = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd className="mono">{v}</dd>
  </>
);
