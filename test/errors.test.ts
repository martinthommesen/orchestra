import { Equal } from "effect";
import { describe, expect, it } from "vitest";
import * as E from "../src/core/errors";

/**
 * Task 4: every SPEC error class constructs, carries its payload, and is
 * `_tag`-discriminable. The exhaustive `switch` below also fails the *type* check
 * (not just the test) if a member is dropped from a union.
 */

// One representative instance per error class, paired with its expected `_tag`.
const samples: ReadonlyArray<readonly [{ readonly _tag: string }, string]> = [
  // Workflow (§5.5)
  [
    new E.MissingWorkflowFile({
      message: "could not read '/x/WORKFLOW.md'",
      path: "/x/WORKFLOW.md",
    }),
    "MissingWorkflowFile",
  ],
  [new E.WorkflowParseError({ message: "bad yaml" }), "WorkflowParseError"],
  [new E.WorkflowFrontMatterNotAMap({ message: "got array" }), "WorkflowFrontMatterNotAMap"],
  [new E.TemplateParseError({ message: "unterminated" }), "TemplateParseError"],
  [new E.TemplateRenderError({ message: "undefined var" }), "TemplateRenderError"],
  // Agent (§10.6)
  [new E.AgentNotFound({ command: "copilot" }), "AgentNotFound"],
  [new E.InvalidWorkspaceCwd({ expected: "/ws/a", actual: "/ws/b" }), "InvalidWorkspaceCwd"],
  [new E.ResponseTimeout({ timeout_ms: 5000 }), "ResponseTimeout"],
  [new E.TurnTimeout({ timeout_ms: 3_600_000 }), "TurnTimeout"],
  [new E.AgentProcessExit({ code: 1, signal: null }), "AgentProcessExit"],
  [new E.ResponseError({ message: "nope" }), "ResponseError"],
  [new E.TurnFailed({ message: "failed" }), "TurnFailed"],
  [new E.TurnCancelled({}), "TurnCancelled"],
  [new E.TurnInputRequired({}), "TurnInputRequired"],
  // Tracker (§11.4)
  [new E.UnsupportedTrackerKind({ kind: "jira" }), "UnsupportedTrackerKind"],
  [new E.MissingTrackerApiKey({}), "MissingTrackerApiKey"],
  [new E.MissingTrackerRepo({ message: "repo required" }), "MissingTrackerRepo"],
  [new E.TrackerApiRequest({ message: "ECONNRESET" }), "TrackerApiRequest"],
  [new E.TrackerApiStatus({ status: 503 }), "TrackerApiStatus"],
  [new E.TrackerGraphqlErrors({ errors: [{ message: "x" }] }), "TrackerGraphqlErrors"],
  [new E.TrackerUnknownPayload({ message: "shape" }), "TrackerUnknownPayload"],
  [new E.TrackerMissingEndCursor({ message: "page" }), "TrackerMissingEndCursor"],
  // Workspace safety (§9.4/§9.5)
  [new E.PathOutsideWorkspaceRoot({ path: "/etc", root: "/ws" }), "PathOutsideWorkspaceRoot"],
  [new E.WorkspaceCreationFailed({ path: "/ws/a" }), "WorkspaceCreationFailed"],
  [new E.WorkspaceHookFailed({ hook: "before_run", message: "exit 1" }), "WorkspaceHookFailed"],
  [new E.WorkspaceHookTimeout({ hook: "after_create", timeout_ms: 60000 }), "WorkspaceHookTimeout"],
];

describe("tagged errors", () => {
  it.each(samples)("%s constructs with the right _tag", (error, tag) => {
    expect(error._tag).toBe(tag);
    expect(error).toBeInstanceOf(Error);
  });

  it("instances are structurally equal (Data.TaggedError value semantics)", () => {
    const a = new E.TurnTimeout({ timeout_ms: 1000 });
    const b = new E.TurnTimeout({ timeout_ms: 1000 });
    expect(Equal.equals(a, b)).toBe(true);
  });

  it("every sample has a unique _tag (no collisions)", () => {
    const tags = samples.map(([, tag]) => tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("discriminates an OrchestraError by _tag (exhaustive switch type-checks)", () => {
    const categorize = (e: E.OrchestraError): string => {
      switch (e._tag) {
        case "MissingWorkflowFile":
        case "WorkflowParseError":
        case "WorkflowFrontMatterNotAMap":
        case "TemplateParseError":
        case "TemplateRenderError":
          return "workflow";
        case "AgentNotFound":
        case "InvalidWorkspaceCwd":
        case "ResponseTimeout":
        case "TurnTimeout":
        case "AgentProcessExit":
        case "ResponseError":
        case "TurnFailed":
        case "TurnCancelled":
        case "TurnInputRequired":
          return "agent";
        case "UnsupportedTrackerKind":
        case "MissingTrackerApiKey":
        case "MissingTrackerRepo":
        case "TrackerApiRequest":
        case "TrackerApiStatus":
        case "TrackerGraphqlErrors":
        case "TrackerUnknownPayload":
        case "TrackerMissingEndCursor":
          return "tracker";
        case "PathOutsideWorkspaceRoot":
        case "WorkspaceCreationFailed":
        case "WorkspaceHookFailed":
        case "WorkspaceHookTimeout":
          return "workspace";
      }
    };

    expect(categorize(new E.TurnFailed({ message: "x" }))).toBe("agent");
    expect(categorize(new E.MissingWorkflowFile({ message: "m", path: "/x" }))).toBe("workflow");
    expect(categorize(new E.TrackerApiStatus({ status: 500 }))).toBe("tracker");
    expect(categorize(new E.PathOutsideWorkspaceRoot({ path: "/a", root: "/b" }))).toBe(
      "workspace",
    );
  });
});
