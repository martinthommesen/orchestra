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
 *   from a *status label* — but with a strict **precedence** (#18):
 *     1. A `closed` GitHub issue is an explicit terminal signal and ALWAYS maps to a
 *        terminal state, even if it still carries a lingering *active* status label (a
 *        closed issue whose worker would otherwise keep running). A *terminal* status
 *        label still selects *which* terminal state (Done vs Cancelled); otherwise the
 *        terminal state is derived from `state_reason` (`not_planned` → a "cancel*"
 *        terminal, else a "closed/done" terminal).
 *     2. For an `open` issue, the first label whose name matches a configured
 *        active/terminal state wins.
 *     3. An `open` issue with no such label → `active_states[0]`.
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
      const n = Number.parseInt(m[1], 10);
      // An author-controlled label like `p99999999999999999999` overflows the safe-integer
      // range; the `Issue` schema's `Schema.Int` rejects it, which would turn `Issue.make`
      // into an uncaught defect (Die) that crashes the whole poll tick. Treat an
      // out-of-range priority as absent so one malformed issue degrades gracefully.
      return Number.isSafeInteger(n) ? n : null;
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
  // Precedence 1 (#18): a `closed` GitHub issue is terminal regardless of any lingering
  // *active* status label — `closed` is an explicit terminal signal and must win, or the
  // worker for a closed issue would never be stopped/cleaned. A *terminal* status label is
  // still honored to choose which terminal state (Done vs Cancelled); otherwise we derive
  // it from `state_reason`.
  if (p.state === "closed") {
    const terminalByLabel = new Map<string, string>();
    for (const s of config.tracker.terminal_states) {
      terminalByLabel.set(normalizeState(s), s);
    }
    for (const label of labelNames(p)) {
      const hit = terminalByLabel.get(normalizeState(label));
      if (hit !== undefined) {
        return hit;
      }
    }
    return deriveClosedState(config, p.state_reason ?? null);
  }
  // Precedence 2: an open issue reads its state from a status label, with TERMINAL/handoff
  // labels winning over ACTIVE ones regardless of GitHub's label order. This makes a handoff
  // robust (#79): an issue moved to e.g. `Human Review` that still carries a lingering active
  // label (`Todo`/`In Progress`) stops dispatch instead of normalizing back to active and
  // re-running already-finished work — the same terminal-wins precedence a closed issue gets.
  const labels = labelNames(p);
  const matchFirst = (states: ReadonlyArray<string>): string | undefined => {
    const byLabel = new Map(states.map((s) => [normalizeState(s), s] as const));
    for (const label of labels) {
      const hit = byLabel.get(normalizeState(label));
      if (hit !== undefined) {
        return hit;
      }
    }
    return undefined;
  };
  // Precedence 3: open with no status label → first active state.
  return (
    matchFirst(config.tracker.terminal_states) ??
    matchFirst(config.tracker.active_states) ??
    config.tracker.active_states[0] ??
    "Todo"
  );
};

const toDate = (iso: string | null | undefined): Date | null => {
  if (iso === null || iso === undefined) {
    return null;
  }
  // A non-parseable timestamp yields an `Invalid Date`, which the `Issue` schema's
  // `Schema.Date` rejects — turning `Issue.make` into an uncaught defect (Die) that would
  // crash the poll tick instead of degrading. Map an unparseable date to `null` (the field
  // is already `NullOr(Date)`), so one malformed payload can't take down polling.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

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
