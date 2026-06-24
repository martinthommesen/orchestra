import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { type FileSystem, HttpApiBuilder, type HttpApp, HttpServerRequest } from "@effect/platform";
import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { ControlStatus } from "../observability/control-status";
import type { LiveActivity } from "../observability/live-activity";
import type { LiveBudget } from "../observability/live-budget";
import type { RecentCompletions } from "../observability/recent-completions";
import type { RecentEvents } from "../observability/recent-events";
import type { RestoreStatus } from "../observability/restore-status";
import type { CommandBus } from "../orchestrator/command";
import type { OrchestratorStore } from "../orchestrator/state";
import { WorkflowFileLive } from "../workflow/workflow-file";
import { CockpitAuthLive } from "./auth";
import { cockpitApiLive } from "./handlers";
import { makeStaticHandler } from "./static";
import { type CockpitToken, cockpitTokenLayer, logToken, resolveToken } from "./token";

/**
 * Sprint 6 / #65 — run the **cockpit** on `127.0.0.1:<port>` until interrupted (DD-1/DD-5/
 * DD-8). This replaces the old hand-rolled snapshot server outright: one typed `CockpitApi`
 * serves the byte-compatible `GET /api/v1/state` read plus the token-gated mutating
 * endpoints, and a same-origin static layer serves the Vite-built SPA from `dist/cockpit/`
 * with an `index.html` fallback (graceful 404 until Phase 2 builds it).
 *
 * Forked into the orchestrator scope alongside the loop; it reads the authoritative store,
 * the observability rings, and the {@link CommandBus} from context. The per-process auth
 * token is resolved + logged once at startup. A bind failure (e.g. port in use) must not
 * take down orchestration — we log and idle.
 */

/** Default static root: `dist/cockpit/`, resolved relative to the bundled CLI entry. */
const defaultStaticDir = (): string => fileURLToPath(new URL("../cockpit", import.meta.url));

export interface RunCockpitOptions {
  readonly port: number;
  /** Path to the live `WORKFLOW.md` — the settings read/persist target (#66, DD-4). */
  readonly workflowPath: string;
  /** Override the static asset root (tests point this at a temp dir; default `dist/cockpit/`). */
  readonly staticDir?: string;
  /** Override the env used to resolve the token (tests inject a fixed token). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const runCockpit = (
  options: RunCockpitOptions,
): Effect.Effect<
  void,
  never,
  | OrchestratorStore
  | RecentEvents
  | RecentCompletions
  | LiveActivity
  | RestoreStatus
  | ControlStatus
  | LiveBudget
  | CommandBus
> =>
  Effect.gen(function* () {
    const { port } = options;
    const resolved = resolveToken(options.env);
    yield* logToken(resolved);

    const serveStatic = makeStaticHandler(options.staticDir ?? defaultStaticDir());

    /**
     * `serve` middleware (DD-8): API requests (`/api/...`) run the typed app; everything else
     * is served by the static handler (SPA `index.html` fallback + token injection). Splitting
     * on the path keeps one server/one origin while the API owns its own 404s for `/api/*`.
     */
    const withStatic = (
      apiApp: HttpApp.Default,
    ): HttpApp.Default<never, FileSystem.FileSystem | CockpitToken> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return request.url.startsWith("/api/") ? yield* apiApp : yield* serveStatic(request.url);
      });

    const serveLayer = HttpApiBuilder.serve(withStatic).pipe(
      Layer.provide(cockpitApiLive()),
      Layer.provide(WorkflowFileLive(options.workflowPath)),
      Layer.provide(CockpitAuthLive),
      Layer.provide(cockpitTokenLayer(resolved.token)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })),
    );

    yield* Layer.launch(serveLayer).pipe(
      Effect.catchAll((error) =>
        Effect.logError(`cockpit failed to bind on 127.0.0.1:${port}`).pipe(
          Effect.annotateLogs({ event: "cockpit_server_error", message: String(error) }),
          Effect.zipRight(Effect.never),
        ),
      ),
    );
  });
