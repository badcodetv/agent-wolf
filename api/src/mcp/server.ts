/**
 * W7 — the `wolf` MCP server, over Streamable HTTP.
 *
 * design/2026-08-20-agent-wolf.md § "The MCP server name and its auth
 * header" (agent-orange repo):
 *
 * Three tools: `series_search` and `series_fetch` (market data) and
 * `spec_validate` (the interviewer's schema check before it deposits a
 * candidate — read-only, writes nothing).
 *
 *   "Server name is `wolf`, so tools are mcp__wolf__series_fetch and
 *   friends — the researcher prompt, X1's mock-model script and W7 must all
 *   use that exact form. The header is X-Wolf-Mcp-Token, carrying the BARE
 *   token with no scheme."
 *
 * ⚠️ `Authorization: Bearer ${WOLF_MCP_TOKEN}` cannot work and is not
 * accepted here even when the value is correct. Orange validates MCP header
 * values as whole-value `${VAR}` references only and rejects
 * `"Bearer ${WOLF_MCP_TOKEN}"` outright (`go/agentdb/sessions.go:55,88-89`),
 * so W12's project MCP config can carry
 * `{"headers": {"X-Wolf-Mcp-Token": "${WOLF_MCP_TOKEN}"}}` and nothing
 * else. Accepting a Bearer form here would let the two schemes diverge with
 * both tickets' tests passing and X1 failing with a 401 raised inside a
 * container.
 *
 * Nothing in this module reads `process.env` (W7 acceptance criterion): the
 * factory takes `{ mcpOrigin, mcpToken, seriesSecret, seriesUrlTtlSec,
 * marketdata }` and exports mountable routers. `api/src/app.ts` does the
 * wiring.
 *
 * The transport is **stateless** (`sessionIdGenerator: undefined`) with a
 * fresh `McpServer` per request: Wolf's tools are pure request/response, and
 * a session-bound transport would keep per-client state for no gain and
 * break the moment more than one wolf-api process existed.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WolfError } from "../errors.js";
import {
  createSeriesDownloadRouter,
  DEFAULT_SERIES_URL_TTL_SEC,
} from "./seriesdownload.js";
import { constantTimeEquals } from "./seriesdownload.js";
import { registerSpecValidateTool } from "./specvalidate.js";
import { registerSeriesTools, type MarketDataAccess } from "./tools.js";

/** The MCP server's name. `mcp__<name>__<tool>` is how Orange derives the
 * tool names a prompt calls (`go/agentdb/sessions.go:49-51`), so changing
 * this silently renames every tool W12's researcher prompt calls. */
export const MCP_SERVER_NAME = "wolf";

/** The path `/mcp` is served at — matches `WOLF_MCP_URL`'s path and wolf-web's nginx location. */
export const MCP_PATH = "/mcp";

/** The auth header, lower-cased as Node presents it. Bare token, no scheme. */
export const MCP_TOKEN_HEADER = "x-wolf-mcp-token";

/** Fixed 401 body. Never contains the expected token, and never says which part was wrong. */
const UNAUTHORIZED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32001, message: "unauthorized" },
  id: null,
});

export interface WolfMcpOptions {
  /** Scheme + host + port that download URLs are built on — see `originFromMcpUrl`. */
  mcpOrigin: string;
  /** `WOLF_MCP_TOKEN`'s value. Compared in constant time; never logged. */
  mcpToken: string;
  /** `WOLF_SERIES_TOKEN_SECRET`'s value: the HMAC key for download tokens. */
  seriesSecret: string;
  /** Download-URL lifetime in seconds. Defaults to 300. */
  seriesUrlTtlSec?: number;
  marketdata: MarketDataAccess;
  /** Injectable clock in epoch **milliseconds**. */
  now?: () => number;
}

export interface WolfMcp {
  /** Serves `POST /mcp`. Mount with `app.use(mcpRouter)`. */
  mcpRouter: Router;
  /** Serves `GET /series/download`. Mount with `app.use(seriesDownloadRouter)`. */
  seriesDownloadRouter: Router;
}

/**
 * The origin a download URL is built on, taken from the RESOLVED MCP URL
 * (`config.mcpUrl`) — which may have been *discovered* at boot rather than
 * supplied (R43). Reading `process.env.WOLF_MCP_URL` directly instead
 * yields `undefined` in exactly the deployment R43 exists for, minting URLs
 * that fail inside a container with no obvious cause.
 */
export function originFromMcpUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    throw WolfError.misconfigured("WOLF_MCP_URL", `WOLF_MCP_URL is not a valid URL: ${mcpUrl}`);
  }
}

export function createWolfMcp(options: WolfMcpOptions): WolfMcp {
  if (!options.mcpToken || options.mcpToken.trim() === "") {
    throw WolfError.misconfigured(
      "WOLF_MCP_TOKEN",
      "WOLF_MCP_TOKEN is required: the market-data MCP server refuses to run unauthenticated",
    );
  }
  if (!options.seriesSecret || options.seriesSecret.trim() === "") {
    throw WolfError.misconfigured(
      "WOLF_SERIES_TOKEN_SECRET",
      "WOLF_SERIES_TOKEN_SECRET is required: download URLs cannot be signed without it",
    );
  }

  const mcpRouter = Router();
  mcpRouter.use(MCP_PATH, express.json({ limit: "1mb" }));

  // Auth first, on every method: a rejected call must never reach a
  // provider (W7 acceptance criterion — the tests assert the connector was
  // not called).
  mcpRouter.use(MCP_PATH, (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers[MCP_TOKEN_HEADER];
    const presented = typeof header === "string" ? header : "";
    if (presented.length === 0 || !constantTimeEquals(presented, options.mcpToken)) {
      res.status(401);
      res.setHeader("Content-Type", "application/json");
      res.send(UNAUTHORIZED_BODY);
      return;
    }
    next();
  });

  mcpRouter.post(MCP_PATH, (req: Request, res: Response, next: NextFunction) => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
    registerSeriesTools(server, {
      access: options.marketdata,
      mcpOrigin: options.mcpOrigin,
      seriesSecret: options.seriesSecret,
      seriesUrlTtlSec: options.seriesUrlTtlSec ?? DEFAULT_SERIES_URL_TTL_SEC,
      now: options.now,
    });
    // `spec_validate` — the interviewer's feedback loop on the spec schema.
    // Read-only and pure; see specvalidate.ts for the thirteen-error
    // interview that made it necessary.
    registerSpecValidateTool(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch(next);
  });

  // Streamable HTTP's GET (server-to-client SSE) and DELETE (session
  // teardown) legs are meaningless for a stateless server; answer them
  // explicitly rather than leaving them to fall through to a 404 that looks
  // like a wrong URL.
  mcpRouter.all(MCP_PATH, (_req: Request, res: Response) => {
    res.status(405);
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "application/json");
    res.send(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed: this MCP endpoint is stateless, use POST" },
        id: null,
      }),
    );
  });

  const seriesDownloadRouter = createSeriesDownloadRouter({
    secret: options.seriesSecret,
    access: options.marketdata,
    nowSec: options.now ? () => Math.floor(options.now!() / 1000) : undefined,
  });

  return { mcpRouter, seriesDownloadRouter };
}
