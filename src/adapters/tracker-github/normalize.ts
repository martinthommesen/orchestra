import {
  type BlockerRef,
  Issue,
  IssueStateRef,
  normalizeLabel,
  normalizeState,
} from "../../core/domain/issue";
import type { ServiceConfig } from "../../core/domain/workflow";

/**
 * Pure GitHub-issue → domain normalization (Task 7, SPEC §11.3). Kept separate from the
 * Octokit transport so the field mapping is unit-tested without any network. The
 * orchestrator only ever sees the normalized {@link Issue}/{@link IssueStateRef}; nothing
 * GitHub-shaped leaks past this module.
 *
 * ## Field mapping (GitHub → spec `Issue`)
 * - `number` → `id` **and** `identifier` (both the issue number as a string; the number
 *   is the stable per-repo key the reconciler re-fetches with).
 * - `title`/`body` → `title`/`description`; `html_url` → `url`.
 * - `labels[].name` → `labels` (lowercased by the {@link Issue} schema).
 * - **state** (§11.3): GitHub issues are only open/closed, so the workflow state is read
 *   from a *status label* — the first label whose name matches a configured active/terminal
 *   state wins. With no such label: open → `active_states[0]`; closed → a terminal state
 *   chosen from `state_reason` (`not_planned` → a "cancel*" terminal, else a "closed/done"
 *   terminal).
 * - **priority**: a `priority:<n>` or `p<n>` label → that integer (lower = higher priority);
 *   else `null`.
 * - **blocked_by**: parsed best-effort from the body (`blocked by #N` / `depends on #N`);
 *   blocker state is left `null` (unknown) — the §8.2 Todo-blocker rule treats that as
 *   unresolved. Empty when none are referenced.
 */

/** The slice of a GitHub REST issue payload this adapter consumes. */
export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly state_reason?: string | null;
  readonly labels: ReadonlyArray<string | { readonly name?: string | null }>;
  readonly html_url?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  /** Present only when the "issue" is actually a pull request. */
  readonly pull_request?: unknown;
}

/** A GitHub issues-list entry is a PR iff it carries a `pull_request` member. */
export const isPullRequest = (p: GitHubIssuePayload): boolean => p.pull_request !== undefined;

/** Flatten GitHub's `string | { name }` label shapes to non-empty names. */
export const labelNames = (p: GitHubIssuePayload): ReadonlyArray<string> =>
  p.labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((n): n is string => n.length > 0);

const PRIORITY_LABEL = /^(?:priority:\s*|p)(\d+)$/i;

/** First `priority:<n>` / `p<n>` label → integer, else `null`. */
export const derivePriority = (labels: ReadonlyArray<string>): number | null => {
  for (const label of labels) {
    const m = PRIORITY_LABEL.exec(label.trim());
    if (m?.[1] !== undefined) {
      return Number.parseInt(m[1], 10);
    }
  }
  return null;
};

const BLOCKED_BY = /(?:blocked by|depends on)\s+#(\d+)/gi;

/** Best-effort blocker refs parsed from the issue body (state unknown ⇒ `null`). */
export const deriveBlockedBy = (body: string): ReadonlyArray<BlockerRef> => {
  const seen = new Set<string>();
  const out: BlockerRef[] = [];
  for (const m of body.matchAll(BLOCKED_BY)) {
    const n = m[1];
    if (n !== undefined && !seen.has(n)) {
      seen.add(n);
      out.push({ id: n, identifier: `#${n}`, state: null });
    }
  }
  return out;
};

const findMatching = (states: ReadonlyArray<string>, re: RegExp): string | undefined =>
  states.find((s) => re.test(s));

/** Pick the terminal state a closed issue maps to, from its `state_reason`. */
export const deriveClosedState = (
  config: ServiceConfig,
  reason: string | null | undefined,
): string => {
  const terminals = config.tracker.terminal_states;
  const fallback = terminals[0] ?? "Closed";
  if (reason === "not_planned") {
    return findMatching(terminals, /cancel/i) ?? findMatching(terminals, /closed/i) ?? fallback;
  }
  return findMatching(terminals, /closed/i) ?? findMatching(terminals, /done/i) ?? fallback;
};

/** Derive the workflow state per the §11.3 rules documented above. */
export const deriveState = (p: GitHubIssuePayload, config: ServiceConfig): string => {
  const stateByLabel = new Map<string, string>();
  for (const s of [...config.tracker.active_states, ...config.tracker.terminal_states]) {
    stateByLabel.set(normalizeState(s), s);
  }
  for (const label of labelNames(p)) {
    const hit = stateByLabel.get(normalizeState(label));
    if (hit !== undefined) {
      return hit;
    }
  }
  if (p.state === "closed") {
    return deriveClosedState(config, p.state_reason ?? null);
  }
  return config.tracker.active_states[0] ?? "Todo";
};

const toDate = (iso: string | null | undefined): Date | null =>
  iso === null || iso === undefined ? null : new Date(iso);

/** Normalize a full GitHub issue payload into the domain {@link Issue}. */
export const toIssue = (p: GitHubIssuePayload, config: ServiceConfig): Issue => {
  const labels = labelNames(p);
  return Issue.make({
    id: String(p.number),
    identifier: String(p.number),
    title: p.title,
    description: p.body ?? null,
    priority: derivePriority(labels),
    state: deriveState(p, config),
    branch_name: null,
    url: p.html_url ?? null,
    labels: labels.map(normalizeLabel),
    blocked_by: deriveBlockedBy(p.body ?? ""),
    created_at: toDate(p.created_at),
    updated_at: toDate(p.updated_at),
  });
};

/** Normalize a payload into the lightweight {@link IssueStateRef} used by reconciliation. */
export const toStateRef = (p: GitHubIssuePayload, config: ServiceConfig): IssueStateRef =>
  IssueStateRef.make({
    id: String(p.number),
    identifier: String(p.number),
    state: deriveState(p, config),
    labels: labelNames(p).map(normalizeLabel),
  });
