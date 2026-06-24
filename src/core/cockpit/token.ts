import { randomBytes } from "node:crypto";
import { Context, Effect, Layer } from "effect";

/**
 * Sprint 6 / #65 — the cockpit's **per-process session token** (DD-5). Read from
 * `ORCHESTRA_COCKPIT_TOKEN` when set, else generated with a CSPRNG at startup and logged
 * once so an operator can use it. It gates every mutating endpoint and is injected into the
 * served `index.html` (same-origin) so the SPA can read it without a network round-trip.
 *
 * It is a capability secret for *this process only* — never persisted, never sent to the
 * tracker, regenerated every boot when not pinned via the env var.
 */
export class CockpitToken extends Context.Tag("orchestra/CockpitToken")<
  CockpitToken,
  { readonly token: string }
>() {}

/** The env var an operator can set to pin a stable cockpit token across restarts. */
export const TOKEN_ENV_VAR = "ORCHESTRA_COCKPIT_TOKEN"; // gitleaks:allow — env var name, not a secret

/**
 * Resolve the cockpit token: a non-empty `ORCHESTRA_COCKPIT_TOKEN` wins; otherwise mint a
 * fresh 256-bit hex token. Returns the token plus whether it was generated (so the caller
 * can decide what to log — we log the value only when generated, never the env-pinned one).
 */
export const resolveToken = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly token: string; readonly generated: boolean } => {
  const fromEnv = env[TOKEN_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { token: fromEnv.trim(), generated: false };
  }
  return { token: randomBytes(32).toString("hex"), generated: true };
};

/** Build a {@link CockpitToken} layer from an already-resolved token value. */
export const cockpitTokenLayer = (token: string): Layer.Layer<CockpitToken> =>
  Layer.succeed(CockpitToken, { token });

/**
 * The global the SPA bootstraps from. Injected into the served `index.html` so the
 * same-origin page can read the token without a fetch (a cross-origin tab cannot, by the
 * same-origin policy — that is the CSRF defense).
 */
export const TOKEN_GLOBAL = "__ORCHESTRA_COCKPIT_TOKEN__"; // gitleaks:allow — JS global name, not a secret

/** The `<script>` bootstrap injected just before `</head>` (token JSON-encoded → XSS-safe). */
export const tokenBootstrapScript = (token: string): string =>
  `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)};</script>`;

/**
 * Inject the token bootstrap into an `index.html`. Inserts before `</head>` when present,
 * else prepends — so a minimal SPA index still receives the global. Pure + testable.
 */
export const injectToken = (html: string, token: string): string => {
  const script = tokenBootstrapScript(token);
  const headClose = html.toLowerCase().indexOf("</head>");
  if (headClose === -1) {
    return `${script}${html}`;
  }
  return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
};

/** Log the token once at startup (value only when freshly generated). */
export const logToken = (resolved: {
  readonly token: string;
  readonly generated: boolean;
}): Effect.Effect<void> =>
  resolved.generated
    ? Effect.logInfo("cockpit auth token generated (set ORCHESTRA_COCKPIT_TOKEN to pin)").pipe(
        Effect.annotateLogs({ event: "cockpit_token", source: "generated", token: resolved.token }),
      )
    : Effect.logInfo("cockpit auth token loaded from ORCHESTRA_COCKPIT_TOKEN").pipe(
        Effect.annotateLogs({ event: "cockpit_token", source: "env" }),
      );
