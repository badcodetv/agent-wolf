import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import type { Logger } from "./logger.js";
import type { WolfConfig } from "./config.js";
import { WolfError } from "./errors.js";
import { createWolfMcp, originFromMcpUrl } from "./mcp/server.js";
import { createMarketDataAccess } from "./mcp/tools.js";
import { assertSessionConfigured } from "./auth/session.js";
import { createBobClient } from "./bob/client.js";
import { createHypothesisStore } from "./hypothesis/store.js";
import { createAuthRouter } from "./routes/auth.js";
import { createHypothesesRouter } from "./routes/hypotheses.js";
import { createEmbedRouter } from "./routes/embed.js";
import { createSeriesRouter } from "./routes/series.js";
import { createArtifactsRouter } from "./routes/artifacts.js";
import { createReportRouter } from "./routes/report.js";

/**
 * The body-parser failures that are the CALLER'S, each carrying a `type` and
 * its own HTTP status (`raw-body/index.js`, `body-parser/lib/read.js`).
 *
 * All three are the same family: the request never became a body. Left
 * unclassified they fall through to `internal` and tell the caller the SERVER
 * has a bug — which is the R39 rule inverted. `entity.parse.failed` is
 * malformed JSON (400) and `charset.unsupported` an unusable charset (415);
 * `entity.too.large` (413) is the one W21 met, on a report template between
 * `express.json()`'s old 100kb default and `WOLF_REPORT_MAX_BYTES`.
 *
 * Duck-typed rather than imported: `body-parser` is a transitive dependency of
 * Express here, not a declared one, and `api/`'s import boundary is checked.
 */
const BODY_PARSER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "entity.too.large",
  "entity.parse.failed",
  "charset.unsupported",
]);

function bodyParserStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const type = (err as { type?: unknown }).type;
  if (typeof type !== "string" || !BODY_PARSER_ERROR_TYPES.has(type)) return undefined;
  // Its own status when it is a plausible client status, 400 otherwise. The
  // object is not ours, so its `status` is read defensively rather than
  // trusted into a response code.
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 499
    ? status
    : 400;
}

/**
 * The one shared error-handling middleware: any route that throws (or
 * calls `next(err)` with) a WolfError is answered with its taxonomy status
 * and kind, never a raw stack trace. An unrecognised throw is classified
 * `internal` (R39) — NEVER `unavailable`, the one RETRYABLE kind: W10's
 * poller treats `unavailable` as "skip this tick, try again later", so
 * mapping a genuine server bug to it would make the poller retry a
 * crashing endpoint forever instead of surfacing the bug. The thrown
 * error's own message is logged server-side via pino and never placed in
 * the response body — it may contain a stack trace or a credential.
 *
 * Exported (not inlined in `createApp`) so `app.test.ts` can mount it on a
 * minimal throwaway app alongside a deliberately throwing route, without
 * adding a test-only route to the real route table.
 */
export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof WolfError) {
      logger.warn({ kind: err.kind, path: req.path, msg: err.message }, "request failed");
      if (err.kind === "internal") {
        // 🔴 `internal` means WE have a bug, and § "Shared error taxonomy"
        // says its message "is **not** passed through to the client — a stack
        // trace or a credential in a thrown error must not reach a response
        // body". That held only for an UNRECOGNISED throw (below); a
        // `new WolfError("internal", …)` — which `report/frame.ts` and
        // `report/template.ts` both construct, with details — had its message
        // and its `details` echoed verbatim. The rule belongs here, at the one
        // place every error leaves the process, not in each thrower (W21).
        res.status(err.status).json({ kind: err.kind, message: "internal error" });
        return;
      }
      res.status(err.status).json({ kind: err.kind, message: err.message, details: err.details });
      return;
    }
    // ⚠️ AFTER the WolfError branch, deliberately. A duck-typed check placed
    // first classifies by a property any object may carry: a
    // `WolfError("forbidden")` that happened to have `type = "entity.too.large"`
    // on it was answered 413 `invalid` instead of 403 `forbidden`. Our own
    // taxonomy decides first; duck-typing only ever sees what it is for.
    const bodyStatus = bodyParserStatus(err);
    if (bodyStatus !== undefined) {
      // NOT a WolfError and NOT our bug: the caller's bytes never became a
      // body. Left unclassified this fell through to `internal`, telling the
      // caller the server had a bug (W21).
      const rejected = new WolfError("invalid", "request body could not be read", {
        status: bodyStatus,
      });
      logger.warn(
        { kind: rejected.kind, path: req.path, type: (err as { type?: string }).type },
        "request body rejected",
      );
      res.status(rejected.status).json({ kind: rejected.kind, message: rejected.message });
      return;
    }
    const wrapped = WolfError.internal(err);
    logger.error({ err, path: req.path }, "unhandled error");
    res.status(wrapped.status).json({ kind: wrapped.kind, message: wrapped.message });
  };
}

