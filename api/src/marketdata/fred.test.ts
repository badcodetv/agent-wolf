import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    it("a thrown error's serialised form never contains the FRED API key", async () => {
      const secretKey = "sk-super-secret-fred-key-do-not-leak";
      mockAgent
        .get("https://fred.test")
        .intercept({ path: /\/fred\/series\/observations.*/, method: "GET" })
        .reply(503, "");

      const client = createFredClient({ apiKey: secretKey, baseUrl: "https://fred.test" });
      const rejection = await client.fetch("DGS10").catch((err: unknown) => err);

      const serialised = JSON.stringify({
        message: (rejection as Error).message,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        details: (rejection as any).details,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upstreamBody: (rejection as any).upstreamBody,
      });
      expect(serialised).not.toContain(secretKey);
      expect(String(rejection)).not.toContain(secretKey);
    });
  });
});
