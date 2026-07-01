import { createContext, use } from "react";
import type { SnapshotWire } from "./api/types";
import type { PollState } from "./model/poller";

/**
 * The single shared snapshot poll. Lifted to `App` and provided here so every view, the sidebar
 * fleet-status footer, and the command palette read ONE non-overlapping poll of `GET /api/v1/state`
 * (last-good-on-error) instead of each mounting its own — fewer requests, and the connection state
 * is global (the sidebar shows it once, not per view).
 */
export type SnapshotPoll = PollState<SnapshotWire>;

const SnapshotContext = createContext<SnapshotPoll | null>(null);

export const SnapshotProvider = SnapshotContext.Provider;

export const useSnapshot = (): SnapshotPoll => {
  const value = use(SnapshotContext);
  if (value === null) {
    throw new Error("useSnapshot must be used within a SnapshotProvider");
  }
  return value;
};
