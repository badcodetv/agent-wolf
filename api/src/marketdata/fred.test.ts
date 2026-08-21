import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createFredClient } from "./fred.js";

// ─────────────────────────────────────────────────────────────────────────
// W6b: a real FRED_API_KEY was made available and two real fixtures were
// recorded against api.stlouisfed.org — see __fixtures__/README.md for the
// exact commands and the date. The two describe blocks below
// ("real recorded fixture") replace W6's deferred criteria (R55): the "."
// missing-value-sentinel omission and series_search's field mapping are now
// pinned against those recorded responses, not hand-written ones.
//
// What was ALREADY tested here, per the ticket's explicit allowance ("error
// mapping ... is testable without a key"): misconfigured-at-construction,
// and the four WolfErrorKind branches using SYNTHETIC (hand-written, not
// recorded) HTTP responses via undici MockAgent — generic status-code-branch
// coverage, not a claim about FRED's exact real response shape. Those are
// unchanged below.
// ─────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("marketdata_fred", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  describe("marketdata_ misconfigured at construction", () => {
    it("throws WolfError.misconfigured naming FRED_API_KEY when apiKey is missing, AT CONSTRUCTION not first call", () => {
      expect(() => createFredClient({ apiKey: "" })).toThrowError(
        expect.objectContaining({ kind: "misconfigured", details: { variable: "FRED_API_KEY" } }),
      );
    });

    it("throws the same for a whitespace-only apiKey", () => {
      expect(() => createFredClient({ apiKey: "   " })).toThrowError(
        expect.objectContaining({ kind: "misconfigured" }),
      );
    });

    it("does not throw for a non-empty apiKey, and makes no HTTP call at construction", () => {
      expect(() => createFredClient({ apiKey: "test-key-not-a-real-secret" })).not.toThrow();
    });
  });

  // A fix-round finding caught that every other case in this file passes
  // `baseUrl: "https://fred.test"`, so nothing ever exercised the DEFAULT
  // host/path this ticket's first acceptance criterion is actually about
  // ("the endpoint is the keyed JSON API on api.stlouisfed.org,
  // /fred/series/observations and /fred/series/search, never
  // fredgraph.csv"). These two cases construct the client with NO
  // `baseUrl`, so a wrong default host or path makes the MockAgent
  // interceptor miss and the assertion fail — this is NOT blocked by the
  // missing FRED_API_KEY, since it only pins host, path and the `api_key`
  // /`file_type` query parameters, never a real credential or response
  // body.
  describe("marketdata_ default baseUrl (api.stlouisfed.org, never fredgraph.csv)", () => {
    it("fetch(): hits the default host at /fred/series/observations with api_key and file_type=json", async () => {
      mockAgent
        .get("https://api.stlouisfed.org")
        .intercept({
          method: "GET",
          path: (path) =>
            path.startsWith("/fred/series/observations?") &&
            /(?:\?|&)api_key=test-key(?:&|$)/.test(path) &&
            /(?:\?|&)file_type=json(?:&|$)/.test(path),
        })
        .reply(503, "");

      const client = createFredClient({ apiKey: "test-key" }); // no baseUrl — default host
      await expect(client.fetch("DGS10")).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("search(): hits the default host at /fred/series/search with api_key and file_type=json", async () => {
      mockAgent
        .get("https://api.stlouisfed.org")
        .intercept({
          method: "GET",
          path: (path) =>
            path.startsWith("/fred/series/search?") &&
            /(?:\?|&)api_key=test-key(?:&|$)/.test(path) &&
            /(?:\?|&)file_type=json(?:&|$)/.test(path),
        })
        .reply(503, "");

      const client = createFredClient({ apiKey: "test-key" }); // no baseUrl — default host
      await expect(client.search("treasury")).rejects.toMatchObject({ kind: "unavailable" });
    });
  });

  // W6b: replays __fixtures__/fred-observations-dgs10.json, a REAL response
  // recorded 2026-08-21 (see that directory's README.md for the exact
  // command and date) for DGS10, observation_start=2024-12-20,
  // observation_end=2025-01-03 — a range chosen because it spans both
  // Christmas Day and New Year's Day, on which FRED's business-daily
  // series carries the "." missing-value sentinel. Closes W6's deferred
  // criterion (R55): "A fixture contains one [the "." sentinel] and pins
  // the omission."
  describe("marketdata_ fetch(): '.' missing-value sentinel omission (real recorded fixture)", () => {
    it("omits every '.' observation entirely — never coerces it to 0 — and keeps every real value", async () => {
      const fixture = loadFixture("fred-observations-dgs10.json");

      mockAgent
        .get("https://fred.test")
        .intercept({ path: /^\/fred\/series\/observations\?.*series_id=DGS10.*$/, method: "GET" })
        .reply(200, JSON.stringify(fixture), { headers: { "content-type": "application/json" } });

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      const rows = await client.fetch("DGS10", "2024-12-20", "2025-01-03");

      // The recorded fixture has 11 observations; two ("2024-12-25" and
      // "2025-01-01") are the "." sentinel and must be OMITTED — not
      // present with value "0" or value ".".
      expect(rows).toHaveLength(9);
      const timestamps = rows.map((row) => row.timestamp);
      expect(timestamps).not.toContain("2024-12-25");
      expect(timestamps).not.toContain("2025-01-01");
      expect(rows.some((row) => row.value === "0")).toBe(false);
      expect(rows.some((row) => row.value === ".")).toBe(false);

      // Pin the survivors exactly, in provider order, verbatim strings.
      expect(rows).toEqual([
        { timestamp: "2024-12-20", value: "4.52" },
        { timestamp: "2024-12-23", value: "4.59" },
        { timestamp: "2024-12-24", value: "4.59" },
        { timestamp: "2024-12-26", value: "4.58" },
        { timestamp: "2024-12-27", value: "4.62" },
        { timestamp: "2024-12-30", value: "4.55" },
        { timestamp: "2024-12-31", value: "4.58" },
        { timestamp: "2025-01-02", value: "4.57" },
        { timestamp: "2025-01-03", value: "4.6" },
      ]);
    });
  });

  // W6b: replays __fixtures__/fred-search-treasury.json, a REAL response
  // recorded 2026-08-21 for search_text=treasury&limit=5 (see that
  // directory's README.md). Closes W6's deferred criterion (R55):
  // series_search's field mapping — title, units, frequency,
  // observation_start, observation_end onto
  // { source, id, title, unit, frequency, first, last } — pinned against a
  // real recorded response rather than FRED's published docs alone.
  describe("marketdata_ search(): field mapping (real recorded fixture)", () => {
    it("maps every real seriess item onto {source, id, title, unit, frequency, first, last}", async () => {
      const fixture = loadFixture("fred-search-treasury.json") as { seriess: unknown[] };

      mockAgent
        .get("https://fred.test")
        .intercept({ path: /^\/fred\/series\/search\?.*search_text=treasury.*$/, method: "GET" })
        .reply(200, JSON.stringify(fixture), { headers: { "content-type": "application/json" } });

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      const { results } = await client.search("treasury");

      expect(results).toHaveLength(fixture.seriess.length);
      expect(results.length).toBeGreaterThan(0);

      // Every real item maps id/title/units→unit/frequency/observation_start→first/observation_end→last,
      // with source pinned to "fred" and no extra/missing keys.
      for (const [index, item] of (fixture.seriess as Record<string, unknown>[]).entries()) {
        expect(results[index]).toEqual({
          source: "fred",
          id: item.id,
          title: item.title,
          unit: item.units,
          frequency: item.frequency,
          first: item.observation_start,
          last: item.observation_end,
        });
      }

      // Pin the first real item exactly, so a future FRED response-shape
      // change (e.g. units renamed, or search re-ranked) fails loudly
      // rather than only via the generic loop above.
      expect(results[0]).toEqual({
        source: "fred",
        id: "T10Y2Y",
        title: "10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity",
        unit: "Percent",
        frequency: "Daily",
        first: "1976-06-01",
        last: "2026-08-20",
      });
    });
  });

  describe("marketdata_ error branches (synthetic HTTP responses, not a recorded fixture)", () => {
    it("not_found: an upstream 404 maps to kind not_found", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(404, "");

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      await expect(client.fetch("NOTASERIES")).rejects.toMatchObject({ kind: "not_found" });
    });

    it("not_found: FRED's 'series does not exist' error body maps to kind not_found even on a non-404 status", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(400, JSON.stringify({ error_code: 400, error_message: "Bad Request. The series does not exist." }), {
          headers: { "content-type": "application/json" },
        });

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      await expect(client.fetch("NOTASERIES")).rejects.toMatchObject({ kind: "not_found" });
    });

    it("unavailable (retryable): a 5xx maps to kind unavailable", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(503, "");

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      await expect(client.fetch("DGS10")).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("unavailable (retryable): a connection failure maps to kind unavailable", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .replyWithError(new Error("connection reset"));

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      await expect(client.fetch("DGS10")).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("misconfigured: a rejected credential (not just a missing one) maps to kind misconfigured naming FRED_API_KEY", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(
          400,
          JSON.stringify({ error_code: 400, error_message: "Bad Request. The value for api_key is invalid." }),
          { headers: { "content-type": "application/json" } },
        );

      const client = createFredClient({ apiKey: "wrong-key", baseUrl: "https://fred.test" });
      const rejection = await client.fetch("DGS10").catch((err: unknown) => err);
      expect(rejection).toMatchObject({ kind: "misconfigured", details: { variable: "FRED_API_KEY" } });
    });

    it("internal: an unrecognised throw maps to kind internal, NEVER unavailable (R39)", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(200, "this is not valid JSON {{{", { headers: { "content-type": "application/json" } });

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test" });
      const rejection = await client.fetch("DGS10").catch((err: unknown) => err);
      expect(rejection).toMatchObject({ kind: "internal" });
      expect((rejection as { kind: string }).kind).not.toBe("unavailable");
    });

    // A fix-round finding caught that the 503 branch used below builds its
    // message from a status code only (fred.ts's `unavailable` branch)
    // and attaches neither `cause` nor `upstreamBody`, so the key could
    // not appear there under any implementation — the check was close to
    // a tautology. The two branches that DO carry foreign data are
    // `cause: err` (a failed fetch, fred.ts's `unavailable` catch) and
    // `upstreamBody: text` (the not-found-with-body branch); those are
    // exercised below, and the serialisation now also inspects `cause`
    // and `stack` (via `util.inspect`, not just a hand-built
    // message/details/upstreamBody object) so a leak through either field
    // would be caught.
    function assertNoLeak(rejection: unknown, secretKey: string): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = rejection as any;
      const serialised = JSON.stringify({
        message: err.message,
        details: err.details,
        upstreamBody: err.upstreamBody,
      });
      expect(serialised).not.toContain(secretKey);
      expect(String(rejection)).not.toContain(secretKey);
      expect(inspect(rejection, { depth: null })).not.toContain(secretKey);
      expect(inspect(err.cause, { depth: null })).not.toContain(secretKey);
      expect(String(err.stack ?? "")).not.toContain(secretKey);
    }

    it("connection-failure branch (cause: err): serialised form (incl. cause and stack) never contains the FRED API key", async () => {
      const secretKey = "sk-super-secret-fred-key-do-not-leak";
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .replyWithError(new Error("connection reset"));

      const client = createFredClient({ apiKey: secretKey, baseUrl: "https://fred.test" });
      const rejection = await client.fetch("DGS10").catch((err: unknown) => err);

      expect(rejection).toMatchObject({ kind: "unavailable" });
      assertNoLeak(rejection, secretKey);
    });

    it("not_found-with-upstreamBody branch: serialised form (incl. cause and stack) never contains the FRED API key", async () => {
      const secretKey = "sk-super-secret-fred-key-do-not-leak";
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(400, JSON.stringify({ error_code: 400, error_message: "Bad Request. The series does not exist." }), {
          headers: { "content-type": "application/json" },
        });

      const client = createFredClient({ apiKey: secretKey, baseUrl: "https://fred.test" });
      const rejection = await client.fetch("NOTASERIES").catch((err: unknown) => err);

      expect(rejection).toMatchObject({ kind: "not_found" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((rejection as any).upstreamBody).toBeTruthy();
      assertNoLeak(rejection, secretKey);
    });

    // W10's poller has no bounded call unless the connector itself enforces
    // a deadline — see this ticket's Discovered Issues Log entry. A reply
    // delayed past a short injected `timeoutMs` must abort and map to
    // `unavailable`, not hang.
    it("a request exceeding timeoutMs aborts and maps to unavailable (retryable)", async () => {
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(200, JSON.stringify({ observations: [] }), { headers: { "content-type": "application/json" } })
        .delay(200);

      const client = createFredClient({ apiKey: "test-key", baseUrl: "https://fred.test", timeoutMs: 10 });
      await expect(client.fetch("DGS10")).rejects.toMatchObject({ kind: "unavailable" });
    });
  });
});
