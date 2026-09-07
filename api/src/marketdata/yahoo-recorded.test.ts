/**
 * The Yahoo connector, against REAL RECORDED RESPONSES.
 *
 * `yahoo.test.ts` tests our logic against the response shape. This file is
 * the other half: five bodies captured from the live endpoint on
 * **2026-09-07** with the exact commands in `__fixtures__/README.md`. It
 * exists because a shape test cannot catch the thing that actually goes
 * wrong with an unofficial API — a field that is not where you assumed, a
 * timestamp that means something other than you thought, an "optional"
 * field that is null on every real row.
 *
 * It has already earned its keep. Recording these settled four claims the
 * shape tests could not, and TWO OF THEM WERE WRONG in the first draft of
 * `yahoo.ts` (see R264 and the corrected file header):
 *
 *   - futures and crypto DO carry an adjusted-close column (the header said
 *     they do not);
 *   - a search hit has no `currency` field at all, so the "read it when
 *     present" branch never fires in practice;
 *   - `GC=F` bars are timestamped at 05:00 UTC on most days and 14:30 UTC on
 *     a half-day, which the exchange-offset conversion handles and a naive
 *     UTC read would also survive HERE but not in general;
 *   - the not-found body is `chart.error.code === "Not Found"` on an HTTP
 *     404, exactly as handled.
 *
 * 🔴 **Do not "fix" a failure here by editing a fixture.** These are
 * recordings. A failure means either our code drifted or Yahoo changed, and
 * the second one is the whole reason this file exists — re-record with the
 * README's commands and read the diff.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WolfError } from "../errors.js";
import { normalise } from "./normalise.js";
import {
  createYahooClient,
  DEFAULT_USER_AGENT,
  pickValueSeries,
  rowsFromChartResult,
  searchTitle,
  searchUnit,
} from "./yahoo.js";

const dir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const raw = (name: string) => readFileSync(`${dir}${name}`, "utf8");
const load = (name: string) => JSON.parse(raw(name));

const GCF = "yahoo-chart-gcf.json";
const GLD = "yahoo-chart-gld.json";
const BTC = "yahoo-chart-btcusd.json";
const SEARCH = "yahoo-search-gold.json";
const NOTFOUND = "yahoo-chart-notfound.json";

/** Serves one recorded body, and records the request so headers are assertable. */
function servingFixture(name: string, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, options?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((options?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(url), headers });
    return new Response(raw(name), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (name: string, status = 200) => {
  const { impl, calls } = servingFixture(name, status);
  return { client: createYahooClient({ fetchImpl: impl, baseUrl: "https://yahoo.test" }), calls };
};

describe("yahoo_recorded_gcf: gold futures, the series FRED cannot provide", () => {
  const result = load(GCF).chart.result[0];

  it("is COMEX gold, priced in USD, on the New York exchange clock", () => {
    expect(result.meta.symbol).toBe("GC=F");
    expect(result.meta.currency).toBe("USD");
    expect(result.meta.instrumentType).toBe("FUTURE");
    expect(result.meta.exchangeTimezoneName).toBe("America/New_York");
    // -14400s = UTC-4, i.e. EDT. The connector reads this rather than
    // assuming an offset.
    expect(result.meta.gmtoffset).toBe(-14400);
  });

  it("carries an adjusted-close column — the header used to claim futures do not", () => {
    const picked = pickValueSeries(result);
    expect(picked?.adjusted).toBe(true);
  });

  it("its adjusted close equals its close over this window, so preferring adj changes nothing HERE", () => {
    // Stated so the equality is a recorded fact rather than an assumption:
    // no dividend or split falls in these three weeks. The preference still
    // matters for a multi-year equity series, which is why it exists.
    const close: Array<number | null> = result.indicators.quote[0].close;
    const adj: Array<number | null> = result.indicators.adjclose[0].adjclose;
    expect(adj).toEqual(close);
  });

  it("maps its bars onto the RIGHT trading dates, including the Christmas Eve half-day", async () => {
    // The real timestamps in this fixture are NOT uniform: most sit at
    // 05:00 UTC (01:00 New York) and 2025-12-24 sits at 14:30 UTC (10:30
    // New York). Both must land on their own calendar date.
    const { client: c } = client(GCF);
    const rows = await c.fetch("GC=F", "2025-12-19", "2026-01-06");
    const dates = rows.map((r) => r.timestamp);
    expect(dates).toContain("2025-12-19");
    expect(dates).toContain("2025-12-24");
    // Christmas Day and New Year's Day are absent entirely — the market has
    // no bar, rather than a null one. No gap filling, per the canonical CSV.
    expect(dates).not.toContain("2025-12-25");
    expect(dates).not.toContain("2026-01-01");
    // Strictly ascending, no duplicates: a date-conversion bug would most
    // likely show up as two bars collapsing onto one day.
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it("keeps Yahoo's full float precision, unrounded", async () => {
    const { client: c } = client(GCF);
    const rows = await c.fetch("GC=F", "2025-12-19", "2026-01-06");
    // 4361.39990234375 is what Yahoo really sends for 2025-12-19. Rounding
    // it here would be us editing the provider's statement.
    expect(rows[0]).toEqual({ timestamp: "2025-12-19", value: "4361.39990234375" });
  });

  it("produces a canonical CSV a dataset_put would accept", async () => {
    const { client: c } = client(GCF);
    const csv = normalise(await c.fetch("GC=F", "2025-12-19", "2026-01-06"));
    expect(csv.startsWith("timestamp,value\n2025-12-19T00:00:00Z,4361.39990234375\n")).toBe(true);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.endsWith("\n\n")).toBe(false);
  });

  it("sends the honest User-Agent — the spoofed browser one is what Yahoo 429s", async () => {
    const { client: c, calls } = client(GCF);
    await c.fetch("GC=F");
    expect(calls[0]!.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(calls[0]!.headers["user-agent"]).toContain("agent-wolf");
    // The regression guard for R264: this file shipped a full Chrome string
    // as its default on the belief that a browser UA was REQUIRED, which is
    // the opposite of what the endpoint does.
    expect(calls[0]!.headers["user-agent"]).not.toMatch(/Chrome\//);
    expect(calls[0]!.headers["user-agent"]).not.toMatch(/KHTML/);
  });
});

describe("yahoo_recorded_gld: an ETF, where adjusted close will eventually matter", () => {
  const result = load(GLD).chart.result[0];

  it("is the SPDR gold ETF on NYSEArca's clock, with an adjusted column", () => {
    expect(result.meta.symbol).toBe("GLD");
    expect(result.meta.instrumentType).toBe("ETF");
    expect(result.meta.currency).toBe("USD");
    expect(pickValueSeries(result)?.adjusted).toBe(true);
  });

  it("its bars are timestamped at the 09:30 New York open, not at midnight", async () => {
    // 14:30 UTC − 4h = 10:30 local… which is 09:30 standard time reported
    // during DST. The point is that it is mid-morning local, hours from
    // either midnight, so the date is unambiguous for equities.
    expect(result.timestamp[0]).toBe(1766154600);
    const { client: c } = client(GLD);
    const rows = await c.fetch("GLD", "2025-12-19", "2026-01-06");
    expect(rows[0]!.timestamp).toBe("2025-12-19");
  });
});

describe("yahoo_recorded_btcusd: crypto, quoted in UTC with no market holidays", () => {
  const result = load(BTC).chart.result[0];

  it("has a ZERO exchange offset, so local dates are UTC dates", () => {
    expect(result.meta.symbol).toBe("BTC-USD");
    expect(result.meta.instrumentType).toBe("CRYPTOCURRENCY");
    expect(result.meta.gmtoffset).toBe(0);
    expect(result.meta.exchangeTimezoneName).toBe("UTC");
  });

  it("trades every calendar day — 20 consecutive bars where gold has 11", async () => {
    // The contrast that makes the holiday handling visible: over the same
    // window crypto has a bar every day and gold does not.
    const { client: c } = client(BTC);
    const rows = await c.fetch("BTC-USD", "2025-12-19", "2026-01-06");
    expect(rows).toHaveLength(20);
    expect(rows[0]!.timestamp).toBe("2025-12-19");
    // Christmas Day IS present here, unlike gold.
    expect(rows.map((r) => r.timestamp)).toContain("2025-12-25");
  });

  it("carries an adjusted column too", () => {
    expect(pickValueSeries(result)?.adjusted).toBe(true);
  });
});

describe("yahoo_recorded_search: what a search hit really contains", () => {
  const body = load(SEARCH);

  it("finds gold futures and gold ETFs for the query 'gold'", async () => {
    const { client: c } = client(SEARCH);
    const { results } = await c.search("gold");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("GC=F");
    expect(ids).toContain("GLD");
    expect(ids).toContain("GDX");
    expect(results.every((r) => r.source === "yahoo")).toBe(true);
  });

  it("reports NO unit, because a real search hit has no `currency` FIELD AT ALL", () => {
    // Corrected while writing this file: the first draft asserted the key
    // was present and null. It is ABSENT — on all six hits, equity, futures
    // and ETF alike. (The wrong version came from reading the fixture with
    // Python's dict.get(), which returns None for a missing key just as
    // happily as for a null value. Two different facts, one output.)
    //
    // So `searchUnit`'s string branch is dead in practice, and guessing
    // "USD" here would have been a fabrication.
    for (const quote of body.quotes) {
      expect(Object.hasOwn(quote, "currency")).toBe(false);
      expect(searchUnit(quote)).toBe("");
    }
  });

  it("titles a futures hit from `shortname`, because `longname` is null on those", () => {
    const gcf = body.quotes.find((q: { symbol: string }) => q.symbol === "GC=F");
    expect(gcf.longname ?? null).toBeNull();
    expect(gcf.shortname).toBe("Gold Dec 26");
    expect(searchTitle(gcf)).toBe("Gold Dec 26 (Futures, New York Commodity Exchange)");
  });

  it("titles an ETF hit from `longname` when it has one", () => {
    const gld = body.quotes.find((q: { symbol: string }) => q.symbol === "GLD");
    expect(searchTitle(gld)).toBe("SPDR Gold Shares (ETF, NYSEArca)");
  });

  it("reports coverage as unknown — the real response carries none", () => {
    const first = body.quotes[0];
    expect(Object.hasOwn(first, "observation_start")).toBe(false);
    expect(Object.hasOwn(first, "firstTradeDate")).toBe(false);
  });
});

describe("yahoo_recorded_notfound: an unknown symbol", () => {
  it("is HTTP 404 with chart.error.code 'Not Found', and maps to not_found", async () => {
    const body = load(NOTFOUND);
    expect(body.chart.result).toBeNull();
    expect(body.chart.error.code).toBe("Not Found");
    expect(body.chart.error.description).toBe("No data found, symbol may be delisted");

    const { client: c } = client(NOTFOUND, 404);
    const err = await c.fetch("NOTAREALTICKER123").catch((e: unknown) => e as WolfError);
    expect(err).toBeInstanceOf(WolfError);
    expect((err as WolfError).kind).toBe("not_found");
  });
});

describe("yahoo_recorded_guard: a recorded body still goes through the guard first", () => {
  it("the 429 body Yahoo really sends is classified, not parsed", async () => {
    // `yahoo-429-body.txt` is what a blocked User-Agent gets. Reaching this
    // through the connector proves the guard runs before any field is read,
    // on the actual bytes rather than a stand-in.
    const impl = (async () =>
      new Response(raw("yahoo-429-body.txt"), {
        status: 429,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const c = createYahooClient({ fetchImpl: impl, baseUrl: "https://yahoo.test" });
    const err = await c.fetch("GC=F").catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "rate_limited" });
  });

  it("LIMIT: a recorded GOOD body passes the guard untouched", async () => {
    const { client: c } = client(GCF);
    await expect(c.fetch("GC=F")).resolves.toBeInstanceOf(Array);
  });

  it("every chart fixture round-trips through rowsFromChartResult without throwing", () => {
    for (const name of [GCF, GLD, BTC]) {
      const rows = rowsFromChartResult(load(name).chart.result[0], name);
      expect(rows.length).toBeGreaterThan(0);
      // No zeroes: a coerced null would show up here.
      expect(rows.every((r) => Number(r.value) > 0)).toBe(true);
      // Every timestamp is a bare ISO date, which is what normalise expects.
      expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.timestamp))).toBe(true);
    }
  });
});
