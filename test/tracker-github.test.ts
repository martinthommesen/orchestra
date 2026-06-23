import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deriveBlockedBy,
  derivePriority,
  deriveState,
  type GitHubIssuePayload,
  isPullRequest,
  labelNames,
  toIssue,
  toStateRef,
} from "../src/adapters/tracker-github/normalize";
import { ServiceConfig } from "../src/core/domain/workflow";

const config = (tracker: Record<string, unknown> = {}): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)({
    tracker: { kind: "github", repo: "o/r", api_key: "t", ...tracker },
  });

const payload = (p: Partial<GitHubIssuePayload>): GitHubIssuePayload => ({
  number: 1,
  title: "T",
  state: "open",
  labels: [],
  ...p,
});

describe("isPullRequest", () => {
  it("is true only when a pull_request member is present", () => {
    expect(isPullRequest(payload({ pull_request: { url: "x" } }))).toBe(true);
    expect(isPullRequest(payload({}))).toBe(false);
  });
});

describe("labelNames", () => {
  it("flattens string and {name} label shapes and drops empties", () => {
    const names = labelNames(
      payload({ labels: ["bug", { name: "p1" }, { name: null }, { name: "" }, "feature"] }),
    );
    expect(names).toEqual(["bug", "p1", "feature"]);
  });
});

describe("derivePriority", () => {
  it("reads priority:<n> labels", () => {
    expect(derivePriority(["bug", "priority:2"])).toBe(2);
  });
  it("reads p<n> labels", () => {
    expect(derivePriority(["p0"])).toBe(0);
  });
  it("is null when no priority label present", () => {
    expect(derivePriority(["bug", "feature"])).toBeNull();
  });
  it("takes the first priority label encountered", () => {
    expect(derivePriority(["p3", "priority:1"])).toBe(3);
  });
});

describe("deriveBlockedBy", () => {
  it("parses 'blocked by #N' and 'depends on #N' refs", () => {
    const refs = deriveBlockedBy("This is blocked by #12 and depends on #34.");
    expect(refs).toEqual([
      { id: "12", identifier: "#12", state: null },
      { id: "34", identifier: "#34", state: null },
    ]);
  });
  it("de-duplicates repeated refs", () => {
    expect(deriveBlockedBy("blocked by #5, blocked by #5")).toEqual([
      { id: "5", identifier: "#5", state: null },
    ]);
  });
  it("is empty when nothing is referenced", () => {
    expect(deriveBlockedBy("no blockers here #notanumber")).toEqual([]);
  });
});

describe("deriveState (§11.3)", () => {
  it("prefers a status label matching a configured state (case-insensitive)", () => {
    const s = deriveState(payload({ labels: ["In Progress"], state: "open" }), config());
    expect(s).toBe("In Progress");
  });
  it("falls back to active_states[0] for open issues with no status label", () => {
    expect(deriveState(payload({ state: "open" }), config())).toBe("Todo");
  });
  it("maps closed+not_planned to a cancel-flavored terminal state", () => {
    expect(deriveState(payload({ state: "closed", state_reason: "not_planned" }), config())).toBe(
      "Cancelled",
    );
  });
  it("maps a plain closed issue to a closed/done terminal state", () => {
    expect(deriveState(payload({ state: "closed", state_reason: "completed" }), config())).toBe(
      "Closed",
    );
  });
});

describe("toIssue", () => {
  it("maps number→id/identifier, body→description, html_url→url and lowercases labels", () => {
    const issue = toIssue(
      payload({
        number: 42,
        title: "Add feature",
        body: "depends on #7",
        labels: ["Bug", "P1"],
        html_url: "https://github.com/o/r/issues/42",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      }),
      config(),
    );
    expect(issue.id).toBe("42");
    expect(issue.identifier).toBe("42");
    expect(issue.title).toBe("Add feature");
    expect(issue.description).toBe("depends on #7");
    expect(issue.url).toBe("https://github.com/o/r/issues/42");
    expect(issue.labels).toEqual(["bug", "p1"]);
    expect(issue.priority).toBe(1);
    expect(issue.blocked_by).toEqual([{ id: "7", identifier: "#7", state: null }]);
    expect(issue.created_at?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("handles null body / missing timestamps", () => {
    const issue = toIssue(payload({ body: null }), config());
    expect(issue.description).toBeNull();
    expect(issue.blocked_by).toEqual([]);
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at).toBeNull();
  });
});

describe("toStateRef", () => {
  it("produces a lightweight ref with derived state and normalized labels", () => {
    const ref = toStateRef(payload({ number: 9, labels: ["In Progress", "Bug"] }), config());
    expect(ref.id).toBe("9");
    expect(ref.identifier).toBe("9");
    expect(ref.state).toBe("In Progress");
    expect(ref.labels).toEqual(["in progress", "bug"]);
  });
});
