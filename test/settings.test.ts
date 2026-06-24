import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import { LiveBudget } from "../src/core/observability/live-budget";
import { toSnapshot } from "../src/core/observability/snapshot";
import { evaluateBudget } from "../src/core/orchestrator/budget";
import { CommandBus } from "../src/core/orchestrator/command";
import { runOrchestrator } from "../src/core/orchestrator/loop";
import type { Observation } from "../src/core/orchestrator/observer";
import { OrchestratorStore } from "../src/core/orchestrator/state";
import { WorkflowFile, WorkflowFileLive } from "../src/core/workflow/workflow-file";
import * as Ev from "./fakes/events";
import { makeFakeAgentRunner } from "./fakes/fake-agent-runner";
import { makeFakeTracker } from "./fakes/fake-tracker";
import { makeFakeWorkspaceManager } from "./fakes/fake-workspace-manager";
import { buildDef, loopLayer, makeIssue, makeStateRef, TEST_ROOT, waitFor } from "./fakes/harness";
import { makeRecordingObserver } from "./fakes/recording-observer";

/**
 * Sprint 6 / #66 — settings read/persist + hot-reload (DD-4). Two halves:
 *
 *   1. {@link WorkflowFile} edits a whitelisted subset of the RAW front matter, atomically,
 *      while `tracker.api_key` (a `$VAR`) and the Liquid body pass through byte-for-byte —
 *      and an invalid patch is rejected before any write lands (the secret-safety headline);
 *   2. a `ReloadConfig` command hot-applies the new knobs on the NEXT tick through the real
 *      {@link runOrchestrator} fiber, without disturbing in-flight work (mirrors the budget
 *      gate).
 */

// The fixture uses a `$VAR` whose name carries no secret-keyword, so the raw file is a clean
// fixture (the resolved value lives only in env / the in-memory config, never on the wire).
const CRED_ENV_VAR = "ORCHESTRA_FIXTURE_CRED";
const CRED_VALUE = "resolved-by-the-env-not-the-wire";

const BODY = [
  "Resolve issue {{ issue.identifier }}.",
  "",
  "{% if issue.body %}{{ issue.body }}{% endif %}",
  "",
  "Keep going until done.",
].join("\n");

const ORIGINAL = [
  "---",
  "tracker:",
  "  kind: github",
  "  repo: acme/widgets",
  `  api_key: $${CRED_ENV_VAR}`,
  "polling:",
  "  interval_ms: 30000",
  "agent:",
  "  max_concurrent_agents: 4",
  "  max_turns: 20",
  "budget:",
  "  max_total_tokens: 100000",
  "---",
  BODY,
  "",
].join("\n");

// A fixture with **aligned trailing comments** and a **flow-style array** among keys the patch
// never touches — the exact shapes #73 must leave byte-for-byte. The OLD `doc.toString()` path
// collapsed both (comment padding → single space, `[a, b]` → `[ a, b ]`).
const ALIGNED = [
  "---",
  "tracker:",
  "  kind: github                      # tracker backend",
  "  repo: acme/widgets                # the target repo",
  `  api_key: $${CRED_ENV_VAR}`,
  "  required_labels: [orchestra, bot] # flow-style array stays compact",
  "polling:",
  "  interval_ms: 30000               # poll cadence",
  "agent:",
  "  max_concurrent_agents: 4         # global cap",
  "  max_turns: 20                    # per-session turn cap",
  "  max_retry_backoff_ms: 300000     # backoff ceiling",
  "budget:",
  "  max_total_tokens: 100000         # spend ceiling",
  "---",
  BODY,
  "",
].join("\n");

