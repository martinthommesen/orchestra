import { useEffect, useRef, useState } from "react";
import { initialPollState, Poller, type PollState } from "./model/poller";

/**
 * Sprint 6 / #69 — thin React adapter over the DOM-free `Poller`. Owns the poll lifecycle for a
 * mounted view: starts on mount, tears down on unmount, and re-creates only when `fetch`/interval
 * identity changes. All the scheduling/last-good-on-error logic lives in (and is tested via) the
 * `Poller` class.
 */
export const usePolling = <T>(fetch: () => Promise<T>, intervalMs: number): PollState<T> => {
  const [state, setState] = useState<PollState<T>>(() => initialPollState<T>());
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    const poller = new Poller<T>({
      fetch: () => fetchRef.current(),
      intervalMs,
      onChange: setState,
    });
    poller.start();
    return () => poller.stop();
  }, [intervalMs]);

  return state;
};
