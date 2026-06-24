import { Effect, Layer, Queue, Schema } from "effect";
import { ClockLive } from "../../src/core/clock/live";
import { Issue, IssueStateRef } from "../../src/core/domain/issue";
import { ServiceConfig, type WorkflowDefinition } from "../../src/core/domain/workflow";
import { ControlStatusLive } from "../../src/core/observability/control-status";
import { RecentCompletionsLive } from "../../src/core/observability/recent-completions";
import { RestoreStatusLive } from "../../src/core/observability/restore-status";
import { CommandBusLive } from "../../src/core/orchestrator/command";
import type { OrchestratorDeps } from "../../src/core/orchestrator/loop";
import type { Observation, Observer } from "../../src/core/orchestrator/observer";
import { layerOrchestratorStore } from "../../src/core/orchestrator/state";
import type { AgentRunner } from "../../src/core/ports/agent-runner";
import type { IssueTracker } from "../../src/core/ports/issue-tracker";
import type { WorkspaceManager } from "../../src/core/ports/workspace-manager";

/**
 * Shared scenario-test harness (Task 10/11). Builds fully-defaulted {@link WorkflowDefinition}s
 * and normalized {@link Issue}s declaratively, composes the four fakes + the real store +
 * the TestClock-controllable {@link ClockLive} into a single layer, and provides the
 * deterministic `waitFor`/`drain` stepping primitives the loop scenarios rely on.
 */

/** A workspace root that is never actually touched (the fake WM is in-memory). */
export const TEST_ROOT = "/tmp/orchestra-test-ws";

export interface DefOptions {
  readonly activeStates?: ReadonlyArray<string>;
  readonly terminalStates?: ReadonlyArray<string>;
  readonly requiredLabels?: ReadonlyArray<string>;
  readonly intervalMs?: number;
  readonly maxConcurrent?: number;
  readonly maxTurns?: number;
  readonly maxRetryBackoffMs?: number;
  readonly perState?: Record<string, number>;
  readonly stallTimeoutMs?: number;
  readonly root?: string;
  readonly template?: string;
  /** #53 budget guardrail: token ceiling. Omit → no budget block (guard inert). */
  readonly budgetMaxTotalTokens?: number;
}

/** Build a complete {@link WorkflowDefinition} from a few knobs (defaults fill the rest). */
export const buildDef = (opts: DefOptions = {}): WorkflowDefinition => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    tracker: {
      kind: "github",
      repo: "octo/repo",
      api_key: "test-token",
      active_states: opts.activeStates ?? ["Todo", "In Progress"],
      terminal_states: opts.terminalStates ?? ["Done", "Closed"],
      required_labels: opts.requiredLabels ?? [],
    },
    polling: { interval_ms: opts.intervalMs ?? 30_000 },
    agent: {
      max_concurrent_agents: opts.maxConcurrent ?? 10,
      max_turns: opts.maxTurns ?? 1,
      max_retry_backoff_ms: opts.maxRetryBackoffMs ?? 300_000,
      max_concurrent_agents_by_state: opts.perState ?? {},
    },
    copilot: { stall_timeout_ms: opts.stallTimeoutMs ?? 300_000 },
    workspace: { root: opts.root ?? TEST_ROOT },
    ...(opts.budgetMaxTotalTokens === undefined
      ? {}
      : { budget: { max_total_tokens: opts.budgetMaxTotalTokens } }),
  });
  return { config, prompt_template: opts.template ?? "Work on {{ issue.identifier }}." };
};

export interface IssueOptions {
  readonly id: string;
  readonly identifier: string;
  readonly state: string;
  readonly title?: string;
  readonly priority?: number | null;
  readonly labels?: ReadonlyArray<string>;
  readonly blocked_by?: Issue["blocked_by"];
  readonly created_at?: Date | null;
}

/** Construct a normalized {@link Issue} with sensible nulls for the unused fields. */
export const makeIssue = (opts: IssueOptions): Issue =>
  Issue.make({
    id: opts.id,
    identifier: opts.identifier,
    title: opts.title ?? opts.identifier,
    description: null,
    priority: opts.priority ?? null,
    state: opts.state,
    branch_name: null,
    url: null,
    labels: opts.labels ?? [],
    blocked_by: opts.blocked_by ?? [],
    created_at: opts.created_at ?? null,
    updated_at: null,
  });

/** Construct an {@link IssueStateRef} for the reconciliation refresh table. */
export const makeStateRef = (
  id: string,
  state: string,
  labels: ReadonlyArray<string> = [],
): IssueStateRef => IssueStateRef.make({ id, identifier: id, state, labels });

export interface LoopParts {
  readonly tracker: Layer.Layer<IssueTracker>;
  readonly runner: Layer.Layer<AgentRunner>;
  readonly workspace: Layer.Layer<WorkspaceManager>;
  readonly observer: Layer.Layer<Observer>;
}

/** The four fake layers + the def, composed with the store and TestClock-driven clock. */
export const loopLayer = (
  def: WorkflowDefinition,
  parts: LoopParts,
): Layer.Layer<OrchestratorDeps> =>
  Layer.mergeAll(
    parts.tracker,
    parts.runner,
    parts.workspace,
    parts.observer,
    ClockLive,
    layerOrchestratorStore(def.config),
    RecentCompletionsLive,
    RestoreStatusLive,
    ControlStatusLive,
    CommandBusLive,
  );

/**
 * Step the loop deterministically: take observations off the recording queue until one
 * satisfies `pred`, returning it. Pair with `TestClock.adjust` only when a timer/sleep
 * must fire to reach the next observation.
 */
export const waitFor = (
  queue: Queue.Dequeue<Observation>,
  pred: (o: Observation) => boolean,
): Effect.Effect<Observation> => Queue.take(queue).pipe(Effect.repeat({ until: pred }));

/** Collect every observation currently buffered (non-blocking). */
export const drain = (
  queue: Queue.Dequeue<Observation>,
): Effect.Effect<ReadonlyArray<Observation>> =>
  Queue.takeAll(queue).pipe(Effect.map((chunk) => Array.from(chunk)));
