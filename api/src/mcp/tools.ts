/**
 * W7 — the two `wolf` MCP tools, `series_search` and `series_fetch`, and
 * the market-data seam they and the download route share.
 *
 * design/2026-08-20-agent-wolf.md § "Market-data MCP tools" (agent-orange
 * repo):
 *
 *   series_search(query, source?) → { results: [{ source, id, title, unit,
 *                                     frequency, first, last }] }
 *   series_fetch(source, id, from?, to?)
 *       → { download_url, expires_at_sec, rows, unit, source, id }
 *
 * `expires_at_sec` is unix **seconds**. § "Interfaces" writes it
 * `expires_at`, which § "Shared shapes" forbids ("encode the unit in every
 * type you write") — the suffixed name is the one shipped, per W7's own
 * acceptance criterion.
 *
 * **No tool returns CSV.** `series_fetch` hands back a short-lived,
 * single-series URL and the model `curl`s it to a file; the bytes never
 * enter the model's context. (The credential in the URL does — the same
 * caveat § "The dataset atom" states for `dataset_get`.)
 *
 * Nothing here reads `process.env` (W7 acceptance criterion): the FRED key,
 * the cache TTL and the HTTP implementation are all explicit options.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WolfError, type WolfErrorKind } from "../errors.js";
import { createCache, DEFAULT_TTL_MS, type MarketDataCache } from "../marketdata/cache.js";
import { createFredClient, DEFAULT_TIMEOUT_MS } from "../marketdata/fred.js";
import { SERIES_SOURCES, type SeriesSource } from "../marketdata/sources.js";
import { countDataRows, normalise } from "../marketdata/normalise.js";
import {
  createStooqClient,
  type MarketDataConnector,
  type MarketDataSearchResult,
} from "../marketdata/stooq.js";
import { createYahooClient } from "../marketdata/yahoo.js";
import {
  DEFAULT_SERIES_URL_TTL_SEC,
  seriesDownloadUrl,
  signSeriesToken,
} from "./seriesdownload.js";

// The provider list lives in ONE place — see marketdata/sources.ts for the
// bug that made that necessary. Re-exported here because every existing
// caller imports it from this module.
export { SERIES_SOURCES, type SeriesSource } from "../marketdata/sources.js";

/**
 * The unit `series_fetch` reports per source, when the provider pins one for
 * every series it serves.
 *
 * `stooq` is a US-only ticker table, so every series is in USD. `fred`'s
 * observations endpoint carries no units at all, and `yahoo`'s carries a
 * per-series `meta.currency` that `MarketDataConnector.fetch`'s return type
 * cannot express today — both report `null` here, and the tool description
 * points the model at `series_search`'s `unit` instead. See yahoo.ts's
 * `searchUnit` for the deferred fix.
 */
const UNIT_BY_SOURCE: Record<SeriesSource, string | null> = {
  fred: null,
  stooq: "USD",
  yahoo: null,
};

/** One resolved series: the canonical CSV bytes, plus the unit if the provider pins one. */
export interface SeriesResolution {
  csv: string;
  /** `"USD"` for Stooq (always). `null` for FRED and Yahoo — see
   * `UNIT_BY_SOURCE`; use `series_search`'s `unit` for those. */
  unit: string | null;
}

/**
 * The seam both the tools and the download route resolve series through, so
 * a `series_fetch` and the download that follows it hit the SAME cache and
 * the same normaliser. Injectable, so a test can drive either side without
 * a network or a real connector.
 */
export interface MarketDataAccess {
  search(query: string, source?: SeriesSource): Promise<{ results: MarketDataSearchResult[] }>;
  resolve(source: SeriesSource, id: string, from?: string, to?: string): Promise<SeriesResolution>;
}

export interface CreateMarketDataAccessOptions {
  /** `FRED_API_KEY`'s value, passed through from config. Empty is allowed:
   * the FRED connector is built LAZILY, so a stack with no key still boots
   * and still serves Stooq — the missing key surfaces as a
   * `misconfigured` tool error naming `FRED_API_KEY` on the first FRED
   * call, which is where it is actionable. */
  fredApiKey?: string;
  /** Cache TTL in **milliseconds** (`config.marketDataCacheTtlSeconds * 1000`). */
  cacheTtlMs?: number;
  /** Injected `fetch`, for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock in epoch **milliseconds**, handed to the cache. */
  now?: () => number;
  /** HTTP deadline in milliseconds; W6's connectors default to 10s (R68). */
  timeoutMs?: number;
  /** Pre-built connectors, for tests. A source given here is never constructed. */
  connectors?: Partial<Record<SeriesSource, MarketDataConnector>>;
}

