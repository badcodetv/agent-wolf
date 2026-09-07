/**
 * The Stooq connector.
 *
 * design/2026-08-20-agent-wolf.md § W6: "Stooq's value column is `Close` —
 * its daily CSV is `Date,Open,High,Low,Close,Volume` and there is no
 * adjusted column to prefer." "Stooq has no search API: its `search`
 * matches a committed static ticker table (`__fixtures__/stooq-tickers.json`)
 * case-insensitively on symbol and name, with `unit` always `"USD"`,
 * `frequency` always `"daily"`, and `first`/`last` `null` rather than
 * synthesised by fetching the series."
 *
 * Nothing here reads `process.env` (W6 acceptance criterion): every input
 * — including which HTTP implementation to use and which ticker table to
 * search — is an explicit constructor option.
 *
 * The default ticker table is imported from the sibling `stooq-tickers.ts`
 * TS module, not read from a JSON file at runtime — see that file's header
 * comment and this ticket's Discovered Issues Log entry for why a
 * `readFileSync` against `__fixtures__/stooq-tickers.json` does not survive
 * `yarn build` + `api/Dockerfile`.
 *
 * 🔴 **THIS PROVIDER IS DEAD, AND THE ENUM VALUE ONLY SURVIVES FOR OLD
 * SPECS.** stooq.com sits behind a client-side JavaScript proof-of-work
 * challenge and answers HTTP 200 with a challenge PAGE, not CSV, for every
 * plain HTTP request. Re-verified 2026-09-07 and RECORDED at
 * `__fixtures__/stooq-challenge-page.html`. `yahoo.ts` is the replacement;
 * `METRIC_SOURCES` keeps `"stooq"` so specs locked before it died stay
 * valid, and every prompt now tells the model never to choose it for new
 * work.
 *
 * What made this dangerous was not the outage but what the code did with
 * it. The challenge page's inline `<script>` contains commas, so
 * `parseStooqCsv` below read it as a DATA ROW — column 0 as a timestamp,
 * column 4 as a value — and the pipeline stored a fragment of the
 * challenge's own JavaScript as an observation, reporting success. That is
 * measured, not asserted: see `guard.test.ts`'s first test, and R262.
 * `fetchSeries` now calls `guardCsvBody` BEFORE the parser (see guard.ts).
 *
 * Recording a real CSV fixture remains impossible in this environment, so
 * the parsing logic below is still written against Stooq's PUBLICLY
 * DOCUMENTED CSV shape (`Date,Open,High,Low,Close,Volume`) and has never
 * been verified against a live successful response.
 */

import { WolfError } from "../errors.js";
import { guardCsvBody } from "./guard.js";
import type { SeriesSource } from "./sources.js";
import type { RawMarketDataRow } from "./normalise.js";
import { DEFAULT_STOOQ_TICKERS } from "./stooq-tickers.js";

export interface StooqTicker {
  /** Stooq's own symbol form, e.g. `spy.us`. Lower-case by convention. */
  symbol: string;
  name: string;
}

export interface MarketDataSearchResult {
  /** Derived — never written out as a union here. See ./sources.ts. */
  source: SeriesSource;
  id: string;
  title: string;
  unit: string;
  frequency: string;
  first: string | null;
  last: string | null;
}

export interface MarketDataConnector {
  search(query: string): Promise<{ results: MarketDataSearchResult[] }>;
  fetch(id: string, from?: string, to?: string): Promise<RawMarketDataRow[]>;
}

export interface StooqClientOptions {
  /** Defaults to the global `fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** Defaults to `https://stooq.com`. Overridable so tests never hit the real host. */
  baseUrl?: string;
  /** Defaults to the bundled `DEFAULT_STOOQ_TICKERS` table. Injectable so
   * tests do not depend on the shape of the committed table. */
  tickers?: StooqTicker[];
  /** Deadline for the underlying HTTP call, in milliseconds. Defaults to
   * `DEFAULT_TIMEOUT_MS`. A hung upstream must not block the caller (an
   * unbounded call, e.g. W10's poller) forever — see this ticket's
   * Discovered Issues Log entry. Read via an explicit option, never
   * `process.env`. */
  timeoutMs?: number;
}

