import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Logger } from "./logger.js";
import type { WolfConfig } from "./config.js";
import { WolfError } from "./errors.js";
import { createWolfMcp, originFromMcpUrl } from "./mcp/server.js";
import { createMarketDataAccess } from "./mcp/tools.js";

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
      res.status(err.status).json({ kind: err.kind, message: err.message, details: err.details });
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
  app.use(express.json());

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

  app.use(createErrorHandler(logger));

  return app;
}
