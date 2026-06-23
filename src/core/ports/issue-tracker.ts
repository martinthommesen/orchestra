import { Context, type Effect } from "effect";
import type { Issue, IssueStateRef } from "../domain/issue";
import type { TrackerError } from "../errors";

/**
 * Issue-tracker port (SPEC §11.1). Read-only: Orchestra is a scheduler/runner and
 * tracker *reader* — writes are the agent's job via its tools (SPEC §11.5). The
 * GitHub adapter (Sprint 1) provides the live implementation; tests provide a fake.
 *
 * Signatures only — no implementation in Sprint 0.
 */
export class IssueTracker extends Context.Tag("orchestra/IssueTracker")<
  IssueTracker,
  {
    /** Issues in configured active states for the configured project (paginated). */
    readonly fetchCandidateIssues: () => Effect.Effect<ReadonlyArray<Issue>, TrackerError>;
    /** Issues in the given states — used for startup terminal cleanup. */
    readonly fetchIssuesByStates: (
      stateNames: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Issue>, TrackerError>;
    /** Current state/labels for the given issue IDs — used for active-run reconciliation. */
    readonly fetchIssueStatesByIds: (
      issueIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<IssueStateRef>, TrackerError>;
  }
>() {}
