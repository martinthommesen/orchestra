/**
 * Canonical wire contract for `GET /api/v1/state` — the single source of truth for the
 * snapshot family types. Pure TypeScript interfaces; imports nothing (no Effect, no domain
 * types) so this module is safe to reference from both the daemon projection and the
 * browser cockpit.
 *
 * The cockpit re-exports these types from `src/cockpit/api/types.ts` using `export type`
 * so the browser bundle carries zero runtime from this module.
 */

/** The granular run-attempt phase (mirror of `domain/run-attempt.ts`). */
export type RunAttemptPhase =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

/** Last-activity breadcrumb attached to a running attempt (additive). */
export interface ActivityEntryWire {
  readonly event_tag: string;
  readonly at: string;
  readonly message?: string;
}

/** A live running attempt. */
export interface RunAttemptWire {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly attempt: number | null;
  readonly workspace_path: string;
  readonly started_at: string;
  readonly status: RunAttemptPhase;
  readonly error?: string;
  readonly turn?: number;
  readonly failure_attempts?: number;
  readonly session_id?: string | null;
  readonly last_activity?: ActivityEntryWire;
}

/** A scheduled retry. */
export interface RetryEntryWire {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly scheduled_at?: string;
  readonly delay_ms?: number;
  readonly kind?: "failure" | "continuation";
  readonly session_id?: string | null;
  readonly error: string | null;
}

/** An active issue parked after exhausting failure retries. */
export interface AbandonedIssueWire {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempts: number;
  readonly abandoned_at: string;
  readonly reason: string;
}

/** One lifecycle event in the bounded feed. */
export interface EventEnvelopeWire {
  readonly seq: number;
  readonly emitted_at: string;
  readonly level: "info" | "warn";
  readonly kind: string;
  readonly issue_id?: string;
  readonly identifier?: string;
  readonly message: string;
}

/** A rich completion-history entry. */
export interface RecentCompletionWire {
  readonly issue_id: string;
  readonly identifier: string;
  readonly finished_at: string;
  readonly outcome: string;
}

/** Aggregate token + runtime accounting. */
export interface AgentTotalsWire {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly runtime_seconds: number;
}

/** Budget guardrail status (additive — only present when a ceiling is configured). */
export interface BudgetWire {
  readonly limit_tokens: number;
  readonly spent_tokens: number;
  readonly remaining_tokens: number;
  readonly paused: boolean;
}

/** Boot-time restore summary (additive — only present after a real restore). */
export interface RestoreWire {
  readonly at: string;
  readonly orphaned_running_converted: number;
  readonly rearmed_retries: number;
  readonly restored_completed: number;
}

/** Dispatch-gate status (additive — only present when dispatch is withheld). */
export interface ControlWire {
  readonly dispatch_paused: boolean;
  readonly paused_by: "operator" | "budget";
}

/** The full `GET /api/v1/state` snapshot. */
export interface SnapshotWire {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly counts: {
    readonly running: number;
    readonly retrying: number;
    readonly abandoned: number;
    readonly completed: number;
    readonly claimed: number;
  };
  readonly running: ReadonlyArray<RunAttemptWire>;
  readonly retrying: ReadonlyArray<RetryEntryWire>;
  readonly abandoned: ReadonlyArray<AbandonedIssueWire>;
  readonly completed: ReadonlyArray<string>;
  readonly recent_completed: ReadonlyArray<RecentCompletionWire>;
  readonly recent_events: ReadonlyArray<EventEnvelopeWire>;
  readonly totals: AgentTotalsWire;
  readonly rate_limits: unknown;
  readonly budget?: BudgetWire;
  readonly restore?: RestoreWire;
  readonly control?: ControlWire;
}
