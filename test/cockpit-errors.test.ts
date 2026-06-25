import { describe, expect, it } from "vitest";
import { ApiError } from "../src/cockpit/api/client";
import { describeError } from "../src/cockpit/api/errors";

/**
 * Sprint 6 — the single error-humanizer for the cockpit. Proves each typed `ApiError.code` becomes
 * an actionable operator sentence (and that the server's own detail is appended only when it adds
 * information), while plain/unknown throws fall through to their raw message.
 */
describe("describeError", () => {
  it("maps a 401 to operator-token guidance and keeps the server detail", () => {
    const msg = describeError(new ApiError(401, "unauthorized", "missing token"));
    expect(msg).toContain("Not authorized");
    expect(msg).toContain("missing token");
  });

  it("maps a 503 to a busy/timeout retry hint", () => {
    expect(describeError(new ApiError(503, "service_unavailable", "owner busy"))).toContain(
      "busy or the command timed out",
    );
  });

  it("maps a network failure to a daemon-reachability hint", () => {
    expect(describeError(new ApiError(0, "network", "network error"))).toContain(
      "Can't reach the daemon",
    );
  });

  it("omits the appended detail when the server message merely repeats the guidance", () => {
    const msg = describeError(new ApiError(503, "service_unavailable", ""));
    expect(msg).toBe("The daemon is busy or the command timed out — try again.");
    expect(msg).not.toContain("(");
  });

  it("surfaces a plain Error's message verbatim (e.g. a thrown non-API failure)", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies any other thrown value", () => {
    expect(describeError("weird")).toBe("weird");
  });
});
