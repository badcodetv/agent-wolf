/**
 * The Yahoo Finance connector.
 *
 * 🔴 **Fixture provenance — read this before trusting a green run.**
 *
 * The chart and search bodies used below are **constructed to the observed
 * response shape, not recorded**. Yahoo throttles per IP for tens of
 * minutes at a time, and this environment was inside such a window for the
 * whole of this ticket: every request to `query1`/`query2` answered HTTP
 * 429 with the body `Too Many Requests` (that 429 body IS recorded, at
 * `__fixtures__/yahoo-429-body.txt`, and is used by `guard.test.ts`).
 *
 * The shape they are built to was verified against the live endpoint
 * earlier the same day — `GC=F` returned 1,261 daily bars for
 * 2021-09-07→2026-09-07 with an adjusted-close column present and a last
 * close of 4476.60 — but the bytes were not kept, so nothing here may be
 * described as a recorded fixture. This is the same honesty `stooq.ts`'s
 * header applies to its own parser: these are unit tests of OUR logic
 * against a documented shape, and they cannot catch Yahoo changing that
 * shape.
 *
 * `__fixtures__/README.md` § Yahoo carries the exact commands to record
 * the real thing, and `yahoo-recorded.test.ts` is the file to add when the
 * throttle clears. Until then the live-shape claim is testimony.
 */

import { describe, expect, it } from "vitest";
import { WolfError } from "../errors.js";
import { normalise } from "./normalise.js";
import {
  createYahooClient,
  DEFAULT_USER_AGENT,
  formatValue,
  pickValueSeries,
  rowsFromChartResult,
  searchTitle,
  searchUnit,
  tradingDate,
} from "./yahoo.js";

/** Records every request a client makes, so headers and URLs are assertable. */
function recordingFetch(
  body: string,
  init: { status?: number; contentType?: string } = {},
): { impl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, options?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((options?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(url), headers });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = "https://yahoo.test";

/** Epoch seconds for a UTC instant, so the date maths in tests is explicit. */
const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000);

/** EST / EDT, in seconds, as Yahoo reports them in `meta.gmtoffset`. */
const EST = -5 * 3600;
const EDT = -4 * 3600;

describe("yahoo_tradingDate maps a bar to the EXCHANGE's calendar date", () => {
  it("a US market open (09:30 New York) lands on that same date", () => {
    // 2026-01-02 09:30 EST is 14:30 UTC on the same date. Both conventions
    // agree here, which is exactly why a UTC-only implementation looks
    // correct for equities and then fails elsewhere.
    expect(tradingDate(utc(2026, 1, 2, 14, 30), EST)).toBe("2026-01-02");
  });

  it("a bar timestamped in the UTC small hours belongs to the PREVIOUS local date", () => {
    // 2026-01-03 02:00 UTC is 2026-01-02 21:00 in New York. An instrument
    // whose session runs into the evening (commodity futures on Globex)
    // produces exactly this, and reading the UTC date would file the bar
    // under the wrong day — shifting every percentage-change condition by
    // one observation.
    expect(tradingDate(utc(2026, 1, 3, 2, 0), EST)).toBe("2026-01-02");
  });

  it("a zero offset (crypto, quoted in UTC) is the UTC date", () => {
    expect(tradingDate(utc(2026, 1, 2, 0, 0), 0)).toBe("2026-01-02");
  });

  it("uses the offset it is given, so a DST change does not shift the date", () => {
    // Same wall-clock market open, before and after the US DST switch.
    expect(tradingDate(utc(2026, 6, 1, 13, 30), EDT)).toBe("2026-06-01");
    expect(tradingDate(utc(2026, 1, 2, 14, 30), EST)).toBe("2026-01-02");
  });
});

describe("yahoo_formatValue keeps the provider's number without rounding", () => {
  it("round-trips a float exactly", () => {
    // The canonical CSV's rule is no drift and no reformatting. `String`
    // gives the shortest text that parses back to the identical double.
    expect(Number(formatValue(4476.60009765625))).toBe(4476.60009765625);
    expect(formatValue(4476.6)).toBe("4476.6");
  });

  it("does NOT round to two decimal places", () => {
    // How many decimals a price carries is the provider's statement. A
    // `toFixed(2)` here would silently change what the dataset records.
    expect(formatValue(1.23456789)).toBe("1.23456789");
  });

  it("keeps an integer as an integer, not '1.00'", () => {
    expect(formatValue(100)).toBe("100");
  });
});

