import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import type { Issue } from "../src/core/domain";
import { loadWorkflow, renderPrompt } from "../src/core/workflow";

/**
 * Sprint 0, Task 11. Guards the shipped `WORKFLOW.example.md` so the example a new
 * adopter copies is always loadable (front matter decodes + paths resolve) and its
 * Liquid body strict-renders against a real {@link Issue} — no unknown var/filter can
 * sneak in. If this fails, the example is broken for users.
 */

const examplePath = fileURLToPath(new URL("../WORKFLOW.example.md", import.meta.url));

const richIssue: Issue = {
  id: "i1",
  identifier: "ORC-42",
  title: "Add rate limiting",
  description: "Throttle the API to 100 req/min.",
  priority: 2,
  state: "Todo",
  branch_name: null,
  url: "https://github.com/your-org/your-repo/issues/42",
  labels: ["orchestra", "backend"],
  blocked_by: [{ id: "i0", identifier: "ORC-40", state: "In Progress" }],
  created_at: null,
  updated_at: null,
};

const minimalIssue: Issue = {
  ...richIssue,
  description: null,
  priority: null,
  url: null,
  labels: [],
  blocked_by: [],
};

describe("WORKFLOW.example.md (Sprint 0 Task 11)", () => {
  it.effect("loads with the documented config and applies defaults", () =>
    Effect.gen(function* () {
      const def = yield* loadWorkflow(examplePath);
      expect(def.config.tracker.kind).toBe("github");
      expect(def.config.tracker.repo).toBe("your-org/your-repo");
      expect(def.config.tracker.required_labels).toEqual(["orchestra"]);
      expect(def.config.polling.interval_ms).toBe(30_000);
      expect(def.config.agent.max_concurrent_agents).toBe(3);
      expect(def.config.agent.max_turns).toBe(10);
      expect(def.config.copilot.command).toBe("copilot");
      expect(def.config.hooks.after_create).toBe("git init -q");
      // workspace.root is resolved to an absolute path (relative → WORKFLOW dir).
      expect(nodePath.isAbsolute(def.config.workspace.root as string)).toBe(true);
      // the body is preserved as the prompt template.
      expect(def.prompt_template).toContain("{{ issue.identifier }}");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("strict-renders the prompt body for a first attempt", () =>
    Effect.gen(function* () {
      const def = yield* loadWorkflow(examplePath);
      const out = yield* renderPrompt(def.prompt_template, { issue: richIssue, attempt: null });
      expect(out).toContain("## Issue ORC-42 — Add rate limiting");
      expect(out).toContain("Priority: 2");
      expect(out).toContain("Labels: orchestra, backend");
      expect(out).toContain("Throttle the API to 100 req/min.");
      expect(out).toContain("ORC-40 (In Progress)");
      // first-attempt branch, not the retry branch:
      expect(out).toContain("Explore the repository");
      expect(out).not.toContain("retry attempt");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("strict-renders the retry branch and handles null fields", () =>
    Effect.gen(function* () {
      const def = yield* loadWorkflow(examplePath);
      const out = yield* renderPrompt(def.prompt_template, { issue: minimalIssue, attempt: 2 });
      expect(out).toContain("retry attempt 2");
      expect(out).toContain("(no description provided)");
      // optional sections are omitted when their fields are empty/null:
      expect(out).not.toContain("Priority:");
      expect(out).not.toContain("Labels:");
      expect(out).not.toContain("Blocked by");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
