import type {
  AckWire,
  ControlStateWire,
  EditableSettingsWire,
  SettingsPatchWire,
  SnapshotWire,
} from "./types";

/**
 * Sprint 6 / #67 — the cockpit API client (DD-5/DD-8). A plain-`fetch`, typed wrapper over the
 * daemon's cockpit `HttpApi` — **no Effect in the browser**. Reads (`GET`) are token-free;
 * mutating calls attach the injected bearer token (`window.__ORCHESTRA_COCKPIT_TOKEN__`). Every
 * non-2xx response is surfaced as a typed {@link ApiError} carrying the HTTP status, a stable
 * `code`, and the server's message — so views can render an honest failure without leaking
 * internals.
 *
 * The module is DOM-free (a structural {@link FetchLike} instead of the DOM `fetch` type) so it
 * can be unit-tested under the Node test program with an injected fake `fetch`.
 */

/** A stable, switchable error code derived from the HTTP status. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "service_unavailable"
  | "not_found"
  | "server_error"
  | "network"
  | "unknown";

/** A typed failure from the cockpit API (or the network). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const codeForStatus = (status: number): ApiErrorCode => {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 400:
      return "bad_request";
    case 404:
      return "not_found";
    case 503:
      return "service_unavailable";
    default:
      return status >= 500 ? "server_error" : "unknown";
  }
};

/** Minimal structural shapes of `fetch` — DOM-free, satisfied by both browser and Node fetch. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export type FetchLike = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

/** Read the token the daemon injected into `index.html`, if present (DOM-free access). */
export const readInjectedToken = (): string | undefined =>
  (globalThis as { __ORCHESTRA_COCKPIT_TOKEN__?: string }).__ORCHESTRA_COCKPIT_TOKEN__;

export interface ClientOptions {
  /** API origin; default "" (same-origin → "/api/v1/..."). */
  readonly baseUrl?: string;
  /** Bearer token for mutating calls; default reads the injected global. */
  readonly token?: string | undefined;
  /** Injected fetch (for tests); default the global `fetch`. */
  readonly fetch?: FetchLike;
}

/** The typed cockpit client surface. */
export interface CockpitClient {
  getState(): Promise<SnapshotWire>;
  getSettings(): Promise<EditableSettingsWire>;
  putSettings(patch: SettingsPatchWire): Promise<EditableSettingsWire>;
  pause(): Promise<ControlStateWire>;
  resume(): Promise<ControlStateWire>;
  retry(issueId: string): Promise<AckWire>;
  cancel(issueId: string): Promise<AckWire>;
}

/** Extract the server's human message from an error body (JSON `{message}` or raw text). */
const messageFromBody = (status: number, body: string): string => {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        return parsed.message;
      }
    } catch {
      return body;
    }
  }
  return `request failed with status ${status}`;
};

export const createClient = (opts: ClientOptions = {}): CockpitClient => {
  const baseUrl = opts.baseUrl ?? "";
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const token = opts.token !== undefined ? opts.token : readInjectedToken();

  /** Issue a request; parse JSON on success, throw a typed ApiError otherwise. */
  const request = async <T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const headers: Record<string, string> = {};
    // Reads stay token-free (DD-5); only mutating verbs carry the bearer token.
    if (method !== "GET" && token !== undefined && token !== "") {
      headers.Authorization = `Bearer ${token}`;
    }
    const init: FetchInitLike = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: FetchResponseLike;
    try {
      res = await doFetch(`${baseUrl}${path}`, init);
    } catch (cause) {
      throw new ApiError(0, "network", cause instanceof Error ? cause.message : "network error");
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, codeForStatus(res.status), messageFromBody(res.status, text));
    }
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  };

  return {
    getState: () => request<SnapshotWire>("GET", "/api/v1/state"),
    getSettings: () => request<EditableSettingsWire>("GET", "/api/v1/settings"),
    putSettings: (patch) => request<EditableSettingsWire>("PUT", "/api/v1/settings", patch),
    pause: () => request<ControlStateWire>("POST", "/api/v1/control/pause"),
    resume: () => request<ControlStateWire>("POST", "/api/v1/control/resume"),
    retry: (issueId) =>
      request<AckWire>("POST", `/api/v1/issues/${encodeURIComponent(issueId)}/retry`),
    cancel: (issueId) =>
      request<AckWire>("POST", `/api/v1/issues/${encodeURIComponent(issueId)}/cancel`),
  };
};
