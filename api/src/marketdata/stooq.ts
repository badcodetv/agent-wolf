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
 * NOTE on the fetch() happy path (see the sibling __fixtures__/README.md
 * and this ticket's Discovered Issues Log entry): stooq.com now sits
 * behind a client-side JavaScript proof-of-work challenge that returns
 * HTTP 200 with a challenge PAGE instead of CSV bytes for every plain HTTP
 * request (verified directly during this ticket, superseding an earlier
 * "HTTP 200 confirms it's reachable" check that only looked at the status
 * code). Recording a real CSV fixture is therefore blocked in this
 * environment for the same reason FRED's is — see the README. The parsing
 * logic below is written against Stooq's PUBLICLY DOCUMENTED CSV shape
 * (`Date,Open,High,Low,Close,Volume`), not verified against a live
 * response.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WolfError } from "../errors.js";
import type { RawMarketDataRow } from "./normalise.js";

export interface StooqTicker {
  /** Stooq's own symbol form, e.g. `spy.us`. Lower-case by convention. */
  symbol: string;
  name: string;
}

export interface MarketDataSearchResult {
  source: "fred" | "stooq";
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
  /** Defaults to the bundled `__fixtures__/stooq-tickers.json`. Injectable so
   * tests do not depend on the shape of the committed table. */
  tickers?: StooqTicker[];
}

const DEFAULT_TICKERS_PATH = fileURLToPath(
  new URL("./__fixtures__/stooq-tickers.json", import.meta.url),
);

function loadDefaultTickers(): StooqTicker[] {
  const raw = readFileSync(DEFAULT_TICKERS_PATH, "utf8");
  return JSON.parse(raw) as StooqTicker[];
}

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
  const tickers = options.tickers ?? loadDefaultTickers();

  async function search(query: string): Promise<{ results: MarketDataSearchResult[] }> {
    const needle = query.trim().toLowerCase();
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
      response = await fetchImpl(url.toString());
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
    if (text.trim().toLowerCase().startsWith("no data")) {
      throw new WolfError("not_found", `stooq series ${id} not found`);
    }

    return parseStooqCsv(text);
  }

  return { search, fetch: fetchSeries };
}
