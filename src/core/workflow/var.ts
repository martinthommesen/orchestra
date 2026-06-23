/**
 * `$VAR` indirection (SPEC §6.1). A config value may be a literal or a single
 * `$VAR_NAME` reference resolved from the environment. Environment variables never
 * globally override YAML — they apply only where a value explicitly references one.
 *
 * Security: callers MUST NOT log the resolved value (it may be a secret token).
 */

/** A value is `$VAR` only if it is *exactly* a single shell-style identifier ref. */
const VAR_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type VarResolution =
  /** The raw value was a literal (not a `$VAR` reference). */
  | { readonly _tag: "Literal"; readonly value: string }
  /** A `$VAR` reference that resolved to a non-empty value. */
  | { readonly _tag: "Resolved"; readonly value: string }
  /** A `$VAR` reference that was unset or empty — treated as missing (SPEC §5.3.1). */
  | { readonly _tag: "Missing"; readonly varName: string };

/** Resolve a single config value's `$VAR` indirection against `env`. */
export const resolveDollarVar = (raw: string, env: EnvLike): VarResolution => {
  const match = VAR_PATTERN.exec(raw);
  if (match === null) {
    return { _tag: "Literal", value: raw };
  }
  const varName = match[1] as string;
  const resolved = env[varName];
  if (resolved === undefined || resolved === "") {
    return { _tag: "Missing", varName };
  }
  return { _tag: "Resolved", value: resolved };
};

/**
 * Resolve a value that is optional in config: `undefined` stays `undefined`, a
 * `$VAR` that is missing collapses to `undefined`, everything else yields its
 * string. Used for `tracker.api_key` (presence enforced later at dispatch).
 */
export const resolveOptionalValue = (raw: string | undefined, env: EnvLike): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const resolution = resolveDollarVar(raw, env);
  return resolution._tag === "Missing" ? undefined : resolution.value;
};
