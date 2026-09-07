/**
 * The Yahoo Finance connector — the replacement for dead Stooq.
 *
 * Stooq was the only price source in this codebase and it is gone: every
 * plain HTTP request to its daily-download endpoint answers HTTP 200 with a
 * JavaScript proof-of-work challenge page (recorded 2026-09-07 at
 * `__fixtures__/stooq-challenge-page.html`; see `guard.ts` for what the
 * pipeline used to do with those bytes). FRED covers US macro and has daily
 * Bitcoin (`CBBTCUSD`) but has **no daily gold series at all**, so a thesis
 * about hard assets could not be expressed. Yahoo's chart endpoint covers
 * gold futures (`GC=F`), crypto (`BTC-USD`), equities and ETFs.
 *
 * ── Two things about this provider you must know ────────────────────────
 *
 * 1. **It is UNOFFICIAL.** There is no published contract, no versioning
 *    promise and no terms under which we are a supported client. It can die
 *    exactly the way Stooq did, and it may die by starting to serve HTML
 *    rather than by returning an error. That is why every response goes
 *    through `guardJsonBody` before any field is read — see `guard.ts`.
 *
 * 2. **It requires a browser-style `User-Agent` or it returns HTTP 429**
 *    with the body `Too Many Requests` (recorded at
 *    `__fixtures__/yahoo-429-body.txt`). This is not a rate limit you have
 *    earned; it is how the endpoint refuses a client it does not like. It
 *    ALSO rate-limits per IP for real, for tens of minutes at a time, which
 *    a caller must expect: the guard reports both as `unavailable`, the one
 *    retryable kind.
 *
 * ── The value column ────────────────────────────────────────────────────
 *
 * `indicators.adjclose[0].adjclose` is PREFERRED over
 * `indicators.quote[0].close`. Adjusted close is what makes a multi-year
 * equity or ETF series comparable with itself across a split or a dividend;
 * an unadjusted close silently steps on the split date and any invalidation
 * condition written as a percentage change reads that step as a real move.
 * Not every instrument has an adjusted column (futures and crypto do not),
 * so `close` is the documented fallback, never a co-equal choice.
 *
 * ── Dates ───────────────────────────────────────────────────────────────
 *
 * Yahoo timestamps a daily bar at the moment the session opened, in epoch
 * SECONDS, and reports the exchange's offset from UTC in `meta.gmtoffset`
 * (also seconds). The trading date is therefore the date in EXCHANGE-LOCAL
 * time, not in UTC: a US equity bar at 09:30 New York time is 13:30 or
 * 14:30 UTC on the same date, but an instrument whose session opens in the
 * evening local time would land on the wrong UTC date. `normalise` then
 * turns that date into `YYYY-MM-DDT00:00:00Z`, as the canonical CSV
 * requires.
 *
 * Nothing here reads `process.env` — every input, including the HTTP
 * implementation and the User-Agent, is an explicit constructor option.
 */

import { WolfError } from "../errors.js";
import { guardJsonBody } from "./guard.js";
import type { RawMarketDataRow } from "./normalise.js";
import type { MarketDataConnector, MarketDataSearchResult } from "./stooq.js";

/** Default HTTP deadline for a Yahoo request, in milliseconds. Matches W6's connectors. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The `User-Agent` sent by default. Without a browser-style value the
 * endpoint answers 429 — see the file header. Overridable, but never empty:
 * `createYahooClient` refuses an empty one rather than making every call
 * fail with a rate-limit error that has nothing to do with rate limits.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** How many search hits to ask for. Yahoo's own default is larger and noisier. */
export const DEFAULT_QUOTES_COUNT = 10;

/** Every bar this connector requests is daily; the canonical CSV is one row per day. */
export const INTERVAL = "1d";

export interface YahooClientOptions {
  /** Defaults to the global `fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** Defaults to `https://query2.finance.yahoo.com`. Overridable so tests never hit the real host. */
  baseUrl?: string;
  /** Deadline for the underlying HTTP call, in milliseconds. */
  timeoutMs?: number;
  /** Overrides `DEFAULT_USER_AGENT`. Must be non-empty. */
  userAgent?: string;
  /** How many search hits to request. */
  quotesCount?: number;
}

/* ------------------------------------------------------------------ */
/* the response shapes, as Yahoo actually returns them                 */
/* ------------------------------------------------------------------ */

interface YahooChartMeta {
  currency?: string;
  symbol?: string;
  instrumentType?: string;
  exchangeTimezoneName?: string;
  /** The exchange's offset from UTC, in SECONDS. */
  gmtoffset?: number;
}

interface YahooChartResult {
  meta?: YahooChartMeta;
  /** Epoch SECONDS, one per bar. Absent when the range holds no bars. */
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
    adjclose?: Array<{ adjclose?: Array<number | null> }>;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  quoteType?: string;
  typeDisp?: string;
  exchange?: string;
  exchDisp?: string;
  /** Present on some quote types only — see `searchUnit`. */
  currency?: string;
  isYahooFinance?: boolean;
}