describe("yahoo_pickValueSeries prefers adjusted close", () => {
  it("takes adjclose when the instrument has one", () => {
    const picked = pickValueSeries({
      indicators: { quote: [{ close: [10, 20] }], adjclose: [{ adjclose: [5, 10] }] },
    });
    expect(picked).toEqual({ values: [5, 10], adjusted: true });
  });

  it("falls back to close when there is no adjusted column (futures, crypto)", () => {
    const picked = pickValueSeries({ indicators: { quote: [{ close: [10, 20] }] } });
    expect(picked).toEqual({ values: [10, 20], adjusted: false });
  });

  it("reports neither as null rather than picking something wrong", () => {
    expect(pickValueSeries({ indicators: { quote: [{}] } })).toBeNull();
    expect(pickValueSeries({})).toBeNull();
  });
});

describe("yahoo_rows turns a chart result into canonical rows", () => {
  const meta = { currency: "USD", symbol: "SPY", gmtoffset: EST };

  it("pairs each timestamp with its adjusted close, in the exchange's dates", () => {
    const rows = rowsFromChartResult(
      {
        meta,
        timestamp: [utc(2026, 1, 2, 14, 30), utc(2026, 1, 5, 14, 30)],
        indicators: { quote: [{ close: [1, 2] }], adjclose: [{ adjclose: [1.5, 2.5] }] },
      },
      "SPY",
    );
    expect(rows).toEqual([
      { timestamp: "2026-01-02", value: "1.5" },
      { timestamp: "2026-01-05", value: "2.5" },
    ]);
  });

  it("OMITS a null value — a holiday is an absent row, never a zero", () => {
    // The single most damaging thing a price connector can do is coerce a
    // missing observation to 0: a drawdown condition then fires on a
    // 100% fall that never happened. Same rule as FRED's "." sentinel.
    const rows = rowsFromChartResult(
      {
        meta,
        timestamp: [utc(2026, 1, 2, 14, 30), utc(2026, 1, 5, 14, 30), utc(2026, 1, 6, 14, 30)],
        indicators: { quote: [{ close: [1, null, 3] }] },
      },
      "SPY",
    );
    expect(rows).toEqual([
      { timestamp: "2026-01-02", value: "1" },
      { timestamp: "2026-01-06", value: "3" },
    ]);
    expect(rows.some((r) => r.value === "0")).toBe(false);
  });

  it("omits a NaN or Infinity as well", () => {
    const rows = rowsFromChartResult(
      {
        meta,
        timestamp: [utc(2026, 1, 2, 14, 30), utc(2026, 1, 5, 14, 30)],
        indicators: { quote: [{ close: [Number.NaN, Number.POSITIVE_INFINITY] }] },
      },
      "SPY",
    );
    expect(rows).toEqual([]);
  });

  it("an empty range is legitimately empty, not an error", () => {
    // A real symbol with no bars in the window: Yahoo omits `timestamp`
    // entirely and returns meta only.
    expect(rowsFromChartResult({ meta }, "SPY")).toEqual([]);
  });

  it("REFUSES a timestamp/value length mismatch rather than pairing by index", () => {
    // The arrays are positionally paired. Iterating the shorter of the two
    // would attach real prices to the wrong dates and report success.
    expect(() =>
      rowsFromChartResult(
        {
          meta,
          timestamp: [utc(2026, 1, 2, 14, 30), utc(2026, 1, 5, 14, 30), utc(2026, 1, 6, 14, 30)],
          indicators: { quote: [{ close: [1, 2] }] },
        },
        "SPY",
      ),
    ).toThrow(/3 timestamps but 2 values/);
  });

  it("REFUSES a result with bars but no value column at all", () => {
    expect(() =>
      rowsFromChartResult({ meta, timestamp: [utc(2026, 1, 2, 14, 30)], indicators: {} }, "SPY"),
    ).toThrow(/no close or adjusted-close/);
  });

  it("produces rows the canonical normaliser accepts unchanged", () => {
    const rows = rowsFromChartResult(
      {
        meta,
        timestamp: [utc(2026, 1, 5, 14, 30), utc(2026, 1, 2, 14, 30)],
        indicators: { quote: [{ close: [2, 1] }] },
      },
      "SPY",
    );
    // Yahoo returns ascending, but normalise sorts regardless — this pins
    // that the two agree on the timestamp FORMAT, which is the part that
    // would silently break.
    expect(normalise(rows)).toBe(
      "timestamp,value\n2026-01-02T00:00:00Z,1\n2026-01-05T00:00:00Z,2\n",
    );
  });
});

