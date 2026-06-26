import { type CSSProperties, useState } from "react";
import { COCKPIT_POLL_MS, client } from "../api/instance";
import { BudgetBar } from "../components/BudgetBar";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { DispatchControl } from "../components/DispatchControl";
import { SortAscIcon, SortDescIcon, SortIcon } from "../components/icons";
import { Metric } from "../components/Metric";
import { Panel } from "../components/Panel";
import { SkeletonTable } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { ToastRegion, useToast, useToastAutoDismiss } from "../components/Toast";
import { type SortDir, type SortKey, sortRunning, toFleetView } from "../model/fleet";
import { formatDuration } from "../model/format";
import { usePolling } from "../usePolling";

/**
 * The Fleet / session-overview view (the cockpit default). Non-overlapping poll of
 * `GET /api/v1/state` with last-good-on-error (via `usePolling`/`Poller`); the pure `toFleetView`
 * mapper turns each snapshot into render-ready rows/panels. Additive blocks (budget/restore/rate-
 * limits/control) are omitted when the daemon doesn't send them. The running-sessions table is
 * sortable (click a header) and filterable by status; both derive purely from the view-model.
 */
export const FleetView = () => {
  const poll = usePolling(() => client.getState(), COCKPIT_POLL_MS);
  const toast = useToast();
  useToastAutoDismiss(toast.toasts, toast.dismiss);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "elapsed", dir: "desc" });
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const now = Date.now();
  const updatedLabel =
    poll.lastUpdatedAtMs === null
      ? null
      : `updated ${formatDuration(now - poll.lastUpdatedAtMs)} ago`;

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );

  if (poll.data === null) {
    return (
      <>
        <div className="fleet-toolbar">
          <ConnectionBanner
            connection={poll.connection}
            error={poll.error}
            updatedLabel={null}
            intervalMs={COCKPIT_POLL_MS}
            lastUpdatedAtMs={poll.lastUpdatedAtMs}
          />
        </div>
        <div className="metric-row">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders are positional
              key={`m${i}`}
              className="skeleton-bar"
              style={{ width: "96px", height: "56px" }}
            />
          ))}
        </div>
        <Panel title="Running sessions">
          <SkeletonTable rows={4} columns={6} />
        </Panel>
        <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
      </>
    );
  }

  const vm = toFleetView(poll.data, now);
  const filtered =
    statusFilter === "all" ? vm.running : vm.running.filter((r) => r.badge.label === statusFilter);
  const sorted = sortRunning(filtered, sort.key, sort.dir);
  // Options = statuses currently present PLUS the active filter, so a filter whose status has
  // since vanished stays visible and clearable (otherwise the control would disappear while the
  // stale filter still hid every live row, stranding "No sessions match" with no way to reset).
  const statusOptions = new Set(vm.running.map((r) => r.badge.label));
  if (statusFilter !== "all") statusOptions.add(statusFilter);
  const statusFilterActions =
    statusOptions.size > 1 || statusFilter !== "all" ? (
      <select
        aria-label="Filter by status"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
      >
        <option value="all">all statuses</option>
        {[...statusOptions].toSorted().map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <>
      <div className="fleet-toolbar">
        <ConnectionBanner
          connection={poll.connection}
          error={poll.error}
          updatedLabel={updatedLabel}
          intervalMs={COCKPIT_POLL_MS}
          lastUpdatedAtMs={poll.lastUpdatedAtMs}
        />
        <DispatchControl control={poll.data.control ?? null} onNotify={toast.notify} />
      </div>

      <div className="metric-row">
        {vm.metrics.map((m) => (
          <Metric key={m.label} metric={m} />
        ))}
      </div>

      <Panel title={`Running sessions (${sorted.length})`} actions={statusFilterActions}>
        {vm.running.length === 0 ? (
          <p className="view-placeholder">No sessions running right now.</p>
        ) : sorted.length === 0 ? (
          <p className="view-placeholder">No sessions match the status filter.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortHeader k="issue" sort={sort} onSort={onSort}>
                    Issue
                  </SortHeader>
                  <SortHeader k="status" sort={sort} onSort={onSort}>
                    Status
                  </SortHeader>
                  <SortHeader k="elapsed" sort={sort} onSort={onSort}>
                    Elapsed
                  </SortHeader>
                  <SortHeader k="attempt" sort={sort} onSort={onSort}>
                    Attempt
                  </SortHeader>
                  <th>Workspace</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.issueId}
                    className="is-accented"
                    style={{ "--row-accent": r.badge.colorVar } as CSSProperties}
                  >
                    <td className="mono">{r.identifier}</td>
                    <td>
                      <StatusChip badge={r.badge} />
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
          </div>
        )}
      </Panel>

      <div className="panel-grid">
        <Panel title="Totals" variant="aux">
          <dl className="kv">
            <Kv k="Input tokens" v={vm.totals.inputTokens.toLocaleString()} />
            <Kv k="Output tokens" v={vm.totals.outputTokens.toLocaleString()} />
            <Kv k="Total tokens" v={vm.totals.totalTokens.toLocaleString()} />
            <Kv k="Runtime" v={vm.totals.runtimeLabel} />
          </dl>
        </Panel>

        {vm.budget ? (
          <Panel title="Budget" variant="aux">
            <BudgetBar budget={vm.budget} />
          </Panel>
        ) : null}

        {vm.restore ? (
          <Panel title="Restore" variant="aux">
            <p className="muted">{vm.restore.summary}</p>
          </Panel>
        ) : null}

        {vm.rateLimits.available ? (
          <Panel title="Rate limits" variant="aux">
            <p className="mono muted">{vm.rateLimits.summary}</p>
          </Panel>
        ) : null}
      </div>
      <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  );
};

const Kv = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd className="mono">{v}</dd>
  </>
);

/** Sortable table header — module-scope so React doesn't remount it (and reset its state) per render. */
const SortHeader = ({
  k,
  sort,
  onSort,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  children: string;
}) => {
  const active = sort.key === k;
  // The sort control is a real <button> inside the header cell so it is keyboard-focusable and
  // activates on Enter/Space natively; `aria-sort` stays on the <th> (the column header) per ARIA.
  return (
    <th
      className={`is-sortable${active ? " is-sorted" : ""}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="th-sort-btn" onClick={() => onSort(k)}>
        {children}
        <span className="th-sort" aria-hidden="true">
          {active ? sort.dir === "asc" ? <SortAscIcon /> : <SortDescIcon /> : <SortIcon />}
        </span>
      </button>
    </th>
  );
};
