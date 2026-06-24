import { useApp, useInput, useStdin } from "ink";
import type { DashboardOptions } from "./args";
import { DashboardView } from "./components";
import type { FetchSnapshot } from "./snapshot-client";
import { useSnapshot } from "./use-snapshot";
import { toViewModel } from "./view-model";

/**
 * Dashboard root component (#32). Drives the injected {@link useSnapshot} polling hook,
 * folds its state into a render-ready view model via {@link toViewModel} (recomputing
 * elapsed from the current wall-clock on every render), and renders the read-only fleet
 * view. `q` and Ctrl-C unmount Ink; the hook's effect cleanup aborts the in-flight fetch
 * and clears the poll timer, so no handles leak.
 *
 * Elapsed advances on each poll-driven re-render rather than on a separate ticker — one
 * fewer timer to leak, and an operations view does not need sub-poll granularity.
 *
 * Keyboard handling is gated on `isRawModeSupported`: when stdin is not a TTY (piped,
 * redirected, or otherwise non-interactive) raw mode is unavailable, so we leave
 * {@link useInput} inactive rather than letting Ink throw. The view still renders and
 * the process exits on SIGINT/SIGTERM from the controlling terminal.
 */

export interface AppProps {
  readonly baseUrl: string;
  readonly options: DashboardOptions;
  readonly fetchSnapshot: FetchSnapshot;
  readonly color: boolean;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export function App({ baseUrl, options, fetchSnapshot, color, now }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  // Coerce to a real boolean: Ink derives this from `stdin.isTTY`, which is `undefined`
  // (not `false`) for non-TTY streams, and useInput only short-circuits on a strict
  // `isActive === false`.
  const keyboardActive = isRawModeSupported === true;

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
      }
    },
    { isActive: keyboardActive },
  );

  const state = useSnapshot({
    fetchSnapshot,
    baseUrl,
    intervalMs: options.intervalMs,
    ...(now !== undefined ? { now } : {}),
  });

  const clock = now ?? Date.now;
  const vm = toViewModel(state.snapshot, clock(), {
    connection: state.connection,
    error: state.error,
    lastUpdatedAtMs: state.lastUpdatedAtMs,
    baseUrl,
  });

  return <DashboardView vm={vm} ascii={options.ascii} color={color} />;
}
