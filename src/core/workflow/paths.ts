import * as nodePath from "node:path";
import { type EnvLike, resolveDollarVar } from "./var";

/**
 * Path value coercion for `workspace.root` (SPEC §5.3.3 / §6.1): `$VAR` indirection,
 * `~` home expansion, relative-to-WORKFLOW.md resolution, and absolute
 * normalization. Pure (host facts injected) so it unit-tests deterministically.
 */
export interface PathContext {
  readonly env: EnvLike;
  /** `os.homedir()` — for `~` expansion. */
  readonly homeDir: string;
  /** `os.tmpdir()` — base for the default workspace root. */
  readonly tmpDir: string;
  /** Directory containing the selected `WORKFLOW.md` — base for relative paths. */
  readonly workflowDir: string;
}

const expandHome = (value: string, homeDir: string): string => {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return nodePath.join(homeDir, value.slice(2));
  }
  return value;
};

/**
 * Resolve the effective absolute `workspace.root`. `undefined`/missing `$VAR`
 * falls back to `<system-temp>/orchestra_workspaces` (Orchestra's rename of the
 * spec's `symphony_workspaces`).
 */
export const resolveWorkspaceRoot = (raw: string | undefined, ctx: PathContext): string => {
  let value = raw;

  if (value !== undefined) {
    const resolution = resolveDollarVar(value, ctx.env);
    value = resolution._tag === "Missing" ? undefined : resolution.value;
  }

  if (value === undefined || value === "") {
    value = nodePath.join(ctx.tmpDir, "orchestra_workspaces");
  }

  value = expandHome(value, ctx.homeDir);

  return nodePath.isAbsolute(value)
    ? nodePath.normalize(value)
    : nodePath.resolve(ctx.workflowDir, value);
};
