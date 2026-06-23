import { Effect, Layer, Ref } from "effect";
import type { Issue, IssueStateRef } from "../../src/core/domain/issue";
import type { TrackerError } from "../../src/core/errors";
import { IssueTracker } from "../../src/core/ports/issue-tracker";

/**
 * `FakeTracker` (Task 10) — a scriptable, in-memory {@link IssueTracker}. Tests seed the
 * candidate list, the per-id state refresh table (for reconciliation), and the
 * terminal-state list (for startup cleanup), then mutate any of them mid-run via the
 * returned control. Each fetch can also be forced to fail with a real {@link TrackerError}
 * to exercise the loop's degraded-mode paths (skip-dispatch, keep-workers-on-refresh-fail).
 */
interface TrackerState {
  readonly candidates: ReadonlyArray<Issue>;
  readonly states: ReadonlyArray<IssueStateRef>;
  readonly byStates: ReadonlyArray<Issue>;
  readonly failCandidates: TrackerError | null;
  readonly failStates: TrackerError | null;
  readonly failByStates: TrackerError | null;
}

export interface FakeTrackerControl {
  readonly setCandidates: (issues: ReadonlyArray<Issue>) => Effect.Effect<void>;
  readonly setStates: (refs: ReadonlyArray<IssueStateRef>) => Effect.Effect<void>;
  /** Upsert a single id's refreshed state (used to drive reconciliation transitions). */
  readonly setStateOf: (id: string, state: string) => Effect.Effect<void>;
  readonly setByStates: (issues: ReadonlyArray<Issue>) => Effect.Effect<void>;
  readonly failNextCandidates: (err: TrackerError | null) => Effect.Effect<void>;
  readonly failStatesRefresh: (err: TrackerError | null) => Effect.Effect<void>;
}

export interface FakeTracker {
  readonly layer: Layer.Layer<IssueTracker>;
  readonly control: FakeTrackerControl;
}

export const makeFakeTracker = (initial?: Partial<TrackerState>): Effect.Effect<FakeTracker> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<TrackerState>({
      candidates: initial?.candidates ?? [],
      states: initial?.states ?? [],
      byStates: initial?.byStates ?? [],
      failCandidates: initial?.failCandidates ?? null,
      failStates: initial?.failStates ?? null,
      failByStates: initial?.failByStates ?? null,
    });

    const layer = Layer.succeed(IssueTracker, {
      fetchCandidateIssues: () =>
        Ref.get(ref).pipe(
          Effect.flatMap((st) =>
            st.failCandidates ? Effect.fail(st.failCandidates) : Effect.succeed(st.candidates),
          ),
        ),
      fetchIssuesByStates: () =>
        Ref.get(ref).pipe(
          Effect.flatMap((st) =>
            st.failByStates ? Effect.fail(st.failByStates) : Effect.succeed(st.byStates),
          ),
        ),
      fetchIssueStatesByIds: (ids) =>
        Ref.get(ref).pipe(
          Effect.flatMap((st) =>
            st.failStates
              ? Effect.fail(st.failStates)
              : Effect.succeed(st.states.filter((r) => ids.includes(r.id))),
          ),
        ),
    });

    const control: FakeTrackerControl = {
      setCandidates: (issues) => Ref.update(ref, (st) => ({ ...st, candidates: issues })),
      setStates: (refs) => Ref.update(ref, (st) => ({ ...st, states: refs })),
      setStateOf: (id, state) =>
        Ref.update(ref, (st) => ({
          ...st,
          states: st.states.some((r) => r.id === id)
            ? st.states.map((r) => (r.id === id ? { ...r, state } : r))
            : [...st.states, { id, identifier: id, state, labels: [] as ReadonlyArray<string> }],
        })),
      setByStates: (issues) => Ref.update(ref, (st) => ({ ...st, byStates: issues })),
      failNextCandidates: (err) => Ref.update(ref, (st) => ({ ...st, failCandidates: err })),
      failStatesRefresh: (err) => Ref.update(ref, (st) => ({ ...st, failStates: err })),
    };

    return { layer, control };
  });
