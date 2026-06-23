import { Duration, Effect, Layer, Ref, Stream } from "effect";
import type { AgentEvent } from "../../src/core/domain/agent-event";
import type { AgentError } from "../../src/core/errors";
import { AgentRunner, type AgentRunParams } from "../../src/core/ports/agent-runner";

/**
 * `FakeAgentRunner` (Task 10) — a scriptable {@link AgentRunner} that turns a list of
 * {@link ScriptStep}s into the normalized {@link AgentEvent} stream the orchestrator
 * consumes, with no subprocess and no network. Each `run()` invocation pops the next
 * queued script for that issue (so continuation/retry turns can be scripted
 * independently); when the queue is empty it cleanly completes. Every invocation is
 * recorded so tests can assert on `attempt`, the rendered `prompt`, and continuation
 * `resume`. `delay`/`stall` steps use `Effect.sleep`/`Effect.never`, both fully under
 * `TestClock` control — that is what lets the stall scenario be deterministic.
 */
export type ControlStep =
  | { readonly _tag: "delay"; readonly ms: number }
  | { readonly _tag: "complete" }
  | { readonly _tag: "fail"; readonly error: AgentError }
  | { readonly _tag: "stall" };

/**
 * A script step is either a bare {@link AgentEvent} (emitted as-is) or a control step.
 * The two never collide: control `_tag`s are lowercase verbs, event `_tag`s are the
 * PascalCase SPEC variants, so a single `switch` discriminates them.
 */
export type ScriptStep = AgentEvent | ControlStep;

export type RunScript = ReadonlyArray<ScriptStep>;

export interface RunRecord {
  readonly issueId: string;
  readonly attempt: number | null;
  readonly prompt: string;
  readonly resumeSessionId: string | null;
}

const isTerminal = (s: ScriptStep): boolean =>
  s._tag === "complete" || s._tag === "fail" || s._tag === "stall";

const stepStream = (step: ScriptStep): Stream.Stream<AgentEvent, AgentError> => {
  switch (step._tag) {
    case "delay":
      return Stream.execute(Effect.sleep(Duration.millis(step.ms)));
    case "complete":
      return Stream.empty;
    case "fail":
      return Stream.fail(step.error);
    case "stall":
      return Stream.execute(Effect.never);
    default:
      return Stream.make(step);
  }
};

const scriptToStream = (script: RunScript): Stream.Stream<AgentEvent, AgentError> =>
  Stream.suspend(() => {
    const parts: Array<Stream.Stream<AgentEvent, AgentError>> = [];
    for (const step of script) {
      parts.push(stepStream(step));
      if (isTerminal(step)) {
        break;
      }
    }
    return parts.reduce(
      (acc, s) => Stream.concat(acc, s),
      Stream.empty as Stream.Stream<AgentEvent, AgentError>,
    );
  });

interface FakeState {
  readonly scripts: ReadonlyMap<string, ReadonlyArray<RunScript>>;
  readonly runs: ReadonlyArray<RunRecord>;
}

export interface FakeAgentRunnerControl {
  /** Queue a script for the next (or a later) `run()` of `issueId`. */
  readonly pushScript: (issueId: string, script: RunScript) => Effect.Effect<void>;
  /** All recorded `run()` invocations, in order. */
  readonly runs: Effect.Effect<ReadonlyArray<RunRecord>>;
}

export interface FakeAgentRunner {
  readonly layer: Layer.Layer<AgentRunner>;
  readonly control: FakeAgentRunnerControl;
}

export const makeFakeAgentRunner = (): Effect.Effect<FakeAgentRunner> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<FakeState>({ scripts: new Map(), runs: [] });

    const run = (params: AgentRunParams): Stream.Stream<AgentEvent, AgentError> =>
      Stream.unwrap(
        Ref.modify(ref, (st) => {
          const queue = st.scripts.get(params.issue.id) ?? [];
          const next: RunScript =
            queue.length > 0 ? (queue[0] as RunScript) : [{ _tag: "complete" }];
          const scripts = new Map(st.scripts);
          scripts.set(params.issue.id, queue.slice(1));
          const record: RunRecord = {
            issueId: params.issue.id,
            attempt: params.attempt,
            prompt: params.prompt,
            resumeSessionId: params.resume?.sessionId ?? null,
          };
          return [scriptToStream(next), { scripts, runs: [...st.runs, record] }];
        }),
      );

    const control: FakeAgentRunnerControl = {
      pushScript: (issueId, script) =>
        Ref.update(ref, (st) => {
          const scripts = new Map(st.scripts);
          scripts.set(issueId, [...(scripts.get(issueId) ?? []), script]);
          return { ...st, scripts };
        }),
      runs: Ref.get(ref).pipe(Effect.map((s) => s.runs)),
    };

    return { layer: Layer.succeed(AgentRunner, { run }), control };
  });
