import { useEffect, useState } from "react";
import {
  INITIAL_SNAPSHOT_STATE,
  SnapshotPoller,
  type SnapshotPollerDeps,
  type SnapshotState,
} from "./poller";

/**
 * React hook that drives a {@link SnapshotPoller} and mirrors its state into the
 * component (#31). The fetcher is injected (no Effect runtime crosses into Ink), and
 * the effect's cleanup `stop()`s the poller on unmount — aborting the in-flight fetch
 * and clearing the timer so no handles leak.
 */

export type UseSnapshotOptions = Pick<
  SnapshotPollerDeps,
  "fetchSnapshot" | "baseUrl" | "intervalMs" | "now"
>;

export const useSnapshot = (options: UseSnapshotOptions): SnapshotState => {
  const [state, setState] = useState<SnapshotState>(INITIAL_SNAPSHOT_STATE);
  const { fetchSnapshot, baseUrl, intervalMs, now } = options;

  useEffect(() => {
    const poller = new SnapshotPoller({
      fetchSnapshot,
      baseUrl,
      intervalMs,
      onChange: setState,
      ...(now !== undefined ? { now } : {}),
    });
    poller.start();
    return () => poller.stop();
  }, [fetchSnapshot, baseUrl, intervalMs, now]);

  return state;
};
