import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
} from "@effect/platform";
import { Schema } from "effect";

/**
 * Sprint 6 / #65 — the **one** typed cockpit API (DD-1). The hand-rolled snapshot router is
 * replaced by this single `@effect/platform` `HttpApi`: one server, one API, derived types.
 * It is split into two groups by auth posture (DD-5):
 *
 *   - **read** — `GET /api/v1/state` (+ `GET /api/v1/settings` in #66): token-free, loopback;
 *   - **control** — the mutating endpoints: bearer token + loopback `Origin`/`Host` required.
 *
 * The read snapshot keeps its path and its **byte-compatible** wire shape — its handler
 * returns a raw `HttpServerResponse.json(toSnapshot(...))`, so the bytes a Sprint-5 reader
 * sees do not regress (a round-trip test pins it). Mutating endpoints carry typed wire
 * results mapped from the loop's `CommandResult`.
 */

/** The dispatch-gate state returned by pause/resume (DD-3). */
export const ControlStateWire = Schema.Struct({
  dispatch_paused: Schema.Boolean,
  paused_by: Schema.NullOr(Schema.Literal("operator", "budget")),
}).annotations({ identifier: "ControlState" });
export type ControlStateWire = typeof ControlStateWire.Type;

/** The accept/no-op result returned by retry-now / cancel. */
export const AckWire = Schema.Struct({
  accepted: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Ack" });
export type AckWire = typeof AckWire.Type;

/** Path schema for the per-issue mutating endpoints (`:id`). */
export const IssueIdParam = Schema.Struct({ id: Schema.String });

/**
 * Auth/Origin middleware applied to the **control** group only (DD-5). It fails closed with
 * a 401 (missing/blank/wrong token) or 403 (cross-origin / non-loopback). The read group
 * carries no middleware, so `GET` stays token-free.
 */
export class CockpitAuth extends HttpApiMiddleware.Tag<CockpitAuth>()("orchestra/CockpitAuth", {
  failure: Schema.Union(HttpApiError.Unauthorized, HttpApiError.Forbidden),
}) {}

/** Read group — token-free loopback reads. */
export class ReadGroup extends HttpApiGroup.make("read").add(
  // Byte-compatible snapshot: the handler returns a raw HttpServerResponse, so `Unknown`
  // here just declares a 200 body without re-encoding the projection through a schema.
  HttpApiEndpoint.get("state", "/api/v1/state").addSuccess(Schema.Unknown),
) {}

/** Control group — every endpoint requires the bearer token + loopback Origin (DD-5). */
export class ControlGroup extends HttpApiGroup.make("control")
  .add(
    HttpApiEndpoint.post("pause", "/api/v1/control/pause")
      .addSuccess(ControlStateWire)
      .addError(HttpApiError.ServiceUnavailable),
  )
  .add(
    HttpApiEndpoint.post("resume", "/api/v1/control/resume")
      .addSuccess(ControlStateWire)
      .addError(HttpApiError.ServiceUnavailable),
  )
  .add(
    HttpApiEndpoint.post("retry", "/api/v1/issues/:id/retry")
      .setPath(IssueIdParam)
      .addSuccess(AckWire)
      .addError(HttpApiError.ServiceUnavailable),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/api/v1/issues/:id/cancel")
      .setPath(IssueIdParam)
      .addSuccess(AckWire)
      .addError(HttpApiError.ServiceUnavailable),
  )
  .middleware(CockpitAuth) {}

/** The full cockpit API surface. */
export class CockpitApi extends HttpApi.make("CockpitApi").add(ReadGroup).add(ControlGroup) {}
