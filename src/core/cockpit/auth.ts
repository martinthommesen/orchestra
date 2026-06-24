import { Headers, HttpApiError, HttpServerRequest } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { CockpitAuth } from "./api";
import { hostIsLoopbackHeader, originIsLoopback, parseBearer, tokenMatches } from "./security";
import { CockpitToken } from "./token";

/**
 * Sprint 6 / #65 — implementation of the {@link CockpitAuth} middleware (DD-5). Runs before
 * every **control** (mutating) endpoint and fails closed:
 *   - **401 Unauthorized** when the `Authorization: Bearer <token>` is missing/blank/wrong;
 *   - **403 Forbidden** when the `Origin`/`Host` is not loopback (cross-origin / rebinding).
 *
 * It reads the per-process {@link CockpitToken} (resolved once at startup) and the live
 * {@link HttpServerRequest} headers. The policy itself is the pure, unit-tested
 * {@link file://./security.ts security} helpers; this is just the Effect wiring.
 */
export const CockpitAuthLive: Layer.Layer<CockpitAuth, never, CockpitToken> = Layer.effect(
  CockpitAuth,
  Effect.gen(function* () {
    const { token } = yield* CockpitToken;
    const header = (headers: Headers.Headers, name: string): string | undefined =>
      Option.getOrUndefined(Headers.get(headers, name));
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const presented = parseBearer(header(request.headers, "authorization"));
      if (!tokenMatches(presented, token)) {
        return yield* new HttpApiError.Unauthorized();
      }
      const origin = header(request.headers, "origin");
      const host = header(request.headers, "host");
      if (!originIsLoopback(origin) || !hostIsLoopbackHeader(host)) {
        return yield* new HttpApiError.Forbidden();
      }
    });
  }),
);
