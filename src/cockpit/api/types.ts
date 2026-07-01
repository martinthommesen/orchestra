/**
 * Sprint 6 / #67 — the cockpit wire types. Plain TypeScript mirrors of the daemon's JSON
 * surface. The browser speaks plain `fetch` + JSON — no Effect, no Schema — so these are
 * DOM-free on purpose so the pure view-model mappers that consume them can be unit-tested
 * under the Node test program.
 *
 * **Snapshot-family types** (`SnapshotWire` and its sub-types) are re-exported from the
 * daemon projection contract (`core/observability/snapshot-wire`) — the single source of
 * truth for the `GET /api/v1/state` wire shape. The cockpit derives its types from the
 * daemon; there are no hand-kept mirror copies here.
 *
 * **HttpApi request/response types** (`EditableSettingsWire`, `SettingsPatchWire`,
 * `ControlStateWire`, `AckWire`) mirror `core/cockpit/api.ts` (a Schema-based `HttpApi`)
 * and remain hand-declared here to avoid pulling Effect `Schema` types into the browser.
 *
 * Additive contract: every block the daemon emits ONLY when relevant (`budget`, `restore`,
 * `control`, `last_activity`, …) is optional here; an absent field means "omit the panel".
 */

// Re-export the snapshot-family wire types from the daemon contract (single source of truth).
export type {
  AbandonedIssueWire,
  ActivityEntryWire,
  AgentTotalsWire,
  BudgetWire,
  ControlWire,
  EventEnvelopeWire,
  RecentCompletionWire,
  RestoreWire,
  RetryEntryWire,
  RunAttemptPhase,
  RunAttemptWire,
  SnapshotWire,
} from "../../core/observability/snapshot-wire";

/** The whitelisted editable settings subset (`GET/PUT /api/v1/settings`) — no secrets. */
export interface EditableSettingsWire {
  readonly polling: { readonly interval_ms: number };
  readonly agent: {
    readonly max_concurrent_agents: number;
    readonly max_concurrent_agents_by_state: Readonly<Record<string, number>>;
    readonly max_turns: number;
    readonly max_failure_retries: number;
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
    readonly max_failure_retries?: number;
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