describe("WorkflowFile settings persist (#66, DD-4)", () => {
  it.scoped(
    "headline: api_key ($VAR) + Liquid body are byte-identical across a write; knobs change",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
        const path = `${dir}/WORKFLOW.md`;
        yield* fs.writeFileString(path, ORIGINAL);
        // The $VAR resolves from env (in-memory only) — never read by the editor/write path.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env[CRED_ENV_VAR] = CRED_VALUE;
          }),
          () =>
            Effect.sync(() => {
              delete process.env[CRED_ENV_VAR];
            }),
        );

        const applied = yield* Effect.gen(function* () {
          const wf = yield* WorkflowFile;
          return yield* wf.applyPatch(
            {
              polling: { interval_ms: 5000 },
              agent: { max_turns: 7 },
              budget: { max_total_tokens: null }, // clear the ceiling
            },
            () => Effect.void,
          );
        }).pipe(Effect.provide(WorkflowFileLive(path)));

        const after = yield* fs.readFileString(path);

        // Secret safety + body preservation: the untouched $VAR and the Liquid body survive.
        expect(after).toContain(`api_key: $${CRED_ENV_VAR}`);
        expect(after).toContain(BODY);
        // Whitelisted knobs changed; the cleared ceiling is gone from the front matter.
        expect(after).toContain("interval_ms: 5000");
        expect(after).toContain("max_turns: 7");
        expect(after).not.toContain("max_total_tokens");

        // The editable view returned to the wire carries NO secret (no `tracker` at all).
        expect(applied.settings).toEqual({
          polling: { interval_ms: 5000 },
          agent: {
            max_concurrent_agents: 4,
            max_concurrent_agents_by_state: {},
            max_turns: 7,
            max_retry_backoff_ms: 300_000,
          },
          budget: { max_total_tokens: null },
        });
        // The in-process config (for ReloadConfig) DID resolve the secret — proving the
        // secret stays in memory and is never what we serialize to disk or the wire.
        expect(applied.config.tracker.api_key).toBe(CRED_VALUE);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "#73 scalar PUT on an existing key is byte-verbatim — only the edited value moves",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
        const path = `${dir}/WORKFLOW.md`;
        yield* fs.writeFileString(path, ALIGNED);

        // The dominant case: change one scalar on a key that already exists. Same digit width
        // (20 → 33) so the surrounding alignment cannot shift for any reason but ours.
        yield* Effect.gen(function* () {
          const wf = yield* WorkflowFile;
          return yield* wf.applyPatch({ agent: { max_turns: 33 } }, () => Effect.void);
        }).pipe(Effect.provide(WorkflowFileLive(path)));

        const after = yield* fs.readFileString(path);

        // The whole file is byte-identical except the one value — the surgical-edit promise.
        expect(after).toBe(ALIGNED.replace("max_turns: 20", "max_turns: 33"));
        // Spelled out: the aligned trailing comment and the flow array (untouched keys) are
        // preserved to the byte — the exact regressions #73 fixed.
        expect(after).toContain("  repo: acme/widgets                # the target repo");
        expect(after).toContain(
          "  required_labels: [orchestra, bot] # flow-style array stays compact",
        );
        expect(after).toContain("  max_turns: 33                    # per-session turn cap");
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "#73 budget-clear (structural delete) prunes the block + keeps flow arrays compact",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
        const path = `${dir}/WORKFLOW.md`;
        yield* fs.writeFileString(path, ALIGNED);

        // Clearing the ceiling is the structural path (a key delete). The landed guarantee:
        // the now-empty `budget:` block is pruned (no dangling `budget: {}`), the flow array is
        // NOT re-padded, and the secret/$VAR + Liquid body survive. Comment ALIGNMENT on the
        // untouched lines may normalize on this best-effort path — that is accepted, not a bug.
        yield* Effect.gen(function* () {
          const wf = yield* WorkflowFile;
          return yield* wf.applyPatch({ budget: { max_total_tokens: null } }, () => Effect.void);
        }).pipe(Effect.provide(WorkflowFileLive(path)));

        const after = yield* fs.readFileString(path);

        // The cleared ceiling — and its now-empty parent block — are gone entirely.
        expect(after).not.toContain("max_total_tokens");
        expect(after).not.toContain("budget:");
        // The flow array is preserved COMPACT (the `[ orchestra ]` padding regression stays fixed).
        expect(after).toContain("[orchestra, bot]");
        expect(after).not.toContain("[ orchestra");
        // Secret value ($VAR) + Liquid body still pass through; comments survive (alignment may
        // normalize on this structural path).
        expect(after).toContain(`api_key: $${CRED_ENV_VAR}`);
        expect(after).toContain(BODY);
        expect(after).toContain("# the target repo");
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("read returns the whitelisted subset (raw values, no secrets)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
      const path = `${dir}/WORKFLOW.md`;
      yield* fs.writeFileString(path, ORIGINAL);

      const settings = yield* Effect.gen(function* () {
        const wf = yield* WorkflowFile;
        return yield* wf.read;
      }).pipe(Effect.provide(WorkflowFileLive(path)));

      expect(settings.polling.interval_ms).toBe(30000);
      expect(settings.agent.max_concurrent_agents).toBe(4);
      expect(settings.budget.max_total_tokens).toBe(100000);
      // No secret-bearing keys are present on the editable projection.
      expect(Object.keys(settings)).toEqual(["polling", "agent", "budget"]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("an invalid patch (negative concurrency) is rejected before the write lands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
      const path = `${dir}/WORKFLOW.md`;
      yield* fs.writeFileString(path, ORIGINAL);

      // The patch schema is the boundary: a non-positive value never decodes, so applyPatch
      // is never reached and the file is left exactly as it was.
      const result = yield* Effect.gen(function* () {
        const wf = yield* WorkflowFile;
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass the type to feed a bad value.
        return yield* wf
          .applyPatch({ agent: { max_concurrent_agents: -1 } } as any, () => Effect.void)
          .pipe(
            Effect.match({
              onFailure: () => "rejected" as const,
              onSuccess: () => "wrote" as const,
            }),
          );
      }).pipe(Effect.provide(WorkflowFileLive(path)));

      expect(result).toBe("rejected");
      const after = yield* fs.readFileString(path);
      expect(after).toBe(ORIGINAL); // byte-identical — nothing was written.
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped("two overlapping writes both land (no lost update; serialized per writer)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
      const path = `${dir}/WORKFLOW.md`;
      yield* fs.writeFileString(path, ORIGINAL);

      // Two concurrent PUTs touch DIFFERENT keys. Unserialized, both read ORIGINAL and the
      // slower rename clobbers the faster one → a lost update (only one key changes) or an
      // ENOENT on a shared temp path. The Semaphore(1) + unique temp suffix make each apply
      // atomic against the other, so the final file reflects BOTH edits.
      yield* Effect.gen(function* () {
        const wf = yield* WorkflowFile;
        yield* Effect.all(
          [
            wf.applyPatch({ polling: { interval_ms: 5000 } }, () => Effect.void),
            wf.applyPatch({ agent: { max_turns: 7 } }, () => Effect.void),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(WorkflowFileLive(path)));

      const after = yield* fs.readFileString(path);
      expect(after).toContain("interval_ms: 5000"); // first writer's edit survived
      expect(after).toContain("max_turns: 7"); // second writer's edit survived
      // Untouched secret + body still byte-preserved through both writes.
      expect(after).toContain(`api_key: $${CRED_ENV_VAR}`);
      expect(after).toContain(BODY);
      // No temp file leaked behind a successful rename.
      const entries = yield* fs.readDirectory(dir);
      expect(entries.some((e) => e.includes(".orchestra.tmp"))).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scoped(
    "a rejected gate (wedged owner → 503) persists nothing — the file stays byte-identical",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-settings-" });
        const path = `${dir}/WORKFLOW.md`;
        yield* fs.writeFileString(path, ORIGINAL);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env[CRED_ENV_VAR] = CRED_VALUE;
          }),
          () =>
            Effect.sync(() => {
              delete process.env[CRED_ENV_VAR];
            }),
        );

        // The gate stands in for the owner-fiber reload ack. Here it REJECTS — exactly as a 5s
        // reload timeout (→ 503) does after the drop-on-timeout fix (256e527). The durable
        // commit is gated on the ack, so a rejected gate must persist NOTHING and apply nothing.
        const outcome = yield* Effect.gen(function* () {
          const wf = yield* WorkflowFile;
          return yield* wf
            .applyPatch({ agent: { max_turns: 99 } }, () => Effect.fail("owner-wedged" as const))
            .pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => "committed" as const }));
        }).pipe(Effect.provide(WorkflowFileLive(path)));

        // The gate's own failure propagates (the handler maps it straight to 503).
        expect(outcome).toBe("owner-wedged");
        const after = yield* fs.readFileString(path);
        expect(after).toBe(ORIGINAL); // byte-identical — the staged write never committed.
        // The staged temp was removed when the gate failed — nothing leaked.
        const leftovers = yield* fs.readDirectory(dir);
        expect(leftovers.some((e) => e.includes(".orchestra.tmp"))).toBe(false);
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});

