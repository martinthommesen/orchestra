import * as nodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PathOutsideWorkspaceRoot } from "../src/core/errors";
import {
  computeWorkspacePath,
  isPathUnderRoot,
  sanitizeWorkspaceKey,
} from "../src/core/workspace/safety";

const ALLOWED = /^[A-Za-z0-9._-]*$/;

describe("sanitizeWorkspaceKey (SPEC §9.5 Invariant 3)", () => {
  it("replaces disallowed characters with underscore", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("feature/foo bar")).toBe("feature_foo_bar");
    expect(sanitizeWorkspaceKey("a@b#c")).toBe("a_b_c");
  });

  it("property: output contains only allowed characters", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(ALLOWED.test(sanitizeWorkspaceKey(s))).toBe(true);
      }),
    );
  });

  it("property: idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = sanitizeWorkspaceKey(s);
        expect(sanitizeWorkspaceKey(once)).toBe(once);
      }),
    );
  });
});

describe("isPathUnderRoot (SPEC §9.5 Invariant 2)", () => {
  it("accepts a child path", () => {
    expect(isPathUnderRoot("/ws", "/ws/ABC-123")).toBe(true);
    expect(isPathUnderRoot("/ws", "/ws/a/b")).toBe(true);
  });

  it("rejects the root itself and escapes", () => {
    expect(isPathUnderRoot("/ws", "/ws")).toBe(false);
    expect(isPathUnderRoot("/ws", "/ws/../etc")).toBe(false);
    expect(isPathUnderRoot("/ws", "/etc/passwd")).toBe(false);
  });
});

describe("computeWorkspacePath", () => {
  effectIt.effect("places a sanitized key under the root", () =>
    Effect.gen(function* () {
      const ws = yield* computeWorkspacePath("/ws", "feature/x");
      expect(ws.workspace_key).toBe("feature_x");
      expect(ws.path).toBe(nodePath.resolve("/ws/feature_x"));
      expect(ws.created_now).toBe(false);
    }),
  );

  effectIt.effect("fails with PathOutsideWorkspaceRoot when the key escapes", () =>
    Effect.gen(function* () {
      // ".." survives sanitization (allowed chars) but must be rejected by Invariant 2.
      const exit = yield* Effect.exit(computeWorkspacePath("/ws", ".."));
      expect(Exit.isFailure(exit)).toBe(true);
      const error = yield* Effect.flip(computeWorkspacePath("/ws", ".."));
      expect(error).toBeInstanceOf(PathOutsideWorkspaceRoot);
    }),
  );
});
