/**
 * Sprint 6 / #67 — the cockpit wire types. Plain TypeScript mirrors of the daemon's JSON
 * surface (the `toSnapshot` projection in `core/observability/snapshot.ts` and the cockpit
 * `HttpApi` in `core/cockpit/api.ts`). The browser speaks plain `fetch` + JSON — no Effect,
 * no Schema — so these are hand-kept structural mirrors. They are DOM-free on purpose so the
 * pure view-model mappers that consume them can be unit-tested under the Node test program.
 *
 * Additive contract: every block the daemon emits ONLY when relevant (`budget`, `restore`,
 * `control`, `last_activity`, …) is optional here; an absent field means "omit the panel".
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
    readonly completed: number;
    readonly claimed: number;
  };
  readonly running: ReadonlyArray<RunAttemptWire>;
  readonly retrying: ReadonlyArray<RetryEntryWire>;
  readonly completed: ReadonlyArray<string>;
  readonly recent_completed: ReadonlyArray<RecentCompletionWire>;
  readonly recent_events: ReadonlyArray<EventEnvelopeWire>;
  readonly totals: AgentTotalsWire;
  readonly rate_limits: unknown;
  readonly budget?: BudgetWire;
  readonly restore?: RestoreWire;
  readonly control?: ControlWire;
}

/** The whitelisted editable settings subset (`GET/PUT /api/v1/settings`) — no secrets. */
export interface EditableSettingsWire {
  readonly polling: { readonly interval_ms: number };
  readonly agent: {
    readonly max_concurrent_agents: number;
    readonly max_concurrent_agents_by_state: Readonly<Record<string, number>>;
    readonly max_turns: number;
    readonly max_retry_backoff_ms: number;
  };
  readonly budget: { readonly max_total_tokens: number | null };
}

/** A typed settings patch — every key optional (`PUT /api/v1/settings`). */
export interface SettingsPatchWire {
  readonly polling?: { readonly interval_ms?: number };
  readonly agent?: {
    readonly max_concurrent_agents?: number;
    readonly max_concurrent_agents_by_state?: Readonly<Record<string, number>>;
    readonly max_turns?: number;
    readonly max_retry_backoff_ms?: number;
  };
  readonly budget?: { readonly max_total_tokens?: number | null };
}

/** Result of pause/resume — the live dispatch-gate state (DD-3). */
export interface ControlStateWire {
  readonly dispatch_paused: boolean;
  readonly paused_by: "operator" | "budget" | null;
}

/** Result of retry-now / cancel — accepted or a typed no-op with a reason. */
export interface AckWire {
  readonly accepted: boolean;
  readonly reason: string | null;
}
