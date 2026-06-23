import { Context, type Stream } from "effect";
import type { AgentEvent } from "../domain/agent-event";
import type { Issue } from "../domain/issue";
import type { AgentError } from "../errors";

/**
 * Parameters for one agent run (SPEC §10.7). The workspace is already prepared by
 * the {@link file://./workspace-manager.ts WorkspaceManager}; the runner receives
 * the validated path, the rendered prompt, and optional continuation info.
 */
export interface AgentRunParams {
  readonly issue: Issue;
  /** Absolute workspace path; the runner MUST launch with `cwd == workspacePath` (§9.5). */
  readonly workspacePath: string;
  /** Fully rendered prompt for a first turn; continuation guidance for a resumed thread. */
  readonly prompt: string;
  /** `null` on first attempt; integer on retry/continuation (SPEC §5.4). */
  readonly attempt: number | null;
  /** When present, continue an existing agent thread instead of starting fresh (SPEC §7.1). */
  readonly resume?: { readonly sessionId: string };
}

/**
 * Agent-runner port (SPEC §10). Wraps workspace + prompt + agent session and
 * streams normalized {@link AgentEvent}s upstream to the orchestrator; any error
 * fails the attempt (the orchestrator retries). v1 is a Copilot subprocess
 * (see `docs/sprint-0/spike-copilot.md`); both subprocess and a future in-process
 * SDK stay behind this port. Signatures only — no implementation in Sprint 0.
 */
export class AgentRunner extends Context.Tag("orchestra/AgentRunner")<
  AgentRunner,
  {
    /** Run one agent session, streaming events until a terminal event or error. */
    readonly run: (params: AgentRunParams) => Stream.Stream<AgentEvent, AgentError>;
  }
>() {}