/** Default HTTP deadline for a Stooq request, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Stooq's daily download CSV has no adjusted column: `Close` is the value.
 * Exported for `stooq.test.ts` to exercise directly against hand-built CSV
 * text matching the documented shape (see the file-level note above — this
 * is NOT a recorded fixture, it is testing this function's own parsing
 * logic against a publicly documented format, same as any other
 * pure-function unit test). */
export function parseStooqCsv(csv: string): RawMarketDataRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const rows: RawMarketDataRow[] = [];
  // lines[0] is the header (Date,Open,High,Low,Close,Volume) — skip it.
  for (const line of lines.slice(1)) {
    const columns = line.split(",");
    const date = columns[0];
    const close = columns[4];
    if (date === undefined || close === undefined) continue;
    rows.push({ timestamp: date, value: close });
  }
  return rows;
}

function toStooqDate(isoDate: string): string {
  // Stooq's d1/d2 params are YYYYMMDD.
  return isoDate.replaceAll("-", "");
}

export function createStooqClient(options: StooqClientOptions = {}): MarketDataConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://stooq.com";
  const tickers = options.tickers ?? DEFAULT_STOOQ_TICKERS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function search(query: string): Promise<{ results: MarketDataSearchResult[] }> {
    const needle = query.trim().toLowerCase();
    // An empty (or whitespace-only) needle matches every entry via
    // `String.includes("")`, which would flood a caller like W7's
    // `series_search` with the entire table for a blank query — see this
    // ticket's Discovered Issues Log entry. Require at least one character.
    if (needle.length === 0) {
      return { results: [] };
    }
    const results: MarketDataSearchResult[] = tickers
      .filter(
        (ticker) =>
          ticker.symbol.toLowerCase().includes(needle) || ticker.name.toLowerCase().includes(needle),
      )
      .map((ticker) => ({
        source: "stooq" as const,
        id: ticker.symbol,
        title: ticker.name,
        unit: "USD",
        frequency: "daily",
        first: null,
        last: null,
      }));
    return { results };
  }

  async function fetchSeries(id: string, from?: string, to?: string): Promise<RawMarketDataRow[]> {
    const url = new URL("/q/d/l/", baseUrl);
    url.searchParams.set("s", id);
    url.searchParams.set("i", "d");
    if (from) url.searchParams.set("d1", toStooqDate(from));
    if (to) url.searchParams.set("d2", toStooqDate(to));

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new WolfError("unavailable", "stooq request failed", { cause: err });
    }

    if (response.status === 404) {
      throw new WolfError("not_found", `stooq series ${id} not found`);
    }
    if (response.status >= 500) {
      throw new WolfError("unavailable", `stooq responded with status ${response.status}`);
    }
    if (!response.ok) {
      throw WolfError.internal(new Error(`unexpected stooq status ${response.status}`));
    }

    const text = await response.text();
    // Documented Stooq behaviour for an unknown symbol: HTTP 200 with a
    // literal "No data" body rather than a 404. Not verified against a live
    // response in this environment (see the file-level note) — best-effort
    // per public documentation.
    //
    // This check must stay BEFORE the guard: "No data" is a comma-free
    // plain-text body, so the guard would otherwise classify a genuinely
    // unknown symbol as `unavailable` (a provider outage, retryable)
    // instead of `not_found`.
    if (text.trim().toLowerCase().startsWith("no data")) {
      throw new WolfError("not_found", `stooq series ${id} not found`);
    }

    // The fix for the defect this file's header describes. stooq.com now
    // answers HTTP 200 with a JavaScript proof-of-work challenge PAGE, and
    // `parseStooqCsv` below parses that page into ZERO ROWS rather than
    // failing — which the rest of the pipeline reports as a successful,
    // empty series. Guard before parsing, never after: once an HTML page
    // has been through a lenient parser there is nothing left to tell it
    // apart from a real day with no observations.
    guardCsvBody(text, {
      provider: "stooq",
      status: response.status,
      contentType: response.headers.get("content-type"),
    });

    return parseStooqCsv(text);
  }

  return { search, fetch: fetchSeries };
}
