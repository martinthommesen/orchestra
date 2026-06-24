import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Schedule } from "effect";
import { describe, expect } from "vitest";
import { runCockpit } from "../src/core/cockpit/server";
import { RunAttempt } from "../src/core/domain/run-attempt";
import { BudgetConfig } from "../src/core/domain/workflow";
import { ControlStatusLive } from "../src/core/observability/control-status";
import { LiveActivityLive } from "../src/core/observability/live-activity";
import { LiveBudgetLive } from "../src/core/observability/live-budget";
import { RecentCompletionsLive } from "../src/core/observability/recent-completions";
import { RecentEventsLive } from "../src/core/observability/recent-events";
import { RestoreStatusLive } from "../src/core/observability/restore-status";
import { toSnapshot } from "../src/core/observability/snapshot";
import { evaluateBudget } from "../src/core/orchestrator/budget";
import { CommandBus, CommandBusLive } from "../src/core/orchestrator/command";
import {
  initialState,
  makeOrchestratorStore,
  OrchestratorStore,
  setRunning,
} from "../src/core/orchestrator/state";
import { buildDef } from "./fakes/harness";

/**
 * Sprint 6 / #65 — the cockpit `HttpApi` server, end-to-end over a real loopback socket.
 *
 * Proves the four contracts that matter for the control plane:
 *   1. `GET /api/v1/state` is **byte-identical** to `JSON.stringify(toSnapshot(...))` (DD-1);
 *   2. a mutating endpoint with no/bad token → **401** (DD-5 auth);
 *   3. a mutating endpoint with a good token but a **cross-origin** `Origin` → **403** (DD-5);
 *   4. a well-formed authorized command flows over the {@link CommandBus} and returns the
 *      owner fiber's `CommandResult` mapped to the wire shape;
 *   5. with no SPA built (Phase-1 reality), a non-API route degrades to a graceful **404**.
 */

/** A low-entropy, obviously-fake fixture token (never a real secret). */
const FIXTURE_TOKEN = "loopback-operator-test"; // gitleaks:allow — fake test fixture, not a secret
const FIXTURE_ENV = { ORCHESTRA_COCKPIT_TOKEN: FIXTURE_TOKEN } as const;
/** A static root that does not exist → the SPA index is absent → graceful 404. */
const ABSENT_STATIC_DIR = "/orchestra-cockpit-absent-dir";

const config = buildDef({ intervalMs: 5000, maxConcurrent: 4 }).config;

const seededState = () =>
  setRunning(
    initialState(config),
    RunAttempt.make({
      issue_id: "42",
      issue_identifier: "#42",
      attempt: null,
      workspace_path: "/tmp/ws/42",
      started_at: new Date("2024-01-01T00:00:00.000Z"),
      status: "StreamingTurn",
    }),
  );

/** Grab a free loopback TCP port, then release it for the server to claim. */
const freePort = Effect.async<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close(() => resume(Effect.succeed(port)));
  });
});

/** The orchestrator-scope context the cockpit reads (store + rings + control + bus). */
const cockpitContext = (state = seededState()) =>
  Layer.mergeAll(
    Layer.effect(OrchestratorStore, makeOrchestratorStore(state)),
    RecentEventsLive,
    RecentCompletionsLive,
    LiveActivityLive,
    RestoreStatusLive,
    ControlStatusLive,
    LiveBudgetLive(BudgetConfig.make({})),
    CommandBusLive,
  );

/** Boot the cockpit on a free port and return the bound port once it is listening. */
const bootCockpit = (port: number) =>
  Effect.forkScoped(
    runCockpit({
      port,
      workflowPath: `${ABSENT_STATIC_DIR}/WORKFLOW.md`,
      env: FIXTURE_ENV,
      staticDir: ABSENT_STATIC_DIR,
    }),
  );

/** Retry a fetch until the forked listener is bound. */
const fetchWhenUp = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }));

/**
 * A raw loopback GET that sets an arbitrary `Host` header — `undici`'s `fetch` forbids
 * overriding `Host`, so the DNS-rebinding guard (which keys off exactly that header) needs the
 * low-level client to forge it.
 */
