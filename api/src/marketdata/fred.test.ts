import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createFredClient } from "./fred.js";

// ─────────────────────────────────────────────────────────────────────────
// NO FRED_API_KEY IS AVAILABLE IN THIS ENVIRONMENT (verified: FRED_API_KEY
// is unset, and an unkeyed request to api.stlouisfed.org returns HTTP 400).
// Per this ticket's own acceptance criterion, recording a real fixture is
// therefore a BLOCKED step: this file does NOT contain a happy-path test
// asserting series_search's field mapping or the "." missing-value
// sentinel omission against a recorded response — see
// __fixtures__/README.md and this ticket's Discovered Issues Log entry.
//
// What IS tested here, per the ticket's explicit allowance ("error mapping
// ... is testable without a key"): misconfigured-at-construction, and the
// four WolfErrorKind branches using SYNTHETIC (hand-written, not recorded)
// HTTP responses via undici MockAgent — generic status-code-branch
// coverage, not a claim about FRED's exact real response shape.
// ─────────────────────────────────────────────────────────────────────────

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