describe("yahoo_fetch builds the right request", () => {
  const chart = (result: unknown) => JSON.stringify({ chart: { result: [result], error: null } });
  const ONE_BAR = {
    meta: { currency: "USD", symbol: "GC=F", gmtoffset: EST },
    timestamp: [utc(2026, 1, 2, 14, 30)],
    indicators: { quote: [{ close: [4476.6] }] },
  };

  it("sends a browser-style User-Agent — without it Yahoo answers 429", () => {
    const { impl, calls } = recordingFetch(chart(ONE_BAR));
    return createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .then(() => {
        expect(calls[0]!.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
        expect(calls[0]!.headers["user-agent"]).toMatch(/Mozilla/);
      });
  });

  it("URL-ENCODES the symbol, because real ones contain = and ^", async () => {
    const { impl, calls } = recordingFetch(chart(ONE_BAR));
    const client = createYahooClient({ fetchImpl: impl, baseUrl: BASE });
    await client.fetch("GC=F");
    expect(calls[0]!.url).toContain("/v8/finance/chart/GC%3DF");
    await client.fetch("^GSPC");
    expect(calls[1]!.url).toContain("/v8/finance/chart/%5EGSPC");
  });

  it("asks for daily bars and the full history when no range is given", async () => {
    const { impl, calls } = recordingFetch(chart(ONE_BAR));
    await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).fetch("BTC-USD");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(url.searchParams.get("range")).toBe("max");
    expect(url.searchParams.get("period1")).toBeNull();
  });

  it("makes `to` INCLUSIVE, matching every other connector's `to`", async () => {
    const { impl, calls } = recordingFetch(chart(ONE_BAR));
    await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).fetch(
      "GC=F",
      "2026-01-02",
      "2026-01-05",
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("period1")).toBe(String(utc(2026, 1, 2)));
    // period2 is exclusive of the instant, so it must sit at the END of
    // 2026-01-05 or that day's bar is dropped.
    expect(url.searchParams.get("period2")).toBe(String(utc(2026, 1, 6)));
    expect(url.searchParams.get("range")).toBeNull();
  });

  it("refuses a `from` that is not YYYY-MM-DD instead of sending garbage", async () => {
    const { impl } = recordingFetch(chart(ONE_BAR));
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F", "last tuesday")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("invalid");
  });

  it("refuses to be built with an empty User-Agent", () => {
    // Every call would fail with a 429 that reads as an unrelated rate
    // limit. Failing at construction names the real cause.
    expect(() => createYahooClient({ userAgent: "   " })).toThrow(WolfError);
    expect(() => createYahooClient({ userAgent: "   " })).toThrow(/User-Agent/);
  });
});

