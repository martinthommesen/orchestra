import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  hostIsLoopbackHeader,
  originIsLoopback,
  parseBearer,
  tokenMatches,
} from "../src/core/cockpit/security";
import { resolveAssetPath } from "../src/core/cockpit/static";
import {
  injectToken,
  resolveToken,
  TOKEN_ENV_VAR,
  tokenBootstrapScript,
} from "../src/core/cockpit/token";

/**
 * Sprint 6 / #65 — pure security/token unit tests (DD-5/DD-8). The auth + Origin policy and
 * the token resolution/injection are pure functions so they can be pinned without a server.
 * These are the secret-safety guards: a wrong/absent token is rejected, a cross-origin tab
 * is rejected, path traversal is blocked, and the injected token is HTML/JS-safe.
 */

describe("parseBearer", () => {
  it.effect("extracts a bearer token (case-insensitive scheme)", () =>
    Effect.sync(() => {
      expect(parseBearer("Bearer abc123")).toBe("abc123");
      expect(parseBearer("bearer abc123")).toBe("abc123");
      expect(parseBearer("  Bearer   abc123  ")).toBe("abc123");
    }),
  );

  it.effect("returns null for absent/malformed/empty headers", () =>
    Effect.sync(() => {
      expect(parseBearer(undefined)).toBeNull();
      expect(parseBearer("")).toBeNull();
      expect(parseBearer("Basic abc123")).toBeNull();
      expect(parseBearer("Bearer ")).toBeNull();
      expect(parseBearer("abc123")).toBeNull();
    }),
  );
});

describe("tokenMatches", () => {
  it.effect("matches only the exact token", () =>
    Effect.sync(() => {
      expect(tokenMatches("secret", "secret")).toBe(true);
      expect(tokenMatches("secre", "secret")).toBe(false);
      expect(tokenMatches("secrets", "secret")).toBe(false);
      expect(tokenMatches("Secret", "secret")).toBe(false);
      expect(tokenMatches(null, "secret")).toBe(false);
    }),
  );
});

describe("originIsLoopback", () => {
  it.effect("accepts absent or loopback origins", () =>
    Effect.sync(() => {
      expect(originIsLoopback(undefined)).toBe(true);
      expect(originIsLoopback("http://127.0.0.1:7777")).toBe(true);
      expect(originIsLoopback("http://localhost:3000")).toBe(true);
      expect(originIsLoopback("http://[::1]:8080")).toBe(true);
    }),
  );

  it.effect("rejects cross-origin and opaque origins", () =>
    Effect.sync(() => {
      expect(originIsLoopback("http://evil.example.com")).toBe(false);
      expect(originIsLoopback("https://127.0.0.1.evil.com")).toBe(false);
      expect(originIsLoopback("null")).toBe(false);
    }),
  );
});

describe("hostIsLoopbackHeader", () => {
  it.effect("requires loopback when present; tolerant when absent", () =>
    Effect.sync(() => {
      expect(hostIsLoopbackHeader(undefined)).toBe(true);
      expect(hostIsLoopbackHeader("127.0.0.1:7777")).toBe(true);
      expect(hostIsLoopbackHeader("localhost:7777")).toBe(true);
      expect(hostIsLoopbackHeader("evil.example.com")).toBe(false);
    }),
  );
});

describe("resolveToken", () => {
  it.effect("uses a non-empty env token verbatim", () =>
    Effect.sync(() => {
      const resolved = resolveToken({ [TOKEN_ENV_VAR]: "  pinned-token  " });
      expect(resolved).toEqual({ token: "pinned-token", generated: false });
    }),
  );

  it.effect("generates a 256-bit hex token when env is absent/blank", () =>
    Effect.sync(() => {
      const a = resolveToken({});
      const b = resolveToken({ [TOKEN_ENV_VAR]: "   " });
      expect(a.generated).toBe(true);
      expect(a.token).toMatch(/^[0-9a-f]{64}$/);
      expect(b.generated).toBe(true);
      // Two generations must differ (CSPRNG, not a constant).
      expect(a.token).not.toBe(b.token);
    }),
  );
});

describe("injectToken", () => {
  it.effect("inserts the bootstrap before </head> when present", () =>
    Effect.sync(() => {
      const html = "<html><head><title>x</title></head><body></body></html>";
      const out = injectToken(html, "tok");
      expect(out).toContain(tokenBootstrapScript("tok"));
      expect(out.indexOf("tok")).toBeLessThan(out.indexOf("</head>"));
    }),
  );

  it.effect("prepends when there is no </head>", () =>
    Effect.sync(() => {
      const out = injectToken("<body>x</body>", "tok");
      expect(out.startsWith(tokenBootstrapScript("tok"))).toBe(true);
    }),
  );

  it.effect("JSON-encodes the token so it cannot break out of the script", () =>
    Effect.sync(() => {
      const out = tokenBootstrapScript('a"</script>');
      // The dangerous sequence is escaped by JSON.stringify, never emitted raw.
      expect(out).not.toContain('a"</script>"');
      expect(out).toContain(JSON.stringify('a"</script>'));
    }),
  );
});

describe("resolveAssetPath", () => {
  it.effect("resolves in-root paths and blocks traversal", () =>
    Effect.sync(() => {
      const root = "/srv/cockpit";
      expect(resolveAssetPath(root, "/assets/app.js")).toBe("/srv/cockpit/assets/app.js");
      expect(resolveAssetPath(root, "/")).toBe("/srv/cockpit");
      expect(resolveAssetPath(root, "/../etc/passwd")).toBeNull();
      expect(resolveAssetPath(root, "/../../etc/passwd")).toBeNull();
    }),
  );
});
