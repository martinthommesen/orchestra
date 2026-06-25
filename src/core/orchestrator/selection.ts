import { type BlockerRef, type Issue, normalizeLabel, normalizeState } from "../domain/issue";

/**
 * Candidate selection + stable sort (SPEC §8.2). Pure functions — no Effect, no IO —
 * so they are exhaustively property-testable in isolation. The orchestrator's tick
 * filters fetched issues with {@link isEligible}, orders them with {@link compareIssues},
 * and then applies concurrency caps (see `concurrency.ts`).
 */

/** Everything the eligibility predicate needs, all normalized up-front by the caller. */
export interface SelectionContext {
  /** Normalized (lowercased) active state names (SPEC §5.3.1). */
  readonly activeStates: ReadonlySet<string>;
  /** Normalized terminal state names. */
  readonly terminalStates: ReadonlySet<string>;
  /** Normalized required labels — an issue must carry every one to be eligible. */
  readonly requiredLabels: ReadonlySet<string>;
  /** Issue IDs already running or scheduled for retry (the claim set). */
  readonly claimed: ReadonlySet<string>;
}

/** Build a {@link SelectionContext} from raw config arrays (handles normalization). */
export const selectionContext = (input: {
  readonly activeStates: ReadonlyArray<string>;
  readonly terminalStates: ReadonlyArray<string>;
  readonly requiredLabels: ReadonlyArray<string>;
  readonly claimed: ReadonlyArray<string>;
}): SelectionContext => ({
  activeStates: new Set(input.activeStates.map(normalizeState)),
  terminalStates: new Set(input.terminalStates.map(normalizeState)),
  requiredLabels: new Set(input.requiredLabels.map(normalizeLabel)),
  claimed: new Set(input.claimed),
});

/**
 * A blocker is "resolved" only when its state is known and terminal. An unknown
 * (null) blocker state is treated as *unresolved* (conservative: do not start work
 * we might have to throw away) — see the Todo-blocker rule in {@link isEligible}.
 */
export const isBlockerResolved = (
  blocker: BlockerRef,
  terminalStates: ReadonlySet<string>,
): boolean => blocker.state !== null && terminalStates.has(normalizeState(blocker.state));

/**
 * Is `issue` eligible for dispatch right now (SPEC §8.2)? Checks: active (non-terminal)
 * state, all required labels present, not already claimed, and the Todo-blocker rule
 * (an issue in `Todo` with any unresolved blocker is held back; once it is `In Progress`
 * it has already started, so blockers no longer gate it).
 */
export const isEligible = (issue: Issue, ctx: SelectionContext): boolean => {
  const state = normalizeState(issue.state);
  if (ctx.terminalStates.has(state)) {
    return false;
  }
  if (!ctx.activeStates.has(state)) {
    return false;
  }
  if (ctx.claimed.has(issue.id)) {
    return false;
  }
  const labels = new Set(issue.labels);
  for (const label of ctx.requiredLabels) {
    if (!labels.has(label)) {
      return false;
    }
  }
  if (state === "todo") {
    const blocked = issue.blocked_by.some((b) => !isBlockerResolved(b, ctx.terminalStates));
    if (blocked) {
      return false;
    }
  }
  return true;
};

/**
 * Total order over issues for dispatch (SPEC §8.2): priority ascending (lower number
 * = higher priority; `null` sorts last), then oldest `created_at` first (`null` last),
 * then `identifier` ascending as a deterministic tiebreak. Because the tiebreak is
 * total, the resulting order is stable and engine-independent.
 */
export const compareIssues = (a: Issue, b: Issue): number => {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) {
    return pa - pb;
  }
  const ca = a.created_at ? a.created_at.getTime() : Number.POSITIVE_INFINITY;
  const cb = b.created_at ? b.created_at.getTime() : Number.POSITIVE_INFINITY;
  if (ca !== cb) {
    return ca - cb;
  }
  if (a.identifier < b.identifier) {
    return -1;
  }
  if (a.identifier > b.identifier) {
    return 1;
  }
  return 0;
};

/** Filter to eligible issues and return them in dispatch order ({@link compareIssues}). */
export const selectCandidates = (
  issues: ReadonlyArray<Issue>,
  ctx: SelectionContext,
): ReadonlyArray<Issue> => issues.filter((issue) => isEligible(issue, ctx)).toSorted(compareIssues);
