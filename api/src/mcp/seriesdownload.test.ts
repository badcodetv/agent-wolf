/**
 * W7: the byte route — `GET /series/download?token=…`.
 *
 * design/2026-08-20-agent-wolf.md § W7 (agent-orange repo). Test names are
 * prefixed `mcp_` per the ticket. Nothing here reaches the network: every
 * connector is either injected or driven by a counting fake `fetch`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { createErrorHandler } from "../app.js";
import { createLogger } from "../logger.js";
import { normalise } from "../marketdata/normalise.js";
import {
  createSeriesDownloadRouter,
  SERIES_DOWNLOAD_PATH,
  signSeriesToken,
  verifySeriesToken,
  type SeriesTokenPayload,
} from "./seriesdownload.js";
import { createMarketDataAccess, type MarketDataAccess } from "./tools.js";

const SECRET = "test-series-secret-value-not-a-real-credential";

const CSV = normalise([
  { timestamp: "2026-01-02", value: "4.11" },
  { timestamp: "2026-01-03", value: "4.17" },
]);

/** An access double that records what it was asked for and hands back fixed bytes. */
function accessReturning(csv: string): MarketDataAccess & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async search() {
      throw new Error("search must not be called by the download route");
    },
    async resolve(source, id, from, to) {
      calls.push([source, id, from ?? "", to ?? ""].join("|"));
      return { csv, unit: source === "stooq" ? "USD" : null };
    },
  };
}

function appAround(router: express.Router): express.Express {
  const app = express();
  app.use(router);
  app.use(createErrorHandler(createLogger({ logLevel: "silent" })));
  return app;
}

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const nowSec = 1_800_000_000;

function token(overrides: Partial<SeriesTokenPayload> = {}, secret = SECRET): string {
  const payload: SeriesTokenPayload = {
    source: "fred",
    id: "DGS10",
    from: undefined,
    to: undefined,
    exp: nowSec + 300,
    ...overrides,
  };
  return signSeriesToken(payload, secret);
}

describe("mcp_series_download token", () => {
  it("round-trips a payload it signed", () => {
    const verified = verifySeriesToken(token(), SECRET, nowSec);
    expect(verified).toEqual({ source: "fred", id: "DGS10", exp: nowSec + 300 });
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifySeriesToken(token({}, "some-other-secret-entirely"), SECRET, nowSec)).toBeUndefined();
  });

  it("carries from/to when they were part of the minted scope", () => {
    const verified = verifySeriesToken(
      token({ source: "stooq", id: "avav.us", from: "2026-01-01", to: "2026-02-01" }),
      SECRET,
      nowSec,
    );
    expect(verified).toEqual({
      source: "stooq",
      id: "avav.us",
      from: "2026-01-01",
      to: "2026-02-01",
      exp: nowSec + 300,
    });
  });
});