export function createMarketDataAccess(
  options: CreateMarketDataAccessOptions = {},
): MarketDataAccess {
  const cache: MarketDataCache<string> = createCache<string>({
    ttlMs: options.cacheTtlMs ?? DEFAULT_TTL_MS,
    now: options.now,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const built = new Map<SeriesSource, MarketDataConnector>();

  function connector(source: SeriesSource): MarketDataConnector {
    const injected = options.connectors?.[source];
    if (injected) return injected;
    const existing = built.get(source);
    if (existing) return existing;

    // Lazy: `createFredClient` throws `WolfError.misconfigured("FRED_API_KEY")`
    // at CONSTRUCTION when the key is empty (W6's criterion), so building it
    // here rather than at boot is what keeps a keyless stack usable for Stooq
    // instead of dead.
    const client =
      source === "fred"
        ? createFredClient({ apiKey: options.fredApiKey ?? "", fetchImpl: options.fetchImpl, timeoutMs })
        : source === "yahoo"
          ? createYahooClient({ fetchImpl: options.fetchImpl, timeoutMs })
          : createStooqClient({ fetchImpl: options.fetchImpl, timeoutMs });
    built.set(source, client);
    return client;
  }

  async function search(
    query: string,
    source?: SeriesSource,
  ): Promise<{ results: MarketDataSearchResult[] }> {
    const sources: SeriesSource[] = source ? [source] : [...SERIES_SOURCES];
    const results: MarketDataSearchResult[] = [];
    for (const each of sources) {
      // A failure on one leg is NOT swallowed: a `misconfigured` FRED key
      // that silently returned "Stooq results only" would look like "FRED
      // has nothing on that query", which is the "nothing fails at use
      // time" trap. The tool description tells the model it can retry with
      // an explicit `source`.
      const answer = await connector(each).search(query);
      results.push(...answer.results);
    }
    return { results };
  }

  async function resolve(
    source: SeriesSource,
    id: string,
    from?: string,
    to?: string,
  ): Promise<SeriesResolution> {
    const csv = await cache.getOrCompute({ source, id, from, to }, async () => {
      const rows = await connector(source).fetch(id, from, to);
      return normalise(rows);
    });
    return { csv, unit: UNIT_BY_SOURCE[source] };
  }

  return { search, resolve };
}

// ── the tools ───────────────────────────────────────────────────────────

const SEARCH_DESCRIPTION = [
  "Search for a market-data series by free text and get its identifier, unit and coverage.",
  "Use this before series_fetch when you do not already know the exact series id.",
  "Sources:",
  "'fred' is US macro data from the St. Louis Fed (keyed API) — money supply, yields, dollar index,",
  "and daily Bitcoin as CBBTCUSD. It has NO daily gold series.",
  "'yahoo' is daily prices for almost everything else: gold futures (GC=F), other commodity futures,",
  "crypto (BTC-USD), equities, ETFs and indices. Use it for any price series FRED does not carry.",
  "'stooq' is DEAD — it now answers every request with a browser-verification page and cannot",
  "return data. It remains a valid value only so that specs locked before it died stay valid.",
  "Never choose 'stooq' for a new metric; use 'yahoo' instead.",
  "Yahoo and Stooq results omit coverage: their 'first' and 'last' are null, and Yahoo's search",
  "does not report a currency, so its 'unit' may be empty.",
  "Omit 'source' to search all of them;",
  "if one source is unavailable or misconfigured the call fails, so retry with an explicit source.",
  "This tool returns metadata only, never observations: to get the data, pass the id to series_fetch",
  "and curl the download URL it returns to a FILE — do NOT print the URL and do NOT print the rows.",
].join(" ");

const FETCH_DESCRIPTION = [
  "Resolve one market-data series to a short-lived download URL for its CSV.",
  "The CSV has the header 'timestamp,value', RFC3339 UTC timestamps, ascending order,",
  "one metric per file, no gap filling and no interpolation.",
  "Download it to a FILE and work with the file:",
  "curl -sSfL \"$DOWNLOAD_URL\" -o /workspace/<name>.csv",
  "Do NOT print the URL and do NOT print the file's contents:",
  "the URL carries a credential, and the rows are data for a tool to read, not for you to recite.",
  "'rows' counts the data rows in that file (excluding the header),",
  "so it can be compared with a later dataset_put's row_count.",
  "The URL expires at 'expires_at_sec' (unix seconds); call this tool again to mint a new one.",
].join(" ");

const SOURCE_DESCRIPTION = [
  "Which provider the series comes from:",
  "'fred' (US macro from the St. Louis Fed, plus daily Bitcoin as CBBTCUSD; no daily gold),",
  "'yahoo' (daily prices for commodity futures such as GC=F gold, crypto, equities, ETFs, indices),",
  "or 'stooq' (DEAD — answers with a browser-verification page; never choose it for new work).",
].join(" ");

export interface SeriesToolsOptions {
  access: MarketDataAccess;
  /** Scheme + host + port the download URL is built on — derived from the
   * RESOLVED `config.mcpUrl` (which may have been discovered at boot, R43),
   * never from `process.env.WOLF_MCP_URL`. */
  mcpOrigin: string;
  /** HMAC key for the download token. */
  seriesSecret: string;
  /** Download-URL lifetime in seconds. */
  seriesUrlTtlSec?: number;
  /** Injectable clock in epoch **milliseconds**. */
  now?: () => number;
}

/** JSON-shaped tool result. Never CSV: see the file header. */
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Kinds a caller may usefully retry. Only `unavailable` is retryable
 * (§ "Shared error taxonomy"); `internal` deliberately is not. */
function retryable(kind: WolfErrorKind): boolean {
  return kind === "unavailable";
}

/**
 * Maps a thrown error onto a tool error, preserving W6's typed kinds
 * unchanged so W10's poller and the model can tell "this series does not
 * exist" from "the provider is down".
 *
 * An unrecognised throw becomes `internal` — NEVER `unavailable` (R39) —
 * and its message is replaced by a fixed string, because it may carry a
 * stack trace, a file path or a credential.
 */
export function toolError(err: unknown) {
  const wolf = err instanceof WolfError ? err : WolfError.internal(err);
  const message = wolf.kind === "internal" ? "internal error" : wolf.message;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { kind: wolf.kind, message, retryable: retryable(wolf.kind) } }),
      },
    ],
  };
}

