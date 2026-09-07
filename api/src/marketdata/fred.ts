/**
 * The FRED connector.
 *
 * design/2026-08-20-agent-wolf.md § "Pinned technology choices": "the
 * KEYED JSON API on api.stlouisfed.org — /fred/series/observations and
 * /fred/series/search — never fredgraph.csv. The keyless CSV path has no
 * search endpoint and no metadata, which series_search requires."
 *
 * Nothing here reads `process.env` (W6 acceptance criterion):
 * `createFredClient({ apiKey, fetchImpl })` takes every input explicitly.
 * A missing or empty `apiKey` is `WolfError.misconfigured` naming
 * `FRED_API_KEY`, raised AT CONSTRUCTION, not at first call.
 *
 * W6b: the happy-path shape mapping below (series_search's field mapping;
 * series_observations' "." missing-value sentinel omission) is pinned by
 * `fred.test.ts` against two REAL recorded responses — see
 * `__fixtures__/fred-observations-dgs10.json`,
 * `__fixtures__/fred-search-treasury.json` and that directory's
 * README.md for the exact commands and the recording date. This closes
 * W6's deferred criteria (R55) — both were previously implemented only
 * per FRED's published docs, unverified against a real response.
 */

import { WolfError } from "../errors.js";
import { classifyBody, raiseBodyProblem } from "./guard.js";
import type { RawMarketDataRow } from "./normalise.js";
import type { MarketDataSearchResult } from "./stooq.js";

export interface MarketDataConnector {
  search(query: string): Promise<{ results: MarketDataSearchResult[] }>;
  fetch(id: string, from?: string, to?: string): Promise<RawMarketDataRow[]>;
}

export interface FredClientOptions {
  /** The `FRED_API_KEY` value. Required, non-empty. Validated at
   * construction, not at first call. */
  apiKey: string;
  /** Defaults to the global `fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** Defaults to `https://api.stlouisfed.org`. Overridable so tests never
   * hit the real host. */
  baseUrl?: string;
  /** Deadline for the underlying HTTP call, in milliseconds. Defaults to
   * `DEFAULT_TIMEOUT_MS`. The error taxonomy classifies "a 5xx, a
   * connection failure, or a TIMEOUT" as `unavailable` (retryable), but
   * nothing bounded the call itself until this fix round — see this
   * ticket's Discovered Issues Log entry. Read via an explicit option,
   * never `process.env`. */
  timeoutMs?: number;
}

/** Default HTTP deadline for a FRED request, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

interface FredSeriesSearchItem {
  id: string;
  title: string;
  units: string;
  frequency: string;
  observation_start: string;
  observation_end: string;
}

interface FredSeriesSearchResponse {
  // FRED's own (unusual) pluralisation of "series" in its JSON API.
  seriess?: FredSeriesSearchItem[];
}

interface FredErrorBody {
  error_code?: number;
  error_message?: string;
}

export function createFredClient(options: FredClientOptions): MarketDataConnector {
  if (!options.apiKey || options.apiKey.trim() === "") {
    throw WolfError.misconfigured("FRED_API_KEY", "FRED_API_KEY is required to construct a FRED client");
  }
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.stlouisfed.org";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, baseUrl);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new WolfError("unavailable", "FRED request failed", { cause: err });
    }

    if (response.status === 404) {
      throw new WolfError("not_found", "FRED series not found");
    }
    if (response.status >= 500) {
      throw new WolfError("unavailable", `FRED responded with status ${response.status}`);
    }

    const text = await response.text();

    // A provider that stops serving DATA must fail loudly and legibly, not
    // as a generic "internal error" whose message is thrown away — see
    // guard.ts's header for the Stooq defect this closes.
    //
    // Only the Stooq-class problems are reclassified here: an HTML page, a
    // browser-verification interstitial, a 429, or an EMPTY body (which the
    // `text ? JSON.parse(text) : {}` below would otherwise turn into `{}`,
    // then `observations ?? []`, then a successfully-written empty series —
    // the same silent-success shape). A body that is merely malformed JSON
    // still falls through to the `internal` classification R39 chose for
    // it, which `fred.test.ts` pins.
    const problem = classifyBody(text, {
      provider: "FRED",
      status: response.status,
      contentType: response.headers.get("content-type"),
      expected: "json",
    });
    if (problem) raiseBodyProblem(problem, text);

    if (!response.ok) {
      let body: FredErrorBody = {};
      try {
        body = text ? (JSON.parse(text) as FredErrorBody) : {};
      } catch {
        throw WolfError.internal(new Error(`FRED returned a non-JSON error body (status ${response.status})`));
      }
      const message = body.error_message ?? "";
      if (/does not exist/i.test(message)) {
        throw new WolfError("not_found", "FRED series not found", { upstreamBody: text });
      }
      if (/api_key|api key/i.test(message)) {
        throw WolfError.misconfigured("FRED_API_KEY", "FRED rejected the configured API key");
      }
      throw WolfError.internal(new Error(`unrecognised FRED error (status ${response.status})`));
    }

    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      throw WolfError.internal(err);
    }
  }

  async function search(query: string): Promise<{ results: MarketDataSearchResult[] }> {
    const body = await request<FredSeriesSearchResponse>("/fred/series/search", {
      search_text: query,
    });
    const items = body.seriess ?? [];
    const results: MarketDataSearchResult[] = items.map((item) => ({
      source: "fred" as const,
      id: item.id,
      title: item.title,
      unit: item.units,
      frequency: item.frequency,
      first: item.observation_start ?? null,
      last: item.observation_end ?? null,
    }));
    return { results };
  }

  async function fetchSeries(id: string, from?: string, to?: string): Promise<RawMarketDataRow[]> {
    const params: Record<string, string> = { series_id: id };
    if (from) params.observation_start = from;
    if (to) params.observation_end = to;

    const body = await request<FredObservationsResponse>("/fred/series/observations", params);
    const observations = body.observations ?? [];

    const rows: RawMarketDataRow[] = [];
    for (const observation of observations) {
      // FRED's missing-value sentinel: the row is OMITTED entirely, never
      // coerced to "0". Pinned by fred.test.ts against a real recorded
      // fixture (__fixtures__/fred-observations-dgs10.json, W6b).
      if (observation.value === ".") continue;
      rows.push({ timestamp: observation.date, value: observation.value });
    }
    return rows;
  }

  return { search, fetch: fetchSeries };
}