const isDispatched =
  (issueId: string) =>
  (o: Observation): boolean =>
    o._tag === "Dispatched" && o.issueId === issueId;

describe("settings hot-reload via ReloadConfig (#66, DD-4)", () => {
  it.scoped("new knobs apply on the next tick without disturbing in-flight work", () =>
    Effect.gen(function* () {
      const i1 = makeIssue({ id: "i1", identifier: "ORC-1", state: "In Progress" });
      const i2 = makeIssue({ id: "i2", identifier: "ORC-2", state: "In Progress" });
      const tracker = yield* makeFakeTracker({
        candidates: [i1, i2],
        states: [makeStateRef("i1", "In Progress"), makeStateRef("i2", "In Progress")],
      });
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();
      // i1 stays in-flight for a long time; i2 completes quickly once it is allowed to run.
      yield* runner.control.pushScript("i1", [
        Ev.sessionStarted("s1"),
        { _tag: "delay", ms: 600_000 },
        { _tag: "complete" },
      ]);
      yield* runner.control.pushScript("i2", [Ev.sessionStarted("s2"), { _tag: "complete" }]);

      // Start capped at ONE agent → i2 is withheld by the concurrency gate while i1 runs.
      const def = buildDef({
        maxConcurrent: 1,
        maxTurns: 1,
        intervalMs: 10_000,
        stallTimeoutMs: 3_600_000,
      });
      // The reloaded config raises the cap to two and shortens the poll interval.
      const reloaded = buildDef({
        maxConcurrent: 2,
        maxTurns: 1,
        intervalMs: 4_000,
        stallTimeoutMs: 3_600_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const store = yield* OrchestratorStore;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        // i1 dispatches; i2 is withheld (cap = 1).
        yield* waitFor(obs.queue, isDispatched("i1"));
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, (o) => o._tag === "TickEnd");
        expect((yield* store.get).running.i2).toBeUndefined();

        // Operator raises the cap via settings hot-reload — the owner fiber acks `Reloaded`.
        const ack = yield* bus.send({ _tag: "ReloadConfig", config: reloaded.config });
        expect(ack).toEqual({ _tag: "Reloaded" });
        yield* waitFor(
          obs.queue,
          (o) => o._tag === "ConfigReloaded" && o.maxConcurrent === 2 && o.pollIntervalMs === 4000,
        );

        // The state-seeded knobs were patched in place.
        const afterReload = yield* store.get;
        expect(afterReload.max_concurrent_agents).toBe(2);
        expect(afterReload.poll_interval_ms).toBe(4000);

        // Next tick: i2 now dispatches under the new cap; i1 keeps running, untouched.
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* waitFor(obs.queue, isDispatched("i2"));
        const overState = yield* store.get;
        expect(overState.running.i1).toBeDefined(); // in-flight worker never disturbed.

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );

  it.scopedLive("ReloadConfig updates the live budget ceiling the cockpit snapshot projects", () =>
    Effect.gen(function* () {
      const tracker = yield* makeFakeTracker({});
      const runner = yield* makeFakeAgentRunner();
      const wsm = yield* makeFakeWorkspaceManager(TEST_ROOT);
      const obs = yield* makeRecordingObserver();

      // Start with NO ceiling → the snapshot omits the budget block entirely.
      const def = buildDef({ maxConcurrent: 1, intervalMs: 10_000 });
      // The reloaded config introduces a 9_000-token ceiling.
      const reloaded = buildDef({
        maxConcurrent: 1,
        intervalMs: 10_000,
        budgetMaxTotalTokens: 9_000,
      });
      const env = loopLayer(def, {
        tracker: tracker.layer,
        runner: runner.layer,
        workspace: wsm.layer,
        observer: obs.layer,
      });

      yield* Effect.gen(function* () {
        const bus = yield* CommandBus;
        const store = yield* OrchestratorStore;
        const liveBudget = yield* LiveBudget;
        const fiber = yield* Effect.forkScoped(runOrchestrator(def));

        const buildBudgetBlock = Effect.gen(function* () {
          const state = yield* store.get;
          const budget = yield* liveBudget.get;
          return toSnapshot(state, {
            recentEvents: [],
            recentCompleted: [],
            activity: new Map(),
            budget: evaluateBudget(budget, state.agent_totals),
            operatorPaused: false,
          }).budget;
        });

        // Before reload: no ceiling configured → additive budget block omitted.
        expect(yield* buildBudgetBlock).toBeUndefined();

        const ack = yield* bus.send({ _tag: "ReloadConfig", config: reloaded.config });
        expect(ack).toEqual({ _tag: "Reloaded" });
        yield* waitFor(obs.queue, (o) => o._tag === "ConfigReloaded");

        // After reload: the live ceiling is the new value, so the snapshot now projects it.
        const after = yield* buildBudgetBlock;
        expect(after).toBeDefined();
        expect(after?.limit_tokens).toBe(9_000);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(env));
    }),
  );
});
