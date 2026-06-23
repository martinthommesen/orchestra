/**
 * Orchestra core ports (SPEC seams) as Effect `Context.Tag` services. These freeze
 * the boundaries the orchestrator depends on; live adapters and test fakes provide
 * implementations from Sprint 1 onward.
 */
export * from "./agent-runner";
export * from "./clock";
export * from "./issue-tracker";
export * from "./workspace-manager";
