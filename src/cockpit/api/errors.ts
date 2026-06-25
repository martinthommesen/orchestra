import { ApiError, type ApiErrorCode } from "./client";

/**
 * Sprint 6 — operator-facing error copy for the cockpit. The API client throws a typed
 * {@link ApiError} carrying a stable `code`; this is the single place that turns any thrown value
 * (typed API failure, a network drop, or an unexpected throw) into one actionable sentence the
 * operator can read. Pure and DOM-free, so it is reused by the connection poller, the dispatch
 * control, Settings, and the Kanban actions, and unit-tested under Node.
 */

const GUIDANCE: Record<ApiErrorCode, string> = {
  unauthorized: "Not authorized — the operator token is missing or invalid.",
  forbidden: "Forbidden — this token isn't allowed to do that.",
  bad_request: "The daemon rejected that request as invalid.",
  service_unavailable: "The daemon is busy or the command timed out — try again.",
  not_found: "Not found — the daemon has no record of that.",
  server_error: "The daemon hit an internal error.",
  network: "Can't reach the daemon — is it running?",
  unknown: "Something went wrong.",
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
