import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createStooqClient, parseStooqCsv, type StooqTicker } from "./stooq.js";
import { DEFAULT_STOOQ_TICKERS } from "./stooq-tickers.js";

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

    // An empty needle makes `String.includes("")` true for every entry, so
    // an unguarded search("") would return the whole table — see this
    // ticket's Discovered Issues Log entry.
    it("returns no results for an empty query, rather than the whole table", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      await expect(client.search("")).resolves.toEqual({ results: [] });
    });

    it("returns no results for a whitespace-only query", async () => {
      const client = createStooqClient({ tickers: TEST_TICKERS });
      await expect(client.search("   ")).resolves.toEqual({ results: [] });
    });

    // No `tickers` option injected — exercises the shipped default table
    // (`DEFAULT_STOOQ_TICKERS`, imported from the TS module, not read from
    // a JSON file — see stooq-tickers.ts's header comment and this
    // ticket's Discovered Issues Log entry for why that distinction is
    // load-bearing for the built image).
    it("with no injected tickers, searches the committed default table and finds avav.us", async () => {
      const avav = DEFAULT_STOOQ_TICKERS.find((t) => t.symbol === "avav.us");
      // Guard the fixture itself, so a future edit that removes avav.us
      // from the default table fails with a clear message here rather
      // than a confusing `toEqual([])` below.
      expect(avav).toBeDefined();

      const client = createStooqClient({});
      const { results } = await client.search("avav");
      expect(results).toEqual([
        {
          source: "stooq",
          id: "avav.us",
          title: avav?.name,
          unit: "USD",
          frequency: "daily",
          first: null,
          last: null,
        },
      ]);
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

    // W10's poller has no bounded call unless the connector itself enforces
    // a deadline — see this ticket's Discovered Issues Log entry. A reply
    // delayed past a short injected `timeoutMs` must abort and map to
    // `unavailable`, not hang.
    it("a request exceeding timeoutMs aborts and maps to unavailable (retryable)", async () => {
      mockAgent
        .get("https://stooq.test")
        .intercept({ path: /\/q\/d\/l\/.*/, method: "GET" })
        .reply(200, "Date,Open,High,Low,Close,Volume\n2026-08-19,140,142,139.5,141.22,1000000\n")
        .delay(200);

      const client = createStooqClient({
        tickers: TEST_TICKERS,
        baseUrl: "https://stooq.test",
        timeoutMs: 10,
      });
      await expect(client.fetch("avav.us")).rejects.toMatchObject({ kind: "unavailable" });
    });
  });
});
