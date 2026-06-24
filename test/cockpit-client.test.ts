import { describe, expect, it } from "vitest";
import {
  ApiError,
  createClient,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
} from "../src/cockpit/api/client";

/**
 * Sprint 6 / #67 — the plain-fetch API client. Pure unit tests with an injected fake `fetch`:
 * reads are token-free, mutating calls carry the bearer token + JSON body, and non-2xx
 * responses surface as typed {@link ApiError}s. No DOM / network.
 */

interface Recorded {
  readonly url: string;
  readonly init: FetchInitLike | undefined;
}

const fakeFetch = (
  handler: (url: string, init: FetchInitLike | undefined) => FetchResponseLike,
): { fetch: FetchLike; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch, calls };
};

const jsonOk = (value: unknown): FetchResponseLike => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify(value)),
});

const errorResponse = (status: number, body: string): FetchResponseLike => ({
  ok: false,
  status,
  text: () => Promise.resolve(body),
});

describe("cockpit API client (#67)", () => {
  it("GET /state is token-free and returns the parsed snapshot", async () => {
    const { fetch, calls } = fakeFetch(() => jsonOk({ poll_interval_ms: 1000 }));
    const client = createClient({ token: "secret-token", fetch });

    const snap = await client.getState();

    expect(snap.poll_interval_ms).toBe(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/state");
    expect(calls[0]?.init?.method).toBe("GET");
    // Reads never carry the bearer token (DD-5).
    expect(calls[0]?.init?.headers?.Authorization).toBeUndefined();
  });

  it("mutating calls attach the bearer token", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonOk({ dispatch_paused: true, paused_by: "operator" }),
    );
    const client = createClient({ token: "secret-token", fetch });

    const state = await client.pause();

    expect(state).toEqual({ dispatch_paused: true, paused_by: "operator" });
    expect(calls[0]?.url).toBe("/api/v1/control/pause");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer secret-token");
  });

  it("PUT /settings sends a JSON body with the auth header and content-type", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonOk({
        polling: { interval_ms: 5000 },
        agent: {
          max_concurrent_agents: 4,
          max_concurrent_agents_by_state: {},
          max_turns: 7,
          max_retry_backoff_ms: 300000,
        },
        budget: { max_total_tokens: null },
      }),
    );
    const client = createClient({ token: "t", fetch });

    const result = await client.putSettings({ polling: { interval_ms: 5000 } });

    expect(result.polling.interval_ms).toBe(5000);
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.init?.headers?.["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer t");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ polling: { interval_ms: 5000 } });
  });

  it("encodes the issue id in retry/cancel paths", async () => {
    const { fetch, calls } = fakeFetch(() => jsonOk({ accepted: true, reason: null }));
    const client = createClient({ token: "t", fetch });

    await client.cancel("issue/with space");

    expect(calls[0]?.url).toBe("/api/v1/issues/issue%2Fwith%20space/cancel");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [400, "bad_request"],
    [503, "service_unavailable"],
    [500, "server_error"],
  ] as const)("maps HTTP %i to a typed ApiError code %s", async (status, code) => {
    const { fetch } = fakeFetch(() => errorResponse(status, JSON.stringify({ message: "nope" })));
    const client = createClient({ token: "t", fetch });

    await expect(client.resume()).rejects.toMatchObject({
      name: "ApiError",
      status,
      code,
      message: "nope",
    });
  });

  it("surfaces a network failure as an ApiError(0, network)", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("connection refused"));
    const client = createClient({ token: "t", fetch });

    const err = await client.getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("network");
    expect((err as ApiError).status).toBe(0);
  });

  it("reads the injected token global when no token is supplied", async () => {
    const g = globalThis as { __ORCHESTRA_COCKPIT_TOKEN__?: string };
    g.__ORCHESTRA_COCKPIT_TOKEN__ = "injected-token"; // gitleaks:allow — test fixture, not a secret
    try {
      const { fetch, calls } = fakeFetch(() => jsonOk({ accepted: true, reason: null }));
      const client = createClient({ fetch });
      await client.retry("i1");
      expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer injected-token");
    } finally {
      delete g.__ORCHESTRA_COCKPIT_TOKEN__;
    }
  });
});
