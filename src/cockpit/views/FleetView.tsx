import { useState } from "react";
import type { SnapshotWire } from "../api/types";
import { BudgetBar } from "../components/BudgetBar";
import { DispatchControl } from "../components/DispatchControl";
import { SortAscIcon, SortDescIcon, SortIcon } from "../components/icons";
import { Metric } from "../components/Metric";
import { Panel } from "../components/Panel";
import { SkeletonTable } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { ToastRegion, useToast } from "../components/Toast";
import { type SortDir, type SortKey, sortRunning, toFleetView } from "../model/fleet";
import { useSnapshot } from "../snapshot";

/**
 * The Fleet / session-overview view (the cockpit default). Reads the shared snapshot poll
 * (`useSnapshot`); the pure `toFleetView` mapper turns each snapshot into render-ready rows/panels.
 * Additive blocks (budget/restore/rate-limits/control) are omitted when the daemon doesn't send them.
 */
export const FleetView = () => {
  const poll = useSnapshot();
  const toast = useToast();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "elapsed", dir: "desc" });
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const now = Date.now();

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );

  if (poll.data === null) {
    return (
      <div className="view">
        <DispatchControl control={null} onNotify={toast.notify} />
        <div className="metricbar">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells are positional
              key={`m${i}`}
              className="metric"
            >
              <span className="skeleton-bar" style={{ width: "48px", height: "26px" }} />
              <span className="skeleton-bar skeleton-bar--sm" style={{ width: "64px" }} />
            </div>
          ))}
        </div>
        <Panel title="Running sessions">
          <SkeletonTable rows={4} columns={6} />
        </Panel>
        <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
      </div>
    );
  }

  const vm = toFleetView(poll.data, now);
  const filtered =
    statusFilter === "all" ? vm.running : vm.running.filter((r) => r.badge.label === statusFilter);
  const sorted = sortRunning(filtered, sort.key, sort.dir);
  const statusOptions = new Set(vm.running.map((r) => r.badge.label));
  if (statusFilter !== "all") statusOptions.add(statusFilter);
  const statusFilterActions =
    statusOptions.size > 1 || statusFilter !== "all" ? (
      <select
        aria-label="Filter by status"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
      >
        <option value="all">All statuses</option>
        {[...statusOptions].toSorted().map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="view">
      <DispatchControl control={poll.data.control ?? null} onNotify={toast.notify} />

      <div className="metricbar">
        {vm.metrics.map((m) => (
          <Metric key={m.label} metric={m} />
        ))}
      </div>

      <Panel title={`Running sessions (${sorted.length})`} actions={statusFilterActions}>
        {vm.running.length === 0 ? (
          <EmptyFleet snapshot={poll.data} />
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
                  <tr key={r.issueId}>
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

      {/* Aux data — flat grid, no panel wrappers */}
      <section className="aux-grid" aria-label="Fleet details">
        <dl className="kv">
          <Kv k="Input tokens" v={vm.totals.inputTokens.toLocaleString()} />
          <Kv k="Output tokens" v={vm.totals.outputTokens.toLocaleString()} />
          <Kv k="Total tokens" v={vm.totals.totalTokens.toLocaleString()} />
          <Kv k="Runtime" v={vm.totals.runtimeLabel} />
        </dl>
        {vm.budget ? <BudgetBar budget={vm.budget} /> : null}
        {vm.restore ? <p className="muted">{vm.restore.summary}</p> : null}
        {vm.rateLimits.available ? <p className="mono muted">{vm.rateLimits.summary}</p> : null}
      </section>
      <ToastRegion toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
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

/** Actionable empty state — explains *why* no sessions are running and what the operator can do. */
const EmptyFleet = ({ snapshot }: { snapshot: SnapshotWire }) => {
  const paused = snapshot.control?.dispatch_paused ?? false;
  const pausedBy = snapshot.control?.paused_by;
  const retrying = snapshot.counts.retrying;
  const claimed = snapshot.counts.claimed;

  if (paused) {
    const reason =
      pausedBy === "budget"
        ? "Dispatch is paused by the budget gate — raise or clear the token ceiling in Settings to resume."
        : "Dispatch is paused by an operator — use the control above or ⌘K → Resume to start sessions.";
    return <p className="view-placeholder">{reason}</p>;
  }

  if (retrying > 0) {
    return (
      <p className="view-placeholder">
        No sessions active right now. {retrying} issue{retrying > 1 ? "s" : ""} waiting to retry —
        they will dispatch automatically when the backoff window expires.
      </p>
    );
  }

  if (claimed > 0) {
    return (
      <p className="view-placeholder">
        {claimed} issue{claimed > 1 ? "s" : ""} claimed and queued for dispatch. Sessions will start
        shortly.
      </p>
    );
  }

  return (
    <p className="view-placeholder">
      The daemon is polling — no eligible issues found in the tracker yet. Sessions will appear here
      as soon as candidates match the workflow filter.
    </p>
  );
};
