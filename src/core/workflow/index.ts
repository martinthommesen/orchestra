/**
 * `WORKFLOW.md` configuration layer (SPEC §5–§6): file loading, front-matter
 * decoding with defaults, `$VAR` indirection, path coercion, and strict Liquid
 * prompt rendering. The front-matter *schema* itself lives in `core/domain/workflow`.
 */
export * from "./loader";
export * from "./paths";
export * from "./render";
export * from "./var";
