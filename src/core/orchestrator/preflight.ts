import { Effect } from "effect";
import type { ServiceConfig } from "../domain/workflow";
import {
  MissingTrackerApiKey,
  MissingTrackerRepo,
  type TrackerError,
  UnsupportedTrackerKind,
} from "../errors";

/**
 * Dispatch preflight validation (SPEC §6.3). Confirms the tracker config is actually
 * dispatchable before the orchestrator claims work: a supported `kind`, a `repo`, and
 * a resolved `api_key`. Run at startup and again every tick — a per-tick failure skips
 * dispatch but still lets reconciliation run (the daemon keeps observing in-flight
 * work and waits for the operator to fix config). Errors are the SPEC §11.4 tracker
 * classes; payloads never carry the secret token.
 */

/** The single supported tracker kind in v1 (GitHub Issues). */
export const SUPPORTED_TRACKER_KIND = "github";

export const preflight = (config: ServiceConfig): Effect.Effect<void, TrackerError> =>
  Effect.gen(function* () {
    const kind = config.tracker.kind?.trim().toLowerCase();
    if (kind !== SUPPORTED_TRACKER_KIND) {
      return yield* new UnsupportedTrackerKind({ kind: config.tracker.kind ?? null });
    }
    if (config.tracker.repo === undefined || config.tracker.repo.trim().length === 0) {
      return yield* new MissingTrackerRepo({
        message: "tracker.repo (owner/name) is required for kind=github",
      });
    }
    if (config.tracker.api_key === undefined || config.tracker.api_key.length === 0) {
      return yield* new MissingTrackerApiKey({ env_var: "GITHUB_TOKEN" });
    }
  });