/**
 * Builds the Express 5 app. Kept separate from index.ts so tests can
 * `import { createApp }` and drive it with `supertest`-style requests
 * without binding a real port.
 *
 * `config` is required, not optional: the routers mounted below are the
 * only reason the market-data MCP server is reachable at all, and a
 * "mounted only when configured" app is exactly the silent no-op this
 * codebase keeps being bitten by. A missing `WOLF_MCP_TOKEN` therefore
 * fails HERE, at boot, naming the variable — never by serving `/mcp`
 * unauthenticated.
 */
export function createApp(logger: Logger, config: WolfConfig): Express {
  const app = express();
  // 🔴 The limit is DERIVED from the report-template budget, and the default
  // is not good enough: `express.json()`'s own default is **100kb**, while
  // `WOLF_REPORT_MAX_BYTES` defaults to 512000 — so before W21 every template
  // between those two numbers was refused by the body parser, as an opaque
  // 500, and the configured budget was unreachable. The doubling is JSON
  // string escaping: a template is quote-dense HTML and every `"` costs two
  // bytes inside a JSON string; the constant is headroom for the rest of the
  // envelope.
  app.use(express.json({ limit: config.reportMaxBytes * 2 + 65_536 }));

  // Mounted at /api/healthz, not /healthz: nginx's /api/ location (prod)
  // and vite's /api proxy (dev) both forward the full path unrewritten
  // (see web/nginx.conf.template and web/vite.config.ts), matching every
  // route in § "Wolf API routes" of the plan, which are all /api/....
  app.get("/api/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // ── W7: the market-data MCP server and the byte route it points at ────
  //
  // Both are mounted OUTSIDE the `/api` prefix and outside the session
  // cookie: a session container has no cookie and reaches wolf-api
  // directly at http://<dind-gateway>:<port>, not through nginx
  // (design/2026-08-20-agent-wolf.md § "Local topology and networking").
  // `/mcp` is authenticated by the bare `X-Wolf-Mcp-Token` header and
  // `/series/download` solely by its signed `token` query parameter.
  //
  // This is the one place seconds become milliseconds
  // (`createCache` takes `ttlMs`); `marketdata/cache.ts` deliberately does
  // no unit conversion of its own (W6's Notes).
  const marketdata = createMarketDataAccess({
    fredApiKey: config.fredApiKey,
    cacheTtlMs: config.marketDataCacheTtlSeconds * 1000,
  });
  const { mcpRouter, seriesDownloadRouter } = createWolfMcp({
    // The origin follows the RESOLVED mcpUrl — which may have been
    // discovered at boot (R43) — never `process.env.WOLF_MCP_URL`.
    mcpOrigin: originFromMcpUrl(config.mcpUrl),
    mcpToken: config.mcpToken,
    seriesSecret: config.seriesTokenSecret,
    seriesUrlTtlSec: config.seriesUrlTtlSeconds,
    marketdata,
  });
  app.use(mcpRouter);
  app.use(seriesDownloadRouter);

  // ── W8: sign-in and the hypothesis routes ─────────────────────────────
  //
  // Everything below this line is cookie-authenticated and lives under the
  // literal /api prefix. Everything ABOVE it is deliberately not: see the ⚠️
  // in auth/session.ts (R79).
  //
  // Checked here rather than in loadConfig, following W7's WOLF_MCP_TOKEN
  // precedent: every boot goes through createApp, so an unset variable is a
  // one-line fatal naming it (index.ts), while `loadConfig` stays usable by
  // scripts/bootstrap-project.ts — which signs nobody in and would otherwise
  // need a session secret and an allowlist to provision a project.
  assertSessionConfigured(config);

  // ONE Orange client and ONE hypothesis store for the app. The store's
  // transition mutex is PROCESS-WIDE, not per instance: `store.ts` holds a
  // module-scoped `SHARED_TRANSITION_MUTEX` and every store built in this
  // process uses it, which is what lets `index.ts` deliberately build a second
  // client and store for W10's poller without the poller's `live -> challenged`
  // racing a human's `/verdict` through this one.
  //
  // *(This comment previously asserted the opposite — "per INSTANCE, not per
  // process, so a second store built elsewhere would silently stop serialising
  // transitions". That was true when W8 wrote it and W10 falsified it; the
  // stale text was still here two waves later. R164.)*
  const client = createBobClient({
    baseUrl: config.orangeBaseUrl,
    apiKey: config.orangeApiKey,
    logger,
  });
  const store = createHypothesisStore({ client, logger });

  // cookie-parser's BUILT-IN signing is the pinned session mechanism: Wolf
  // holds no server-side session state, so a session store would be
  // machinery for nothing. Mounted AFTER the market-data routers so those
  // never even parse a cookie.
  app.use(cookieParser(config.sessionSecret));
  app.use(createAuthRouter({ client, config, logger }));

  // ── W21's report router, CONSTRUCTED here and MOUNTED below ───────────
  //
  // 🔴 The construction is hoisted above the hypotheses router and the mount
  // is NOT: they are two separate decisions and only the first one moved (W22).
  // `report.composeReportStats` is the ONE producer of `stripped_count`, bound
  // to this instance's frame cache, and `GET /api/hypotheses/:id` must carry
  // that field — so the hypotheses router cannot be built before the report
  // router exists. Mount order is a different question, answered where the
  // `app.use` still is; moving that as well would change route precedence
  // nobody sanctioned.
  const report = createReportRouter({ store, client, config, logger });

  // `config` is passed now that this file has it in hand: the router's own
  // fallback (`loadConfig()` on first use) exists for callers that do not, and
  // W22 needs `reportMaxBytes` to parse a stored template for slot drift.
  app.use(
    createHypothesesRouter({
      store,
      client,
      logger,
      config,
      composeReportStats: report.composeReportStats,
    }),
  );

  // ── W11: the two read-only routes the BROWSER needs ───────────────────
  //
  // Mounted AFTER the hypotheses router, which is safe because Express
  // matches whole paths: `/api/hypotheses/:id` does not match
  // `/api/hypotheses/<id>/embed-token`. Both routers guard their own single
  // route with `requireSignedIn` (R79) rather than a path-prefixed
  // `router.use`, so neither can 401 anything it does not serve.
  app.use(createEmbedRouter({ client, config, logger }));
  app.use(createSeriesRouter({ client, logger }));

  // ── W29: the artifact metadata list ───────────────────────────────────
  //
  // Mounted with W11's two for the same reasons: Express matches whole paths,
  // so `/api/hypotheses/:id/artifacts` never collides with
  // `/api/hypotheses/:id`, and this router guards its single route with
  // `requireSignedIn` itself (R79) rather than a path-prefixed `router.use`.
  //
  // 🔴 `app.test.ts` asserts this line with a signed-in, MALFORMED-id probe.
  // "401 when signed out" does NOT discriminate — W8's path-prefixed
  // `router.use("/api/hypotheses", requireSignedIn)` 401s everything under the
  // prefix whether or not this router exists (R133).
  app.use(createArtifactsRouter({ client, logger }));

  // ── W21: the report frame and the two template-writing routes ─────────
  //
  // Mounted last among the /api routers, and safe there for the same reason
  // the two above are: Express matches whole paths, so
  // `/api/hypotheses/:id/report/frame` never collides with
  // `/api/hypotheses/:id`. This router guards each of its three routes with
  // `requireSignedIn` itself (R79) and holds the frame cache, so there is one
  // instance of it for the app — a second would be a second cache.
  //
  // 🔴 It is CONSTRUCTED above, with the hypotheses router, and mounted here.
  // Do not move this line up to join it: construction order exists so
  // `composeReportStats` can be passed into the hypotheses router; mount
  // order decides route precedence and nothing has sanctioned changing it.
  app.use(report.router);

  app.use(createErrorHandler(logger));

  return app;
}
