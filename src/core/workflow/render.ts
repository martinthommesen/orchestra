import { Effect } from "effect";
import { Liquid, ParseError } from "liquidjs";
import type { Issue } from "../domain/issue";
import { TemplateParseError, TemplateRenderError } from "../errors";
import { errorMessage } from "../util/error";

/**
 * Strict Liquid prompt rendering (SPEC §5.4): unknown variables and unknown
 * filters MUST fail. Uses liquidjs' synchronous API wrapped in `Effect.try` — no
 * Promise escape hatch in the core.
 *
 * Error mapping to SPEC §5.5: genuine syntax/tokenization issues →
 * {@link TemplateParseError}; unknown variable/filter (and other render faults) →
 * {@link TemplateRenderError}. (liquidjs reports unknown *filters* at parse time,
 * so we reclassify those to render errors to match the spec's grouping.)
 */
const engine = new Liquid({ strictVariables: true, strictFilters: true });

export interface PromptScope {
  readonly issue: Issue;
  /** `null`/absent on first attempt; integer on retry/continuation (SPEC §5.4). */
  readonly attempt: number | null;
}

const isUndefinedFilter = (e: unknown): boolean =>
  e instanceof ParseError && /undefined filter/i.test(errorMessage(e));

/** Render the prompt template against `{ issue, attempt }` with strict semantics. */
export const renderPrompt = (
  template: string,
  scope: PromptScope,
): Effect.Effect<string, TemplateParseError | TemplateRenderError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => engine.parse(template),
      catch: (e): TemplateParseError | TemplateRenderError =>
        isUndefinedFilter(e)
          ? new TemplateRenderError({ message: errorMessage(e), cause: e })
          : new TemplateParseError({ message: errorMessage(e), cause: e }),
    });

    const rendered = yield* Effect.try({
      try: () => engine.renderSync(parsed, { issue: scope.issue, attempt: scope.attempt }),
      catch: (e) => new TemplateRenderError({ message: errorMessage(e), cause: e }),
    });

    return typeof rendered === "string" ? rendered : String(rendered);
  });
