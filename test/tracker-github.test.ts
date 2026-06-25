import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  layerGitHubTracker,
  makeOctokit,
  silentOctokitLog,
} from "../src/adapters/tracker-github/github-tracker";
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
import { IssueTracker } from "../src/core/ports/issue-tracker";

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
  it("returns null for a priority that overflows the safe-integer range (DEF-005)", () => {
    // An author-controlled label like `p99999999999999999999` parses to 1e20, which the
    // Issue schema's `Schema.Int` rejects — degrade to null rather than letting `Issue.make`
    // throw an uncaught defect that crashes the poll tick.
    expect(derivePriority(["p99999999999999999999"])).toBeNull();
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
  it("maps a closed issue with a lingering active label to terminal (closed precedence, #18)", () => {
    // A closed issue still carrying an active status label must NOT normalize to active —
    // `closed` is an explicit terminal signal and takes precedence over the label.
    expect(
      deriveState(
        payload({ state: "closed", state_reason: "completed", labels: ["In Progress"] }),
        config(),
      ),
    ).toBe("Closed");
  });
  it("honors a terminal status label to pick which terminal state on a closed issue", () => {
    expect(deriveState(payload({ state: "closed", labels: ["Done"] }), config())).toBe("Done");
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

  it("degrades a non-parseable timestamp to null instead of dying (DEF-005)", () => {
    // A garbage timestamp makes Schema.Date reject and Issue.make die (an uncaught defect
    // Effect.either does NOT catch), crashing the poll tick. It must map to null instead.
    const issue = toIssue(
      payload({ created_at: "garbage-date", updated_at: "also-not-a-date" }),
      config(),
    );
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at).toBeNull();
  });

  it("degrades an out-of-range priority label to null instead of dying (DEF-005)", () => {
    const issue = toIssue(payload({ labels: ["p99999999999999999999"] }), config());
    expect(issue.priority).toBeNull();
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
  it("derives a terminal ref for a closed issue even with an active label (#18)", () => {
    // This is the reconciliation path: a closed issue must refresh to terminal so its
    // worker is stopped and its workspace cleaned, not kept alive by the active label.
    const ref = toStateRef(
      payload({ number: 9, state: "closed", state_reason: "completed", labels: ["In Progress"] }),
      config(),
    );
    expect(ref.state).toBe("Closed");
  });
});

describe("parseRepo error classification (via the tracker layer, no network)", () => {
  // fetchCandidateIssues parses tracker.repo BEFORE any Octokit call, so a bad repo fails with a
  // typed TrackerError without touching the network. This pins the DEF-008 classification.
  const run = (repo: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* IssueTracker;
        return yield* Effect.either(t.fetchCandidateIssues());
      }).pipe(Effect.provide(layerGitHubTracker(config({ repo })))),
    );

  it("a blank repo fails with MissingTrackerRepo (DEF-008), not TrackerUnknownPayload", async () => {
    const e = await run("   ");
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) expect(e.left._tag).toBe("MissingTrackerRepo");
  });

  it("a malformed slug (no '/') fails with TrackerUnknownPayload", async () => {
    const e = await run("not-a-slug");
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) expect(e.left._tag).toBe("TrackerUnknownPayload");
  });
});

describe("makeOctokit (#19)", () => {
  it("installs the silent logger so Octokit cannot leak unstructured lines to the console", () => {
    const octokit = makeOctokit(config());
    // Octokit merges `options.log` over its console-bound defaults; asserting identity
    // proves OUR no-op logger is the one actually installed (the default warn/error are
    // native console bindings that would corrupt the logfmt stream).
    expect(octokit.log.debug).toBe(silentOctokitLog.debug);
    expect(octokit.log.info).toBe(silentOctokitLog.info);
    expect(octokit.log.warn).toBe(silentOctokitLog.warn);
    expect(octokit.log.error).toBe(silentOctokitLog.error);
    // And they are genuine no-ops (return undefined, never throw).
    expect(octokit.log.warn("noise")).toBeUndefined();
    expect(octokit.log.error("noise")).toBeUndefined();
  });
});
