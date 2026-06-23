import { Octokit } from "@octokit/rest";
import { Effect, Layer, Option } from "effect";
import type { Issue, IssueStateRef } from "../../core/domain/issue";
import type { ServiceConfig } from "../../core/domain/workflow";
import {
  TrackerApiRequest,
  TrackerApiStatus,
  type TrackerError,
  TrackerUnknownPayload,
} from "../../core/errors";
import { IssueTracker } from "../../core/ports/issue-tracker";
import { type GitHubIssuePayload, isPullRequest, toIssue, toStateRef } from "./normalize";

/**
 * GitHub Issues adapter (Task 7, SPEC §11). Implements the read-only {@link IssueTracker}
 * port with Octokit. The Promise→Effect bridge lives here at the adapter boundary (the
 * core stays Promise-free); transport faults map to the §11.4 tagged tracker errors, and
 * the secret token is only ever handed to Octokit's `auth` — never logged or put in an
 * error payload. The GitHub→domain field mapping is the pure `normalize.ts` module.
 */

/** Parse `owner/name` from `tracker.repo`. */
const parseRepo = (repo: string): Effect.Effect<{ owner: string; repo: string }, TrackerError> => {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return Effect.fail(new TrackerUnknownPayload({ message: "tracker.repo must be 'owner/name'" }));
  }
  return Effect.succeed({ owner: parts[0] as string, repo: parts[1] as string });
};

/** Map an unknown Octokit/network failure to a tagged tracker error (no secrets). */
const mapError = (e: unknown): TrackerError => {
  const status = (e as { status?: unknown }).status;
  if (typeof status === "number") {
    const message = (e as { message?: unknown }).message;
    return new TrackerApiStatus({
      status,
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  return new TrackerApiRequest({
    message: e instanceof Error ? e.message : "GitHub request failed",
    cause: e,
  });
};

const request = <A>(thunk: () => Promise<A>): Effect.Effect<A, TrackerError> =>
  Effect.tryPromise({ try: thunk, catch: mapError });

/** Build the {@link IssueTracker} service backed by Octokit for the given config. */
export const makeGitHubTracker = (
  config: ServiceConfig,
): Effect.Effect<typeof IssueTracker.Service, never> =>
  Effect.sync(() => {
    const octokit = new Octokit({
      ...(config.tracker.api_key ? { auth: config.tracker.api_key } : {}),
      ...(config.tracker.endpoint ? { baseUrl: config.tracker.endpoint } : {}),
    });

    const list = (
      state: "open" | "closed",
    ): Effect.Effect<ReadonlyArray<GitHubIssuePayload>, TrackerError> =>
      parseRepo(config.tracker.repo ?? "").pipe(
        Effect.flatMap(({ owner, repo }) =>
          request(
            () =>
              octokit.paginate(octokit.rest.issues.listForRepo, {
                owner,
                repo,
                state,
                per_page: 100,
              }) as Promise<ReadonlyArray<GitHubIssuePayload>>,
          ),
        ),
        Effect.map((payloads) => payloads.filter((p) => !isPullRequest(p))),
      );

    const fetchCandidateIssues = (): Effect.Effect<ReadonlyArray<Issue>, TrackerError> =>
      list("open").pipe(Effect.map((payloads) => payloads.map((p) => toIssue(p, config))));

    const fetchIssuesByStates = (
      stateNames: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<Issue>, TrackerError> => {
      const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
      return list("closed").pipe(
        Effect.map((payloads) =>
          payloads
            .map((p) => toIssue(p, config))
            .filter((i) => wanted.has(i.state.trim().toLowerCase())),
        ),
      );
    };

    const fetchIssueStatesByIds = (
      issueIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<IssueStateRef>, TrackerError> =>
      parseRepo(config.tracker.repo ?? "").pipe(
        Effect.flatMap(({ owner, repo }) =>
          Effect.forEach(
            issueIds,
            (id) =>
              request(() =>
                octokit.rest.issues.get({ owner, repo, issue_number: Number(id) }),
              ).pipe(
                Effect.map((res) =>
                  Option.some(toStateRef(res.data as unknown as GitHubIssuePayload, config)),
                ),
                // A vanished/deleted issue (404) is omitted so the reconciler treats it as
                // "no longer returned" (NeitherKill); other faults still fail the refresh.
                Effect.catchTag("TrackerApiStatus", (err) =>
                  err.status === 404
                    ? Effect.succeed(Option.none<IssueStateRef>())
                    : Effect.fail(err),
                ),
              ),
            { concurrency: 8 },
          ),
        ),
        Effect.map((opts) => opts.flatMap((o) => (Option.isSome(o) ? [o.value] : []))),
      );

    return { fetchCandidateIssues, fetchIssuesByStates, fetchIssueStatesByIds };
  });

/** Layer providing the GitHub {@link IssueTracker} for a resolved config. */
export const layerGitHubTracker = (config: ServiceConfig): Layer.Layer<IssueTracker> =>
  Layer.effect(IssueTracker, makeGitHubTracker(config));