interface YahooSearchResponse {
  quotes?: YahooSearchQuote[];
}

/* ------------------------------------------------------------------ */
/* pure helpers, exported so tests can drive them directly             */
/* ------------------------------------------------------------------ */

/**
 * The exchange-local trading date for a bar, as `YYYY-MM-DD`.
 *
 * Shifting the epoch by the exchange offset and then reading the UTC date is
 * the whole trick: it yields the local calendar date without pulling in a
 * timezone database.
 */
export function tradingDate(epochSeconds: number, gmtOffsetSeconds: number): string {
  return new Date((epochSeconds + gmtOffsetSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * Formats a JSON number as the value string the canonical CSV carries.
 *
 * `normalise`'s contract is to keep the provider's verbatim numeric string
 * so no float drift is introduced. Yahoo sends JSON *numbers*, so there is
 * no verbatim string to keep; `String(n)` is the shortest representation
 * that round-trips to the identical double, which is the closest thing to
 * verbatim that exists here. **No rounding**: how many decimal places a
 * price has is the provider's statement, not ours to trim.
 */
export function formatValue(value: number): string {
  return String(value);
}

/**
 * Picks the value series: adjusted close when the instrument has one, plain
 * close otherwise. Returns `null` when neither is present, which is a
 * malformed response rather than an empty day.
 */
export function pickValueSeries(result: YahooChartResult): {
  values: Array<number | null>;
  adjusted: boolean;
} | null {
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  if (Array.isArray(adj)) return { values: adj, adjusted: true };
  const close = result.indicators?.quote?.[0]?.close;
  if (Array.isArray(close)) return { values: close, adjusted: false };
  return null;
}

/**
 * Turns one chart result into canonical rows.
 *
 * - A `null` value means no observation for that bar (a holiday, a halt).
 *   The row is OMITTED, never coerced to 0 — the same rule as FRED's `"."`
 *   sentinel.
 * - A timestamp/value length mismatch is a broken response, not something
 *   to iterate over the shorter of: the two arrays are positionally paired,
 *   so a mismatch means we cannot know which value belongs to which day.
 */
export function rowsFromChartResult(result: YahooChartResult, symbol: string): RawMarketDataRow[] {
  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    // A valid response for a real symbol with no bars in the requested
    // range. Legitimately empty — not an error.
    return [];
  }

  const picked = pickValueSeries(result);
  if (!picked) {
    throw new WolfError(
      "unavailable",
      `yahoo returned no close or adjusted-close series for ${symbol}`,
    );
  }
  if (picked.values.length !== timestamps.length) {
    throw new WolfError(
      "unavailable",
      `yahoo returned ${timestamps.length} timestamps but ${picked.values.length} values for ${symbol}; ` +
        "the arrays are positionally paired, so the response cannot be read",
    );
  }

  const gmtOffset = typeof result.meta?.gmtoffset === "number" ? result.meta.gmtoffset : 0;
  const rows: RawMarketDataRow[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const value = picked.values[i];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    rows.push({
      timestamp: tradingDate(timestamps[i]!, gmtOffset),
      value: formatValue(value),
    });
  }
  return rows;
}

/**
 * The unit a search hit reports.
 *
 * Yahoo's search endpoint does not reliably carry a currency, so this reads
 * one when present and otherwise reports the empty string rather than
 * guessing `"USD"` — a gold-in-GBP or a European ETF would make that guess
 * wrong in exactly the case where the unit matters. The authoritative
 * currency for a series is `meta.currency` on the CHART response;
 * surfacing it through `series_fetch` needs a change to
 * `MarketDataConnector.fetch`'s return type, which is deliberately not part
 * of this change (see this ticket's Discovered Issues Log entry).
 */
export function searchUnit(quote: YahooSearchQuote): string {
  return typeof quote.currency === "string" && quote.currency.length > 0 ? quote.currency : "";
}

/** The human title for a search hit: the fullest name Yahoo gives, plus the exchange. */
export function searchTitle(quote: YahooSearchQuote): string {
  const name = quote.longname ?? quote.shortname ?? quote.symbol ?? "";
  const where = quote.exchDisp ?? quote.exchange;
  const what = quote.typeDisp ?? quote.quoteType;
  const suffix = [what, where].filter((part) => part && part.length > 0).join(", ");
  return suffix.length > 0 ? `${name} (${suffix})` : name;
}

/* ------------------------------------------------------------------ */
/* the connector                                                       */
/* ------------------------------------------------------------------ */

export function createYahooClient(options: YahooClientOptions = {}): MarketDataConnector {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  if (userAgent.trim() === "") {
    // Failing here beats failing on every call with a 429 that looks like
    // an unrelated rate limit.
    throw WolfError.misconfigured(
      "YAHOO_USER_AGENT",
      "a non-empty browser-style User-Agent is required: Yahoo answers 429 without one",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://query2.finance.yahoo.com";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quotesCount = options.quotesCount ?? DEFAULT_QUOTES_COUNT;

  async function request<T>(url: URL, what: string): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { "user-agent": userAgent, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WolfError("unavailable", `yahoo request failed (${what})`, { cause: err });
    }

    const text = await response.text();

    // Before ANY field is read. Yahoo is unofficial and will one day answer
    // with something that is not JSON; a lenient read of that is how Stooq's
    // death produced a chart of JavaScript. The guard also turns the 429 a
    // missing User-Agent provokes into a message that says so.
    const body = guardJsonBody<T>(text, {
      provider: "yahoo",
      status: response.status,
      contentType: response.headers.get("content-type"),
    });

    // A 404 carries a real JSON error body, so status is checked AFTER the
    // guard has confirmed the body is readable.
    if (response.status === 404) {
      throw new WolfError("not_found", `yahoo has no series for ${what}`);
    }
    if (response.status >= 500) {
      throw new WolfError("unavailable", `yahoo responded with status ${response.status}`);
    }
    if (!response.ok) {
      throw new WolfError("unavailable", `yahoo responded with status ${response.status} (${what})`);
    }
    return body;
  }

  async function search(query: string): Promise<{ results: MarketDataSearchResult[] }> {
    const needle = query.trim();
    if (needle.length === 0) return { results: [] };

    const url = new URL("/v1/finance/search", baseUrl);
    url.searchParams.set("q", needle);
    url.searchParams.set("quotesCount", String(quotesCount));
    url.searchParams.set("newsCount", "0");

    const body = await request<YahooSearchResponse>(url, `search ${needle}`);
    const results: MarketDataSearchResult[] = [];
    for (const quote of body.quotes ?? []) {
      // A hit with no symbol cannot be passed to series_fetch, so it is not
      // a result — offering it would send the model to a guaranteed failure.
      if (typeof quote.symbol !== "string" || quote.symbol.length === 0) continue;
      results.push({
        // `source` is the enum member, not Yahoo's own name for itself.
        source: "yahoo" as MarketDataSearchResult["source"],
        id: quote.symbol,
        title: searchTitle(quote),
        unit: searchUnit(quote),
        frequency: "daily",
        // Yahoo's search reports no coverage window. Reported as unknown
        // rather than synthesised by fetching the series, which is the rule
        // Stooq's connector already follows.
        first: null,
        last: null,
      });
    }
    return { results };
  }

  async function fetchSeries(id: string, from?: string, to?: string): Promise<RawMarketDataRow[]> {
    // `encodeURIComponent`, not raw interpolation: real symbols contain `=`
    // (`GC=F`) and `^` (`^GSPC`).
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(id)}`, baseUrl);
    url.searchParams.set("interval", INTERVAL);
    if (from || to) {
      // period1/period2 are epoch SECONDS and period2 is EXCLUSIVE of the
      // instant, so `to` is pushed to the end of its own day to keep the
      // range inclusive, as every other connector's `to` is.
      url.searchParams.set("period1", String(from ? epochSecondsAtUtcMidnight(from) : 0));
      url.searchParams.set(
        "period2",
        String(to ? epochSecondsAtUtcMidnight(to) + 86_400 : Math.floor(Date.now() / 1000) + 86_400),
      );
    } else {
      url.searchParams.set("range", "max");
    }

    const body = await request<YahooChartResponse>(url, id);

    const error = body.chart?.error;
    if (error && (error.code || error.description)) {
      // Yahoo's own words for an unknown or delisted symbol.
      if (/not\s*found/i.test(error.code ?? "") || /delisted|no data found/i.test(error.description ?? "")) {
        throw new WolfError("not_found", `yahoo series ${id} not found`);
      }
      throw new WolfError("unavailable", `yahoo reported an error for ${id}: ${error.code ?? "unknown"}`);
    }

    const result = body.chart?.result?.[0];
    if (!result || !result.meta) {
      // No `meta` means this is not a chart response at all. Returning []
      // here would report "no data today" for a body we could not read —
      // the silent-empty-series shape the guard exists to prevent.
      throw new WolfError("unavailable", `yahoo returned no chart result for ${id}`);
    }

    return rowsFromChartResult(result, id);
  }

  return { search, fetch: fetchSeries };
}

/** `YYYY-MM-DD` → epoch seconds at 00:00:00 UTC on that date. */
function epochSecondsAtUtcMidnight(isoDate: string): number {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new WolfError("invalid", `not a YYYY-MM-DD date: ${isoDate}`);
  }
  return Math.floor(parsed / 1000);
}
