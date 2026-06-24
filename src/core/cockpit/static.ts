import * as nodePath from "node:path";
import { FileSystem, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { CockpitToken, injectToken } from "./token";

/**
 * Sprint 6 / #65 — static serving of the Vite-built SPA (DD-8). The daemon serves
 * `dist/cockpit/` at `/`, same-origin, with an `index.html` SPA fallback for client routes
 * and the per-process token injected into the served index (so the SPA reads it without a
 * round-trip). It uses the existing `@effect/platform` `FileSystem` — **no new serving dep**.
 *
 * Phase 1 ships before the SPA exists (the dir won't be built until Phase 2). When the
 * directory or its `index.html` is absent the handler degrades gracefully to a 404 with a
 * short hint, never crashing the server.
 */

/** Minimal extension → content-type map for the assets a Vite build emits. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const contentType = (path: string): string =>
  CONTENT_TYPES[nodePath.extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * Resolve a request URL to a safe absolute path under `root`, or null on traversal. The
 * leading `/` is stripped, the query/hash dropped, and the result must stay within `root`.
 */
export const resolveAssetPath = (root: string, url: string): string | null => {
  const pathname = decodeURIComponent((url.split("?")[0] ?? "").split("#")[0] ?? "");
  const rel = pathname.replace(/^\/+/, "");
  const abs = nodePath.resolve(root, rel);
  const rootResolved = nodePath.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + nodePath.sep)) {
    return null;
  }
  return abs;
};

/**
 * Build the static handler bound to `staticDir`. Returns an effect (per request) that
 * serves a concrete asset when one matches, else the token-injected `index.html` SPA
 * fallback, else a graceful 404. Never fails — file errors collapse to the fallback/404.
 */
export const makeStaticHandler = (staticDir: string) => {
  const indexPath = nodePath.join(staticDir, "index.html");

  const serveIndex: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    FileSystem.FileSystem | CockpitToken
  > = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { token } = yield* CockpitToken;
    const html = yield* fs.readFileString(indexPath).pipe(Effect.option);
    if (html._tag === "None") {
      return HttpServerResponse.text(
        "cockpit assets not built (run `pnpm build`); the JSON API is available under /api/v1",
        { status: 404, contentType: "text/plain; charset=utf-8" },
      );
    }
    return HttpServerResponse.text(injectToken(html.value, token), {
      contentType: "text/html; charset=utf-8",
    });
  });

  return (
    url: string,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    FileSystem.FileSystem | CockpitToken
  > =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const abs = resolveAssetPath(staticDir, url);
      // A bare route ("/", "/kanban", …) or a traversal attempt → the SPA index fallback.
      if (abs === null || abs === nodePath.resolve(staticDir) || nodePath.extname(abs) === "") {
        return yield* serveIndex;
      }
      const stat = yield* fs.stat(abs).pipe(Effect.option);
      if (stat._tag === "None" || stat.value.type !== "File") {
        return yield* serveIndex;
      }
      // index.html is the only asset whose bytes we rewrite (token injection).
      if (abs === indexPath) {
        return yield* serveIndex;
      }
      const bytes = yield* fs.readFile(abs).pipe(Effect.option);
      if (bytes._tag === "None") {
        return yield* serveIndex;
      }
      return HttpServerResponse.uint8Array(bytes.value, { contentType: contentType(abs) });
    });
};
