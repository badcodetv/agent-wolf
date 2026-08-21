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
 * IMPORTANT — see this ticket's Discovered Issues Log entry: no
 * FRED_API_KEY is available to the executor in this environment
 * (FRED_API_KEY is unset, and an unkeyed request to api.stlouisfed.org
 * returns HTTP 400). Per this ticket's own acceptance criterion, that
 * makes recording a real fixture a BLOCKED step — logged, not
 * hand-substituted. Concretely this means:
 *   - The happy-path shape mapping below (series_search's field mapping;
 *     series_observations' "." missing-value sentinel omission) is
 *     implemented per FRED's PUBLICLY DOCUMENTED API shape, but is NOT
 *     covered by a test asserting it against a real recorded response —
 *     that test is the blocked step.
 *   - Error-mapping (the four WolfErrorKind branches) and the
 *     misconfigured-at-construction behaviour ARE covered by tests, using
 *     synthetic (hand-written, clearly-labelled-as-such) HTTP responses via
 *     undici MockAgent — this is generic status-code-branch testing, not a
 *     claim about FRED's exact response shape, and the ticket text
 *     explicitly permits it ("error mapping ... is testable without a
 *     key").
 */

import { WolfError } from "../errors.js";
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
}

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

  async function request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, baseUrl);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString());
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
      // coerced to "0". See the file-level note: this branch is not covered
      // by a fixture-backed test in this environment (blocked, no key).
      if (observation.value === ".") continue;
      rows.push({ timestamp: observation.date, value: observation.value });
    }
    return rows;
  }

  return { search, fetch: fetchSeries };
}
