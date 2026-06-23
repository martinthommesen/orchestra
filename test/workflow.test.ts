import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Issue } from "../src/core/domain";
import {
  MissingWorkflowFile,
  TemplateParseError,
  TemplateRenderError,
  WorkflowFrontMatterNotAMap,
  WorkflowParseError,
} from "../src/core/errors";
import {
  loadWorkflow,
  type PathContext,
  parseWorkflow,
  renderPrompt,
  splitFrontMatter,
} from "../src/core/workflow";

const ctx = (over: Partial<PathContext> = {}): PathContext => ({
  env: {},
  homeDir: "/home/dev",
  tmpDir: "/tmp-test",
  workflowDir: "/repo",
  ...over,
});

const fakeIssue: Issue = {
  id: "i1",
  identifier: "ABC-7",
  title: "Add login",
  description: null,
  priority: null,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: ["bug", "ready"],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

const withFm = [
  "---",
  "tracker:",
  "  kind: github",
  "  repo: acme/widgets",
  "  api_key: $GH",
  "workspace:",
  "  root: ./ws",
  "---",
  "Work on {{ issue.identifier }}",
].join("\n");

describe("splitFrontMatter", () => {
  it("splits front matter from body", () => {
    const r = splitFrontMatter(withFm);
    expect(r.frontMatter).toContain("kind: github");
    expect(r.body).toBe("Work on {{ issue.identifier }}");
  });

  it("returns null front matter when absent", () => {
    const r = splitFrontMatter("just a body\nsecond line");
    expect(r.frontMatter).toBeNull();
    expect(r.body).toBe("just a body\nsecond line");
  });
});

describe("parseWorkflow (SPEC §5–§6)", () => {
  effectIt.effect("decodes config, applies defaults, resolves $VAR and paths", () =>
    Effect.gen(function* () {
      const def = yield* parseWorkflow(
        withFm,
        ctx({ env: { GH: "tok_123" }, workflowDir: "/repo" }),
      );
      expect(def.config.tracker.kind).toBe("github");
      expect(def.config.tracker.repo).toBe("acme/widgets");
      // $VAR resolved from env (value never logged).
      expect(def.config.tracker.api_key).toBe("tok_123");
      // relative root resolved against the WORKFLOW.md directory, made absolute.
      expect(def.config.workspace.root).toBe(nodePath.resolve("/repo", "ws"));
      // untouched section still defaulted.
      expect(def.config.polling.interval_ms).toBe(30_000);
      expect(def.prompt_template).toBe("Work on {{ issue.identifier }}");
    }),
  );

  effectIt.effect("treats a missing $VAR as absent api_key (SPEC §5.3.1)", () =>
    Effect.gen(function* () {
      const def = yield* parseWorkflow(withFm, ctx({ env: {} }));
      expect(def.config.tracker.api_key).toBeUndefined();
    }),
  );

  effectIt.effect("defaults workspace.root to <temp>/orchestra_workspaces", () =>
    Effect.gen(function* () {
      const def = yield* parseWorkflow("no front matter here", ctx());
      expect(def.config.workspace.root).toBe(nodePath.join("/tmp-test", "orchestra_workspaces"));
      expect(def.prompt_template).toBe("no front matter here");
    }),
  );

  effectIt.effect("expands ~ in workspace.root", () =>
    Effect.gen(function* () {
      const def = yield* parseWorkflow(
        "---\nworkspace:\n  root: ~/wsroot\n---\nbody",
        ctx({ homeDir: "/home/dev" }),
      );
      expect(def.config.workspace.root).toBe(nodePath.join("/home/dev", "wsroot"));
    }),
  );

  effectIt.effect("fails WorkflowFrontMatterNotAMap on non-map front matter", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseWorkflow("---\n42\n---\nbody", ctx()));
      expect(error).toBeInstanceOf(WorkflowFrontMatterNotAMap);
    }),
  );

  effectIt.effect("fails WorkflowParseError on invalid YAML", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parseWorkflow("---\ntracker: {kind: github\n---\nbody", ctx()),
      );
      expect(error).toBeInstanceOf(WorkflowParseError);
    }),
  );

  effectIt.effect("fails WorkflowParseError on a type-invalid value", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parseWorkflow("---\npolling:\n  interval_ms: not-a-number\n---\nx", ctx()),
      );
      expect(error).toBeInstanceOf(WorkflowParseError);
    }),
  );
});

describe("renderPrompt (strict Liquid, SPEC §5.4)", () => {
  effectIt.effect("renders issue variables", () =>
    Effect.gen(function* () {
      const out = yield* renderPrompt(
        "Issue {{ issue.identifier }}: {{ issue.title }} [{{ issue.labels | join: ', ' }}]",
        { issue: fakeIssue, attempt: null },
      );
      expect(out).toBe("Issue ABC-7: Add login [bug, ready]");
    }),
  );

  effectIt.effect("renders attempt conditionally", () =>
    Effect.gen(function* () {
      const first = yield* renderPrompt(
        "{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}",
        { issue: fakeIssue, attempt: null },
      );
      const retry = yield* renderPrompt(
        "{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}",
        { issue: fakeIssue, attempt: 3 },
      );
      expect(first).toBe("first");
      expect(retry).toBe("retry 3");
    }),
  );

  effectIt.effect("unknown variable → TemplateRenderError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        renderPrompt("Hello {{ mystery }}", { issue: fakeIssue, attempt: null }),
      );
      expect(error).toBeInstanceOf(TemplateRenderError);
    }),
  );

  effectIt.effect("unknown filter → TemplateRenderError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        renderPrompt("{{ issue.title | no_such_filter }}", {
          issue: fakeIssue,
          attempt: null,
        }),
      );
      expect(error).toBeInstanceOf(TemplateRenderError);
    }),
  );

  effectIt.effect("syntax error → TemplateParseError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        renderPrompt("{{ issue.title ", { issue: fakeIssue, attempt: null }),
      );
      expect(error).toBeInstanceOf(TemplateParseError);
    }),
  );
});

describe("loadWorkflow (file IO via FileSystem)", () => {
  const fixture = fileURLToPath(new URL("./fixtures/workflow-basic.md", import.meta.url));

  effectIt.effect("reads and parses a real fixture", () =>
    Effect.gen(function* () {
      const def = yield* loadWorkflow(fixture);
      expect(def.config.tracker.repo).toBe("acme/widgets");
      expect(def.config.polling.interval_ms).toBe(15_000);
      expect(def.config.agent.max_turns).toBe(8);
      expect(def.config.copilot.model).toBe("claude-opus-4.8");
      expect(nodePath.isAbsolute(def.config.workspace.root as string)).toBe(true);
      expect(def.prompt_template).toContain("{{ issue.identifier }}");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  effectIt.effect("missing file → MissingWorkflowFile", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadWorkflow("/no/such/WORKFLOW.md"));
      expect(error).toBeInstanceOf(MissingWorkflowFile);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
