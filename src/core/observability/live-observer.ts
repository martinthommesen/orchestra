import { Effect, Layer } from "effect";
import type { Observation } from "../orchestrator/observer";
import { Observer } from "../orchestrator/observer";
import { glyph, truncate } from "./glyphs";

/**
 * Live {@link Observer} (Task 12, SPEC §13.1) — renders each orchestrator
 * {@link Observation} as one structured `key=value` log line (the CLI installs
 * `Logger.logFmt`), carrying the required context fields (`issue_id`,
 * `issue_identifier`, `session_id`) and Milo's status glyphs. The formatting is split
 * into the pure {@link formatObservation} so it can be unit-tested without a logger,
 * and so the same vocabulary can feed the JSON snapshot / a future TUI.
 *
 * Truncation (`truncate`) keeps one event on one line and bounds log size; we never log
 * tokens (no Observation carries one — preflight errors are pre-scrubbed).
 */

/** A logger-agnostic description of one observation line. */
export interface LogLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly annotations: Record<string, string>;
}

const ev = (event: string, rest: Record<string, string> = {}): Record<string, string> => ({
  event,
  ...rest,
});

/** Pure {@link Observation} → {@link LogLine}. Exhaustive over the union. */
export const formatObservation = (obs: Observation): LogLine => {
  switch (obs._tag) {
    case "Started":
      return {
        level: "info",
        message: "orchestrator started",
        annotations: ev("started", {
          poll_interval_ms: String(obs.pollIntervalMs),
          max_concurrent: String(obs.maxConcurrent),
        }),
      };
    case "StartupCleanup":
      return {
        level: "info",
        message: `startup cleanup removed ${obs.removed.length} workspace(s)`,
        annotations: ev("startup_cleanup", { removed: obs.removed.join(",") }),
      };
    case "RestoredAfterRestart":
      return {
        level: "info",
        message:
          `restored after restart: ${obs.orphanedRunningConverted} running, ` +
          `${obs.reArmedRetries} retrying, ${obs.restoredCompleted} completed`,
        annotations: ev("restored", {
          orphaned_running_converted: String(obs.orphanedRunningConverted),
          rearmed_retries: String(obs.reArmedRetries),
          restored_completed: String(obs.restoredCompleted),
        }),
      };
    case "TickStart":
      return { level: "info", message: "tick start", annotations: ev("tick_start") };
    case "TickEnd":
      return {
        level: "info",
        message: `tick end (dispatched ${obs.dispatched.length})`,
        annotations: ev("tick_end", {
          dispatched: obs.dispatched.join(","),
          dispatch_skipped: String(obs.dispatchSkipped),
        }),
      };
    case "Reconciled":
      return {
        level: "info",
        message: `reconciled ${obs.actions.length} action(s)`,
        annotations: ev("reconciled", {
          actions: obs.actions.map((a) => `${a._tag}:${a.issueId}`).join(","),
        }),
      };
    case "Dispatched":
      return {
        level: "info",
        message: `${glyph("running")} dispatch ${obs.identifier} turn=${obs.turn}`,
        annotations: ev("dispatched", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
          attempt: obs.attempt === null ? "" : String(obs.attempt),
          turn: String(obs.turn),
          resumed: String(obs.resumed),
        }),
      };
    case "AgentEvent":
      return {
        level: "info",
        message: `${glyph("running")} ${obs.identifier} ${obs.eventTag}`,
        annotations: ev("agent_event", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
          session_id: obs.sessionId ?? "",
          event_tag: obs.eventTag,
        }),
      };
    case "WorkerCompleted":
      return {
        level: "info",
        message: `${glyph("done")} completed ${obs.identifier}`,
        annotations: ev("worker_completed", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
        }),
      };
    case "WorkerFailed":
      return {
        level: "warn",
        message: `${glyph("failed")} failed ${obs.identifier}: ${truncate(obs.message)}`,
        annotations: ev("worker_failed", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
          message: truncate(obs.message),
        }),
      };
    case "WorkerKilled":
      return {
        level: "warn",
        message: `${glyph("failed")} killed ${obs.issueId} (${obs.reason})`,
        annotations: ev("worker_killed", { issue_id: obs.issueId, reason: obs.reason }),
      };
    case "WorkspaceCleaned":
      return {
        level: "info",
        message: `cleaned workspace ${obs.identifier}`,
        annotations: ev("workspace_cleaned", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
        }),
      };
    case "RetryScheduled":
      return {
        level: "info",
        message: `${glyph("retrying")} retry ${obs.identifier} in ${obs.delayMs}ms (${obs.kind})`,
        annotations: ev("retry_scheduled", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
          kind: obs.kind,
          attempt: String(obs.attempt),
          delay_ms: String(obs.delayMs),
        }),
      };
    case "RetryFired":
      return {
        level: "info",
        message: `${glyph("retrying")} retry fired ${obs.identifier}`,
        annotations: ev("retry_fired", {
          issue_id: obs.issueId,
          issue_identifier: obs.identifier,
        }),
      };
    case "PreflightFailed":
      return {
        level: "warn",
        message: `preflight failed: ${truncate(obs.reason)}`,
        annotations: ev("preflight_failed", { reason: truncate(obs.reason) }),
      };
    case "TrackerError":
      return {
        level: "warn",
        message: `tracker error (${obs.op}): ${truncate(obs.message)}`,
        annotations: ev("tracker_error", { op: obs.op, message: truncate(obs.message) }),
      };
    case "BudgetExceeded":
      return obs.paused
        ? {
            level: "warn",
            message: `${glyph("blocked")} budget reached: dispatch paused (${obs.spentTokens}/${obs.limitTokens} tokens)`,
            annotations: ev("budget_paused", {
              paused: "true",
              spent_tokens: String(obs.spentTokens),
              limit_tokens: String(obs.limitTokens),
            }),
          }
        : {
            level: "info",
            message: `budget cleared: dispatch resumed (${obs.spentTokens}/${obs.limitTokens} tokens)`,
            annotations: ev("budget_resumed", {
              paused: "false",
              spent_tokens: String(obs.spentTokens),
              limit_tokens: String(obs.limitTokens),
            }),
          };
  }
};

/**
 * Log one observation as a structured logfmt line (the canonical {@link ObserverLive}
 * behavior). Extracted so the {@link file://./observer-tee.ts tee observer} can preserve
 * logging byte-for-byte while *also* appending to the recent-events ring.
 */
export const logObservation = (obs: Observation): Effect.Effect<void> => {
  const line = formatObservation(obs);
  const log =
    line.level === "warn" ? Effect.logWarning(line.message) : Effect.logInfo(line.message);
  return log.pipe(Effect.annotateLogs(line.annotations));
};

/** Live observer layer: format each observation and log it as a structured line. */
export const ObserverLive: Layer.Layer<Observer> = Layer.succeed(Observer, {
  emit: logObservation,
});
