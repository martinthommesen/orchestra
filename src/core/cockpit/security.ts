/**
 * Sprint 6 / #65 — cockpit security primitives (DD-5), kept as **pure** functions so the
 * auth/Origin policy is unit-testable without a server. The cockpit binds loopback-only;
 * read endpoints are token-free; every mutating endpoint requires both a bearer token AND
 * a loopback `Origin`/`Host` (the CSRF posture: a cross-origin tab can neither read the
 * same-origin-injected token nor set a custom `Authorization` header on a simple request).
 */

/** Extract the bearer token from an `Authorization` header value, or null if absent/malformed. */
export const parseBearer = (authorization: string | undefined): string | null => {
  if (authorization === undefined) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match === null) {
    return null;
  }
  const token = (match[1] ?? "").trim();
  return token.length === 0 ? null : token;
};

/**
 * Length-checked, branch-stable token comparison. The token is a per-process secret, but a
 * length leak is immaterial for a loopback operator tool; we still avoid an early-return
 * per-char compare.
 */
export const tokenMatches = (presented: string | null, expected: string): boolean => {
  if (presented === null || presented.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The host portion of an `Origin`/`Host` value is loopback (port-agnostic). */
const hostIsLoopback = (hostport: string): boolean => {
  // Strip a scheme (Origin) then a trailing :port. IPv6 literals keep their brackets.
  const noScheme = hostport.replace(/^[a-z]+:\/\//i, "");
  const host = noScheme.startsWith("[")
    ? noScheme.slice(0, noScheme.indexOf("]") + 1)
    : (noScheme.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host);
};

/**
 * An `Origin` is acceptable when it is absent (non-browser clients like `curl`, or a
 * same-origin GET that omits it) or points at a loopback host. A cross-origin browser tab
 * sends its own (non-loopback) Origin and is rejected; an opaque `"null"` origin is rejected.
 */
export const originIsLoopback = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  return hostIsLoopback(origin);
};

/**
 * The `Host` header must be loopback when present — defends against DNS-rebinding, where a
 * malicious page resolves an attacker domain to 127.0.0.1 and talks to the daemon.
 */
export const hostIsLoopbackHeader = (host: string | undefined): boolean =>
  host === undefined ? true : hostIsLoopback(host);