describe("yahoo_errors distinguish a missing symbol from a broken provider", () => {
  it("Yahoo's own not-found error body is not_found", async () => {
    const body = JSON.stringify({
      chart: {
        result: null,
        error: { code: "Not Found", description: "No data found, symbol may be delisted" },
      },
    });
    const { impl } = recordingFetch(body, { status: 404 });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("NOSUCH")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("not_found");
  });

  it("a not-found error carried on a 200 is still not_found", async () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Not Found", description: "No data found" } },
    });
    const { impl } = recordingFetch(body, { status: 200 });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("NOSUCH")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("not_found");
  });

  it("any OTHER chart error is unavailable, not silently empty", async () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Internal Server Error", description: "boom" } },
    });
    const { impl } = recordingFetch(body, { status: 200 });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
  });

  it("a body with no chart result at all THROWS — it does not report 'no data today'", async () => {
    // The silent-empty-series shape. A response we cannot read must never
    // be indistinguishable from a genuine day with no observations.
    const { impl } = recordingFetch(JSON.stringify({ something: "else" }), { status: 200 });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).message).toMatch(/no chart result/);
  });

  it("a 429 comes through the guard as a readable rate-limit error", async () => {
    // The failure a caller will actually hit: Yahoo throttles per IP for
    // tens of minutes, and did so throughout this ticket.
    const { impl } = recordingFetch("Too Many Requests", { status: 429, contentType: "text/html" });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "rate_limited" });
    expect((err as WolfError).message).toMatch(/yahoo rate-limited/);
  });

  it("an HTML page — the way Stooq died — THROWS instead of parsing", async () => {
    const { impl } = recordingFetch("<!doctype html><html><body>hi</body></html>", {
      status: 200,
      contentType: "text/html",
    });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "html" });
  });

  it("a 5xx is unavailable", async () => {
    const { impl } = recordingFetch(JSON.stringify({ chart: { result: null } }), { status: 503 });
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
  });

  it("a transport failure is unavailable, and keeps the cause", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const err = await createYahooClient({ fetchImpl: impl, baseUrl: BASE })
      .fetch("GC=F")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).cause).toBeInstanceOf(Error);
  });
});

describe("yahoo_search maps Yahoo's own search endpoint", () => {
  const searchBody = JSON.stringify({
    quotes: [
      {
        symbol: "GC=F",
        shortname: "Gold",
        longname: "Gold",
        quoteType: "FUTURE",
        typeDisp: "Future",
        exchange: "CMX",
        exchDisp: "COMEX",
        isYahooFinance: true,
      },
      {
        symbol: "GLD",
        shortname: "SPDR Gold Shares",
        longname: "SPDR Gold Trust",
        quoteType: "ETF",
        typeDisp: "ETF",
        exchDisp: "NYSEArca",
        isYahooFinance: true,
      },
      // A hit with no symbol cannot be fetched, so it must not be offered.
      { shortname: "Gold Index", quoteType: "INDEX" },
    ],
  });

  it("hits /v1/finance/search with the query and no news", async () => {
    const { impl, calls } = recordingFetch(searchBody);
    await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).search("gold");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/finance/search");
    expect(url.searchParams.get("q")).toBe("gold");
    expect(url.searchParams.get("newsCount")).toBe("0");
  });

  it("returns one result per usable quote, tagged source 'yahoo'", async () => {
    const { impl } = recordingFetch(searchBody);
    const { results } = await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).search("gold");
    expect(results.map((r) => r.id)).toEqual(["GC=F", "GLD"]);
    expect(results.every((r) => r.source === "yahoo")).toBe(true);
    expect(results.every((r) => r.frequency === "daily")).toBe(true);
  });

  it("DROPS a hit with no symbol rather than offering a guaranteed failure", async () => {
    const { impl } = recordingFetch(searchBody);
    const { results } = await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).search("gold");
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.id === "")).toBe(false);
  });

  it("reports coverage as unknown rather than synthesising it", async () => {
    // Yahoo's search returns no first/last observation. Filling those in
    // would mean fetching every hit's full history to answer a search.
    const { impl } = recordingFetch(searchBody);
    const { results } = await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).search("gold");
    expect(results.every((r) => r.first === null && r.last === null)).toBe(true);
  });

  it("does not reach the network for an empty query", async () => {
    const { impl, calls } = recordingFetch(searchBody);
    const { results } = await createYahooClient({ fetchImpl: impl, baseUrl: BASE }).search("   ");
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("titles a hit with its fullest name plus type and exchange", () => {
    expect(
      searchTitle({ symbol: "GC=F", longname: "Gold", typeDisp: "Future", exchDisp: "COMEX" }),
    ).toBe("Gold (Future, COMEX)");
    expect(searchTitle({ symbol: "X", shortname: "Short only" })).toBe("Short only");
    expect(searchTitle({ symbol: "X" })).toBe("X");
  });

  it("reports an EMPTY unit rather than guessing USD", () => {
    // A guess would be wrong precisely where the unit matters: gold priced
    // in GBP, or a European ETF. Yahoo's search does not carry a currency.
    expect(searchUnit({ symbol: "GC=F" })).toBe("");
    expect(searchUnit({ symbol: "GC=F", currency: "USD" })).toBe("USD");
  });
});
