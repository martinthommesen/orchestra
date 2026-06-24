import { describe, expect, it } from "vitest";
import { resolveAssetPath } from "../src/core/cockpit/static";

/**
 * Sprint 6 / PR #74 review — unit coverage for the static asset path resolver. The headline
 * case is the malformed percent-escape: `decodeURIComponent` would throw a `URIError`, which
 * (unguarded) defects the request fiber into a 500 — a trivial DoS. The resolver must instead
 * treat it as "no such asset" (→ null) so the handler answers via the SPA fallback.
 */
describe("resolveAssetPath", () => {
  const root = "/srv/cockpit";

  it("resolves a normal asset under the root", () => {
    expect(resolveAssetPath(root, "/assets/app.js")).toBe("/srv/cockpit/assets/app.js");
  });

  it("strips query and hash before resolving", () => {
    expect(resolveAssetPath(root, "/assets/app.js?v=1#x")).toBe("/srv/cockpit/assets/app.js");
  });

  it("returns null on a traversal attempt", () => {
    expect(resolveAssetPath(root, "/../../etc/passwd")).toBeNull();
  });

  it("returns null (no throw) on a malformed percent-escape", () => {
    expect(() => resolveAssetPath(root, "/%")).not.toThrow();
    expect(resolveAssetPath(root, "/%")).toBeNull();
    expect(resolveAssetPath(root, "/%zz")).toBeNull();
    expect(resolveAssetPath(root, "/assets/%E0%A4%A")).toBeNull();
  });
});
