import { ApiError, type ApiErrorCode } from "./client";

/**
 * Sprint 6 — operator-facing error copy for the cockpit. The API client throws a typed
 * {@link ApiError} carrying a stable `code`; this is the single place that turns any thrown value
 * (typed API failure, a network drop, or an unexpected throw) into one actionable sentence the
 * operator can read. Pure and DOM-free, so it is reused by the connection poller, the dispatch
 * control, Settings, and the Kanban actions, and unit-tested under Node.
 */

const GUIDANCE: Record<ApiErrorCode, string> = {
  unauthorized:
    "Not authorized — the operator token is missing or invalid. Check that the token in the browser matches the one the daemon printed at startup.",
  forbidden: "Forbidden — this token isn't allowed to perform that action.",
  bad_request: "The daemon rejected that request as invalid — check the value and try again.",
  service_unavailable:
    "The daemon is busy or the command timed out. It may still be processing — wait a moment and retry.",
  not_found: "Not found — the daemon has no record of that resource. It may have been cleaned up.",
  server_error:
    "The daemon hit an internal error. Check the terminal running `orchestra` for a stack trace.",
  network:
    "Can't reach the daemon — is it still running? Check the terminal for errors or restart it.",
  unknown: "Something unexpected went wrong. Check the daemon's terminal output for details.",
};

/** Turn any thrown value into an actionable, operator-facing message. */
export const describeError = (err: unknown): string => {
  if (err instanceof ApiError) {
    const guidance = GUIDANCE[err.code];
    const detail = err.message.trim();
    // Append the server's own detail only when it adds information beyond the guidance.
    return detail.length > 0 && detail !== guidance ? `${guidance} (${detail})` : guidance;
  }
  if (err instanceof Error) return err.message;
  return String(err);
};