describe("mcp_series_download route", () => {
  it("serves the canonical CSV bytes with text/csv and nosniff", async () => {
    const access = accessReturning(CSV);
    const base = await listen(
      appAround(createSeriesDownloadRouter({ secret: SECRET, access, nowSec: () => nowSec })),
    );

    const res = await fetch(`${base}${SERIES_DOWNLOAD_PATH}?token=${encodeURIComponent(token())}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(CSV);
    expect(access.calls).toEqual(["fred|DGS10||"]);
  });

  it("re-resolves exactly the (source, id, from, to) tuple the token names", async () => {
    const access = accessReturning(CSV);
    const base = await listen(
      appAround(createSeriesDownloadRouter({ secret: SECRET, access, nowSec: () => nowSec })),
    );

    const scoped = token({ source: "stooq", id: "avav.us", from: "2026-01-01", to: "2026-02-01" });
    const res = await fetch(`${base}${SERIES_DOWNLOAD_PATH}?token=${encodeURIComponent(scoped)}`);

    expect(res.status).toBe(200);
    expect(access.calls).toEqual(["stooq|avav.us|2026-01-01|2026-02-01"]);
  });

  // The four graded rejection cases. All four bodies must be byte-identical:
  // the route is not an existence oracle.
  describe("mcp_ four 403 rejections, all byte-identical", () => {
    // Self-contained (its own server, closed immediately) so the cases can
    // be compared side by side without leaking listeners.
    async function forbiddenBody(query: string): Promise<{ status: number; body: string }> {
      const access = accessReturning(CSV);
      const app = appAround(createSeriesDownloadRouter({ secret: SECRET, access, nowSec: () => nowSec }));
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${SERIES_DOWNLOAD_PATH}${query}`);
        const body = await res.text();
        // No provider is touched on any rejection.
        expect(access.calls).toEqual([]);
        return { status: res.status, body };
      } finally {
        server.close();
      }
    }

    it("403s a token minted for (fred, DGS10) used to fetch (stooq, avav.us)", async () => {
      const wrongSeries = `?source=stooq&id=avav.us&token=${encodeURIComponent(token())}`;
      expect((await forbiddenBody(wrongSeries)).status).toBe(403);
    });

    it("403s an expired token", async () => {
      const expired = `?token=${encodeURIComponent(token({ exp: nowSec - 1 }))}`;
      expect((await forbiddenBody(expired)).status).toBe(403);
    });

    it("403s a token whose payload was edited", async () => {
      const [payload, signature] = token().split(".");
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      decoded.id = "SP500";
      const tampered = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${signature}`;
      expect((await forbiddenBody(`?token=${encodeURIComponent(tampered)}`)).status).toBe(403);
    });

    it("403s a missing or malformed token parameter", async () => {
      expect((await forbiddenBody("")).status).toBe(403);
      expect((await forbiddenBody("?token=")).status).toBe(403);
      expect((await forbiddenBody("?token=not-a-token")).status).toBe(403);
    });

    it("returns byte-identical bodies for all four rejections", async () => {
      const [payload, signature] = token().split(".");
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      decoded.id = "SP500";
      const tampered = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${signature}`;

      const bodies = await Promise.all([
        forbiddenBody(`?source=stooq&id=avav.us&token=${encodeURIComponent(token())}`),
        forbiddenBody(`?token=${encodeURIComponent(token({ exp: nowSec - 1 }))}`),
        forbiddenBody(`?token=${encodeURIComponent(tampered)}`),
        forbiddenBody(""),
      ]);

      expect(new Set(bodies.map((b) => `${b.status} ${b.body}`)).size).toBe(1);
      for (const b of bodies) {
        expect(b.body).not.toContain("DGS10");
        expect(b.body).not.toContain("avav.us");
        expect(b.body).not.toContain(SECRET);
      }
    });
  });

  it("never leaks the signing secret in a response body", async () => {
    const access = accessReturning(CSV);
    const base = await listen(
      appAround(createSeriesDownloadRouter({ secret: SECRET, access, nowSec: () => nowSec })),
    );
    const res = await fetch(`${base}${SERIES_DOWNLOAD_PATH}?token=nonsense`);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("propagates an upstream failure as its typed status, not as a 403", async () => {
    const failing: MarketDataAccess = {
      async search() {
        throw new Error("unused");
      },
      async resolve() {
        const { WolfError } = await import("../errors.js");
        throw new WolfError("unavailable", "FRED request failed");
      },
    };
    const base = await listen(
      appAround(createSeriesDownloadRouter({ secret: SECRET, access: failing, nowSec: () => nowSec })),
    );
    const res = await fetch(`${base}${SERIES_DOWNLOAD_PATH}?token=${encodeURIComponent(token())}`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { kind: string }).kind).toBe("unavailable");
  });
});

describe("mcp_series_download uses the market-data cache", () => {
  it("issues ZERO HTTP requests when the cache is warm", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,4.11,10\n", { status: 200 }),
    );
    const access = createMarketDataAccess({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      now: () => nowSec * 1000,
    });

    // Warm the cache through the same path series_fetch uses.
    const warm = await access.resolve("stooq", "avav.us");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const base = await listen(
      appAround(createSeriesDownloadRouter({ secret: SECRET, access, nowSec: () => nowSec })),
    );
    const res = await fetch(
      `${base}${SERIES_DOWNLOAD_PATH}?token=${encodeURIComponent(token({ source: "stooq", id: "avav.us" }))}`,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(warm.csv);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still one: the download was a cache hit
  });
});