const rawGet = (port: number, path: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("cockpit GET /api/v1/state", () => {
  it.scopedLive("is byte-identical to JSON.stringify(toSnapshot(...))", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const state = seededState();
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext(state)));

      const body = yield* fetchWhenUp(() =>
        fetch(`http://127.0.0.1:${port}/api/v1/state`).then((r) => r.text()),
      );

      const expected = JSON.stringify(
        toSnapshot(state, {
          recentEvents: [],
          recentCompleted: [],
          activity: new Map(),
          budget: evaluateBudget(BudgetConfig.make({}), state.agent_totals),
          operatorPaused: false,
        }),
      );
      expect(body).toBe(expected);
    }),
  );
});

describe("cockpit auth (DD-5)", () => {
  it.scopedLive("rejects a mutating request with no token → 401", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      const status = yield* fetchWhenUp(() =>
        fetch(`http://127.0.0.1:${port}/api/v1/control/pause`, { method: "POST" }).then(
          (r) => r.status,
        ),
      );
      expect(status).toBe(401);
    }),
  );

  it.scopedLive("rejects a good token from a cross-origin page → 403", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      const status = yield* fetchWhenUp(() =>
        fetch(`http://127.0.0.1:${port}/api/v1/control/pause`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${FIXTURE_TOKEN}`,
            origin: "http://evil.example.com",
          },
        }).then((r) => r.status),
      );
      expect(status).toBe(403);
    }),
  );
});

describe("cockpit control command flow", () => {
  it.scopedLive("authorized pause flows over the CommandBus and returns the wire result", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      // Memoize so the cockpit and the stand-in owner fiber share ONE CommandBus instance.
      const context = yield* Layer.memoize(cockpitContext());
      yield* bootCockpit(port).pipe(Effect.provide(context));

      // Stand in for the owner fiber: drain the bus and ack with a Control result.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const bus = yield* CommandBus;
          yield* bus.take.pipe(
            Effect.flatMap(({ reply }) =>
              Deferred.succeed(reply, {
                _tag: "Control",
                state: { dispatchPaused: true, pausedBy: "operator" },
              }),
            ),
            Effect.forever,
          );
        }).pipe(Effect.provide(context)),
      );

      const body = yield* fetchWhenUp(() =>
        fetch(`http://127.0.0.1:${port}/api/v1/control/pause`, {
          method: "POST",
          headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
        }).then((r) => r.json()),
      );
      expect(body).toEqual({ dispatch_paused: true, paused_by: "operator" });
    }),
  );
});

describe("cockpit DNS-rebinding guard (DD-5)", () => {
  it.scopedLive("rejects a non-loopback Host on a token-free read → 403", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      // A DNS-rebinding page re-resolves its name to 127.0.0.1 but still carries its own Host.
      // The single chokepoint guard rejects it before the read ever runs — even though the read
      // is token-free.
      const status = yield* fetchWhenUp(() => rawGet(port, "/api/v1/state", "attacker.example"));
      expect(status).toBe(403);
    }),
  );

  it.scopedLive("rejects a non-loopback Host on a static path → 403", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      const status = yield* fetchWhenUp(() => rawGet(port, "/", "attacker.example"));
      expect(status).toBe(403);
    }),
  );

  it.scopedLive("still serves a loopback Host (127.0.0.1:<port>) → 200", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      const status = yield* fetchWhenUp(() => rawGet(port, "/api/v1/state", `127.0.0.1:${port}`));
      expect(status).toBe(200);
    }),
  );
});

describe("cockpit static fallback (DD-8)", () => {
  it.scopedLive("serves a graceful 404 for a non-API route when the SPA is not built", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      yield* bootCockpit(port).pipe(Effect.provide(cockpitContext()));

      const res = yield* fetchWhenUp(() =>
        fetch(`http://127.0.0.1:${port}/`).then(async (r) => ({
          status: r.status,
          text: await r.text(),
        })),
      );
      expect(res.status).toBe(404);
      expect(res.text).toContain("/api/v1");
    }),
  );
});
