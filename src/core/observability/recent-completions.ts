import { Context, type Effect, Layer } from "effect";
import { makeBoundedRing } from "./bounded-ring";

/**
 * Sprint 3 / #37 — **rich completion history**. The authoritative `completed` list in
 * `OrchestratorState` is IDs-only (bookkeeping that must NOT gate dispatch, SPEC §4.1.8),
 * so this sibling ring captures the *rich* completion data the dashboard wants — wall-clock
 * `finished_at` + an `outcome` — without touching that list or the store mutators. It is
 * fed by the loop at its two `markCompleted` sites and read by the snapshot server.
 *
 * Bounded to {@link RECENT_COMPLETIONS_CAP} (oldest dropped), newest-LAST, and `record`
 * never fails (it runs inline on the loop fiber).
 */

/** Max completions retained (oldest dropped past this). */
const RECENT_COMPLETIONS_CAP = 50;

/** A finished issue with rich context (the snapshot's `recent_completed[]` shape). */
export interface RecentCompletion {
  readonly issue_id: string;
  readonly identifier: string;
  /** Wall-clock ISO instant the issue finished. */
  readonly finished_at: string;
  /** How it finished — e.g. `completed` (max turns) or `killed` (went terminal). */
  readonly outcome: string;
}

/** What the loop passes in (the `finished_at` timestamp is stamped inside the service). */
export interface CompletionInput {
  readonly issue_id: string;
  readonly identifier: string;
  readonly outcome: string;
}

/** Rich-completion ring service. `record` is non-failing and cheap; `list` is a safe read. */
export class RecentCompletions extends Context.Tag("orchestra/RecentCompletions")<
  RecentCompletions,
  {
    readonly record: (input: CompletionInput) => Effect.Effect<void>;
    /** Bounded ring, oldest-first / newest-last (the snapshot `recent_completed[]` order). */
    readonly list: Effect.Effect<ReadonlyArray<RecentCompletion>>;
  }
>() {}

/** Build a recent-completions ring bounded to `cap`. */
const makeRecentCompletions = (
  cap: number = RECENT_COMPLETIONS_CAP,
): Effect.Effect<Context.Tag.Service<RecentCompletions>> =>
  makeBoundedRing<RecentCompletion, CompletionInput>(cap, (input, _seq, ms) => ({
    issue_id: input.issue_id,
    identifier: input.identifier,
    finished_at: new Date(ms).toISOString(),
    outcome: input.outcome,
  }));

/** Layer providing an empty {@link RecentCompletions} ring at the default cap. */
export const RecentCompletionsLive: Layer.Layer<RecentCompletions> = Layer.effect(
  RecentCompletions,
  makeRecentCompletions(),
);
