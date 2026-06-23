import { createServer } from "node:http";
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, type Scope } from "effect";
import type { OrchestratorState } from "../domain/orchestrator-state";
import { OrchestratorStore } from "../orchestrator/state";

/**
 * Optional JSON snapshot API (Task 12, SPEC §13.3/§13.7). When the CLI is given
 * `--port N`, this exposes a single read-only endpoint — `GET /api/v1/state` — bound to
 * **loopback only** (`127.0.0.1`), returning the orchestrator's live running/retrying/
 * totals/rate-limit view. It reads the same authoritative {@link OrchestratorStore} the
 * owner fiber writes (a serialized `Ref.get`), so it never mutates state and never races
 * the fiber. Served via `@effect/platform` so it stays inside Effect (no Promise escape)
 * and is torn down with the orchestrator scope.
 */

/** JSON-friendly projection of the authoritative state (Dates → ISO via JSON). */
export const toSnapshot = (s: OrchestratorState) => {
  const running = Object.values(s.running);
  const retrying = Object.values(s.retry_attempts);
  return {
    poll_interval_ms: s.poll_interval_ms,
    max_concurrent_agents: s.max_concurrent_agents,
    counts: {
      running: running.length,
      retrying: retrying.length,
      completed: s.completed.length,
      claimed: s.claimed.length,
    },
    running,
    retrying,
    completed: s.completed,
    totals: s.agent_totals,
    rate_limits: s.agent_rate_limits,
  };
};

const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/api/v1/state",
    Effect.gen(function* () {
      const store = yield* OrchestratorStore;
      const state = yield* store.get;
      return yield* HttpServerResponse.json(toSnapshot(state)).pipe(Effect.orDie);
    }),
  ),
);

/**
 * Run the snapshot server on `127.0.0.1:<port>` until interrupted. Fork this into the
 * orchestrator scope alongside the loop; reads {@link OrchestratorStore} from context.
 */
export const runSnapshotServer = (
  port: number,
): Effect.Effect<void, never, Scope.Scope | OrchestratorStore> =>
  HttpServer.serveEffect(router).pipe(
    // `serveEffect` installs the server and returns; the listener lives for as long as
    // the provided layer's scope stays open, so we idle (`Effect.never`) to keep it bound
    // for the lifetime of the orchestrator (interrupting the fiber tears it down cleanly).
    Effect.zipRight(Effect.never),
    Effect.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })),
    // A bind failure (e.g. port in use) must not take down orchestration — log and idle.
    Effect.catchAll((error) =>
      Effect.logError(`snapshot server failed to bind on 127.0.0.1:${port}`).pipe(
        Effect.annotateLogs({ event: "snapshot_server_error", message: String(error) }),
        Effect.zipRight(Effect.never),
      ),
    ),
  );
