import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createStooqClient, parseStooqCsv, type StooqTicker } from "./stooq.js";

const TEST_TICKERS: StooqTicker[] = [
  { symbol: "spy.us", name: "SPDR S&P 500 ETF Trust" },
  { symbol: "avav.us", name: "AeroVironment Inc" },
  { symbol: "qqq.us", name: "Invesco QQQ Trust" },
];

describe("marketdata_stooq", () => {
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

  describe("marketdata_ zero-HTTP Stooq search", () => {
    it("issues ZERO HTTP requests — undici's disableNetConnect would throw if it tried", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.invalid" });

      // No mockAgent.get(...).intercept(...) was set up above, and
      // disableNetConnect() is active, so ANY attempted HTTP call from
      // search() would reject. Resolving cleanly is the proof of "zero".
      await expect(client.search("avav")).resolves.toEqual({
        results: [
          {
            source: "stooq",
            id: "avav.us",
            title: "AeroVironment Inc",
            unit: "USD",
            frequency: "daily",
            first: null,
            last: null,
          },
        ],
      });
    });

    it("matches case-insensitively on symbol", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      const { results } = await client.search("SPY");
      expect(results.map((r) => r.id)).toEqual(["spy.us"]);
    });

    it("matches case-insensitively on name", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      const { results } = await client.search("aerovironment");
      expect(results.map((r) => r.id)).toEqual(["avav.us"]);
    });

    it("always reports unit USD and frequency daily, with first/last null", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      const { results } = await client.search("qqq");
      expect(results).toEqual([
        {
          source: "stooq",
          id: "qqq.us",
          title: "Invesco QQQ Trust",
          unit: "USD",
          frequency: "daily",
          first: null,
          last: null,
        },
      ]);
    });

    it("returns no results for a query matching nothing", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      const { results } = await client.search("nonexistent-ticker-xyz");
      expect(results).toEqual([]);
    });
  });

  // Parsing logic tested against Stooq's PUBLICLY DOCUMENTED CSV shape
  // (Date,Open,High,Low,Close,Volume) — this is a unit test of our own
  // parsing function given a known, documented format, NOT a claim that
  // this text was recorded from a live response. Recording a real fixture
  // is blocked in this environment — see __fixtures__/README.md and this
  // ticket's Discovered Issues Log entry (stooq.com returns a JS
  // proof-of-work bot-challenge page, HTTP 200, instead of CSV, for every
  // plain HTTP request; verified directly during this ticket).
  describe("parseStooqCsv (documented-shape parsing, not a recorded fixture)", () => {
    it("takes the Close column as the value, ignoring Open/High/Low/Volume", () => {
      const csv = "Date,Open,High,Low,Close,Volume\n2026-08-19,140.00,142.00,139.50,141.22,1000000\n";
      expect(parseStooqCsv(csv)).toEqual([{ timestamp: "2026-08-19", value: "141.22" }]);
    });

    it("parses multiple rows in file order", () => {
      const csv =
        "Date,Open,High,Low,Close,Volume\n" +
        "2026-08-19,140.00,142.00,139.50,141.22,1000000\n" +
        "2026-08-20,141.22,144.00,141.00,143.90,900000\n";
      expect(parseStooqCsv(csv)).toEqual([
        { timestamp: "2026-08-19", value: "141.22" },
        { timestamp: "2026-08-20", value: "143.90" },
      ]);
    });

    it("returns an empty array for a header-only body", () => {
      expect(parseStooqCsv("Date,Open,High,Low,Close,Volume\n")).toEqual([]);
    });
  });

  describe("marketdata_ stooq fetch error branches (synthetic HTTP status mapping, not a recorded fixture)", () => {
    it("maps a 404 to not_found", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .reply(404, "");

      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.test" });
      await expect(client.fetch("avav.us")).rejects.toMatchObject({ kind: "not_found" });
    });

    it("maps a literal 'No data' 200 body to not_found (documented Stooq behaviour for an unknown symbol)", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .reply(200, "No data");

      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.test" });
      await expect(client.fetch("nonexistent.us")).rejects.toMatchObject({ kind: "not_found" });
    });

    it("maps a 5xx to unavailable (retryable)", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .reply(503, "");

      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.test" });
      await expect(client.fetch("avav.us")).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("maps a connection failure to unavailable (retryable)", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .replyWithError(new Error("connection reset"));

      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.test" });
      await expect(client.fetch("avav.us")).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("maps an unrecognised 4xx to internal, never unavailable", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .reply(418, "");

      const client = createStooqClient({ tickers: TEST_TICKERS, baseUrl: "https://stooq.test" });
      const rejection = await client.fetch("avav.us").catch((err: unknown) => err);
      expect(rejection).toMatchObject({ kind: "internal" });
      expect((rejection as { kind: string }).kind).not.toBe("unavailable");
    });
  });
});