/** Registers `series_search` and `series_fetch` on an `McpServer`. */
export function registerSeriesTools(server: McpServer, options: SeriesToolsOptions): void {
  const ttlSec = options.seriesUrlTtlSec ?? DEFAULT_SERIES_URL_TTL_SEC;
  const now = options.now ?? Date.now;

  server.registerTool(
    "series_search",
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).describe("Free-text search, e.g. '10-year treasury' or 'aerovironment'."),
        source: z.enum(SERIES_SOURCES).optional().describe(`${SOURCE_DESCRIPTION} Omit to search both.`),
      },
    },
    async ({ query, source }) => {
      try {
        return ok(await options.access.search(query, source));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "series_fetch",
    {
      description: FETCH_DESCRIPTION,
      inputSchema: {
        source: z.enum(SERIES_SOURCES).describe(SOURCE_DESCRIPTION),
        id: z
          .string()
          .min(1)
          .describe("The provider's series id, exactly as series_search returned it (e.g. 'DGS10', 'avav.us')."),
        from: z
          .string()
          .optional()
          .describe("Inclusive start date, format YYYY-MM-DD. Omit for the provider's earliest observation."),
        to: z
          .string()
          .optional()
          .describe("Inclusive end date, format YYYY-MM-DD. Omit for the provider's latest observation."),
      },
    },
    async ({ source, id, from, to }) => {
      try {
        const { csv, unit } = await options.access.resolve(source, id, from, to);
        const expiresAtSec = Math.floor(now() / 1000) + ttlSec;
        const token = signSeriesToken({ source, id, from, to, exp: expiresAtSec }, options.seriesSecret);
        return ok({
          download_url: seriesDownloadUrl(options.mcpOrigin, token),
          expires_at_sec: expiresAtSec,
          // W6's countDataRows and nothing else, so this cannot disagree
          // with a later dataset_put's row_count over the same bytes.
          rows: countDataRows(csv),
          unit,
          source,
          id,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
