/**
 * The orchestrator core (SPEC §7–§8, Sprint 1). Pure decision logic — candidate
 * selection, concurrency, backoff, reconciliation, preflight — plus the single
 * state-owning fiber that assembles them (`loop.ts`). All implementations sit behind
 * the Sprint 0 ports, so the same loop runs on fakes (tests) or live adapters.
 */
export * from "./backoff";
export * from "./concurrency";
export * from "./loop";
export * from "./messages";
export * from "./observer";
export * from "./preflight";
export * from "./reconcile";
export * from "./selection";
export * from "./state";
