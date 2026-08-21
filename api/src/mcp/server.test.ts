/**
 * W7: the `wolf` MCP server — `series_search` and `series_fetch` over
 * Streamable HTTP, authenticated by the bare `X-Wolf-Mcp-Token` header.
 *
 * design/2026-08-20-agent-wolf.md § W7 (agent-orange repo). Test names are
 * prefixed `mcp_` per the ticket. No test reaches the network: every
 * connector is injected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { createErrorHandler } from "../app.js";
import { createLogger } from "../logger.js";
import { loadConfig } from "../config.js";
import { WolfError } from "../errors.js";
import type { MarketDataConnector, MarketDataSearchResult } from "../marketdata/stooq.js";
import type { RawMarketDataRow } from "../marketdata/normalise.js";
import { SERIES_DOWNLOAD_PATH, verifySeriesToken } from "./seriesdownload.js";
import { createMarketDataAccess, type MarketDataAccess } from "./tools.js";
import { createWolfMcp, MCP_PATH, MCP_SERVER_NAME, originFromMcpUrl } from "./server.js";

const TOKEN = "wolf-mcp-token-for-tests-0123456789abcdef";
const WRONG_SAME_LENGTH = "wolf-mcp-token-for-tests-0123456789abcdeF";
const WRONG_DIFFERENT_LENGTH = "short";
const SECRET = "test-series-secret-value-not-a-real-credential";
const FRED_KEY = "fred-api-key-for-tests-never-real";

const FRED_ROWS: RawMarketDataRow[] = [
  { timestamp: "2026-01-02", value: "4.11" },
  { timestamp: "2026-01-03", value: "4.17" },
];

/** A connector double that records every call, so "the provider was not touched" is assertable. */
function connectorDouble(): MarketDataConnector & { searchCalls: string[]; fetchCalls: string[] } {
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];
  return {
    searchCalls,
    fetchCalls,
    async search(query: string) {
      searchCalls.push(query);
      const results: MarketDataSearchResult[] = [
        {
          source: "fred",
          id: "DGS10",
          title: "10-Year Treasury Constant Maturity Rate",
          unit: "Percent",
          frequency: "Daily",
          first: "1962-01-02",
          last: "2026-01-03",
        },
      ];
      return { results };
    },
    async fetch(id: string, from?: string, to?: string) {
      fetchCalls.push([id, from ?? "", to ?? ""].join("|"));
      return FRED_ROWS;
    },
  };
}

function stooqDouble(): MarketDataConnector {
  return {
    async search() {
      return {
        results: [
          {
            source: "stooq" as const,
            id: "avav.us",
            title: "AeroVironment",
            unit: "USD",
            frequency: "daily",
            first: null,
            last: null,
          },
        ],
      };
    },
    async fetch() {
      return [{ timestamp: "2026-01-02", value: "180.5" }];
    },
  };
}

interface Harness {
  base: string;
  fred: ReturnType<typeof connectorDouble>;
  access: MarketDataAccess;
}

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

async function harness(
  options: { mcpOrigin?: string; access?: MarketDataAccess } = {},
): Promise<Harness> {
  const fred = connectorDouble();
  const access =
    options.access ??
    createMarketDataAccess({ connectors: { fred, stooq: stooqDouble() } });
  const { mcpRouter, seriesDownloadRouter } = createWolfMcp({
    mcpOrigin: options.mcpOrigin ?? "http://172.17.0.1:8100",
    mcpToken: TOKEN,
    seriesSecret: SECRET,
    seriesUrlTtlSec: 300,
    marketdata: access,
  });
  const app = express();
  app.use(mcpRouter);
  app.use(seriesDownloadRouter);
  app.use(createErrorHandler(createLogger({ logLevel: "silent" })));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, fred, access };
}

async function rpc(
  base: string,
  body: unknown,
  headers: Record<string, string> = { "x-wolf-mcp-token": TOKEN },
): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

function callTool(name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

/** Replays a minted download URL's path+query against the test server. */
function localise(base: string, downloadUrl: string): string {
  const url = new URL(downloadUrl);
  return `${base}${url.pathname}${url.search}`;
}

function toolPayload(result: any): any {
  return JSON.parse(result.result.content[0].text);
}

describe("mcp_server identity", () => {
  it("is named wolf, so its tools are mcp__wolf__series_search / mcp__wolf__series_fetch", () => {
    expect(MCP_SERVER_NAME).toBe("wolf");
  });

  it("answers initialize with serverInfo.name = wolf", async () => {
    const { base } = await harness();
    const res = await rpc(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(res.json.result.serverInfo.name).toBe("wolf");
  });
});

describe("mcp_auth rejects an unauthenticated or wrongly-authenticated call", () => {
  it("rejects a call with no header at all, without touching the provider", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {});
    expect(res.status).toBe(401);
    expect(fred.searchCalls).toEqual([]);
    expect(fred.fetchCalls).toEqual([]);
  });

  it("rejects a call with an empty header, without touching the provider", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {
      "x-wolf-mcp-token": "",
    });
    expect(res.status).toBe(401);
    expect(fred.searchCalls).toEqual([]);
  });

  it("rejects a wrong token of the SAME length, without touching the provider", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {
      "x-wolf-mcp-token": WRONG_SAME_LENGTH,
    });
    expect(WRONG_SAME_LENGTH.length).toBe(TOKEN.length);
    expect(res.status).toBe(401);
    expect(fred.searchCalls).toEqual([]);
  });

  it("rejects a wrong token of a DIFFERENT length, without touching the provider", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {
      "x-wolf-mcp-token": WRONG_DIFFERENT_LENGTH,
    });
    expect(res.status).toBe(401);
    expect(fred.searchCalls).toEqual([]);
  });

  // The scheme cannot silently diverge from W12's project MCP config:
  // Orange can only store a whole-value ${VAR} reference, never
  // "Bearer ${WOLF_MCP_TOKEN}" (go/agentdb/sessions.go:55,88-89).
  it("rejects Authorization: Bearer <valid token> when X-Wolf-Mcp-Token is absent", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(fred.searchCalls).toEqual([]);
  });

  it("never echoes the expected token in a rejection body", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }), {});
    expect(res.text).not.toContain(TOKEN);
  });

  it("accepts the bare token with no scheme prefix", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury" }));
    expect(res.status).toBe(200);
    expect(fred.searchCalls).toEqual(["treasury"]);
  });
});

describe("mcp_tools_list schema", () => {
  it("lists both tools with complete JSON Schema", async () => {
    const { base } = await harness();
    const res = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools: any[] = res.json.result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(["series_fetch", "series_search"]);

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      const schema = tool.inputSchema;
      expect(schema.type).toBe("object");
      for (const [param, spec] of Object.entries<any>(schema.properties)) {
        expect(spec.type, `${tool.name}.${param} has a type`).toBeTruthy();
        expect(spec.description, `${tool.name}.${param} has a description`).toBeTruthy();
        expect(String(spec.description).length).toBeGreaterThan(0);
      }
    }

    // `required` lists exactly the non-optional parameters.
    expect(byName.series_search.inputSchema.required).toEqual(["query"]);
    expect([...byName.series_fetch.inputSchema.required].sort()).toEqual(["id", "source"]);

    // `source` is an enum of exactly ["fred","stooq"] on both tools.
    expect(byName.series_search.inputSchema.properties.source.enum).toEqual(["fred", "stooq"]);
    expect(byName.series_fetch.inputSchema.properties.source.enum).toEqual(["fred", "stooq"]);

    // from/to document their format as YYYY-MM-DD.
    expect(byName.series_fetch.inputSchema.properties.from.description).toContain("YYYY-MM-DD");
    expect(byName.series_fetch.inputSchema.properties.to.description).toContain("YYYY-MM-DD");

    // Both descriptions tell the model to curl the URL to a FILE rather
    // than echo it or print the bytes.
    for (const tool of tools) {
      expect(tool.description).toContain("curl");
      expect(tool.description).toContain("FILE");
      expect(tool.description.toLowerCase()).toContain("do not print");
    }
    // …and series_search states that Stooq results omit first/last.
    expect(byName.series_search.description).toContain("null");
  });
});

describe("mcp_series_search", () => {
  it("returns the { source, id, title, unit, frequency, first, last } shape", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "treasury", source: "fred" }));
    const payload = toolPayload(res.json);
    expect(payload.results[0]).toEqual({
      source: "fred",
      id: "DGS10",
      title: "10-Year Treasury Constant Maturity Rate",
      unit: "Percent",
      frequency: "Daily",
      first: "1962-01-02",
      last: "2026-01-03",
    });
  });

  it("returns Stooq results with first/last null", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "aero", source: "stooq" }));
    const payload = toolPayload(res.json);
    expect(payload.results[0].first).toBeNull();
    expect(payload.results[0].last).toBeNull();
  });

  it("searches both sources when source is omitted", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_search", { query: "a" }));
    const payload = toolPayload(res.json);
    expect(payload.results.map((r: any) => r.source)).toEqual(["fred", "stooq"]);
  });
});

describe("mcp_series_fetch", () => {
  it("returns { download_url, expires_at_sec, rows, unit, source, id } and no CSV", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_fetch", { source: "fred", id: "DGS10" }));
    const payload = toolPayload(res.json);

    expect(Object.keys(payload).sort()).toEqual([
      "download_url",
      "expires_at_sec",
      "id",
      "rows",
      "source",
      "unit",
    ]);
    expect(payload.source).toBe("fred");
    expect(payload.id).toBe("DGS10");
    // rows comes from countDataRows over the normalised bytes: two rows.
    expect(payload.rows).toBe(2);
    expect(typeof payload.expires_at_sec).toBe("number");
    // unix SECONDS, not milliseconds — a ms value would be ~1e12.
    expect(payload.expires_at_sec).toBeLessThan(1e11);
  });

  // The graded no-CSV case: the bytes stay out of the model's context.
  it("returns NO CSV in the tool result body — neither the header nor a data row", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_fetch", { source: "fred", id: "DGS10" }));
    expect(res.text).not.toContain("timestamp,value");
    expect(res.text).not.toContain("2026-01-02T00:00:00Z,4.11");
    expect(res.text).not.toContain("4.17");
  });

  it("mints a single-series-scoped token the download route accepts", async () => {
    const { base } = await harness();
    const res = await rpc(
      base,
      callTool("series_fetch", { source: "fred", id: "DGS10", from: "2026-01-01", to: "2026-02-01" }),
    );
    const payload = toolPayload(res.json);
    const url = new URL(payload.download_url);
    expect(url.pathname).toBe(SERIES_DOWNLOAD_PATH);

    const verified = verifySeriesToken(
      url.searchParams.get("token") ?? undefined,
      SECRET,
      Math.floor(Date.now() / 1000),
    );
    expect(verified).toMatchObject({
      source: "fred",
      id: "DGS10",
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(verified!.exp).toBe(payload.expires_at_sec);

    // And the URL actually serves the bytes. The minted origin is the
    // configured DinD-gateway one (asserted in `mcp_download_url origin`),
    // which nothing listens on in a unit test — so the path and query, the
    // parts under test here, are replayed against the test server.
    const download = await fetch(localise(base, payload.download_url));
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("timestamp,value\n2026-01-02T00:00:00Z,4.11\n2026-01-03T00:00:00Z,4.17\n");
  });

  it("reports rows equal to countDataRows over the bytes the download serves", async () => {
    const { base } = await harness();
    const res = await rpc(base, callTool("series_fetch", { source: "fred", id: "DGS10" }));
    const payload = toolPayload(res.json);
    const download = await fetch(localise(base, payload.download_url));
    const csv = await download.text();
    const { countDataRows } = await import("../marketdata/normalise.js");
    expect(payload.rows).toBe(countDataRows(csv));
  });

  it("rejects an unknown source with an invalid-argument tool error, without touching a provider", async () => {
    const { base, fred } = await harness();
    const res = await rpc(base, callTool("series_fetch", { source: "bloomberg", id: "X" }));
    expect(res.json.result.isError).toBe(true);
    expect(fred.fetchCalls).toEqual([]);
  });
});

describe("mcp_download_url origin", () => {
  // R43: the origin follows the RESOLVED mcpUrl (which may have been
  // DISCOVERED at boot), never process.env.WOLF_MCP_URL — reading the raw
  // variable yields undefined in exactly the deployment R43 exists for.
  it("follows a DISCOVERED mcpUrl, not the (unset) WOLF_MCP_URL variable", async () => {
    const discovered = loadConfig(
      { WOLF_API_PORT: "8100", WOLF_MCP_TOKEN: TOKEN },
      {
        readRouteTable: () =>
          [
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
            "eth0\t00000000\t0100B0AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
          ].join("\n"),
      },
    );
    expect(discovered.mcpUrlSource).toBe("discovered");
    expect(discovered.mcpUrl).toBe("http://172.176.0.1:8100/mcp");

    const { base } = await harness({ mcpOrigin: originFromMcpUrl(discovered.mcpUrl) });
    const res = await rpc(base, callTool("series_fetch", { source: "fred", id: "DGS10" }));
    const payload = toolPayload(res.json);
    expect(payload.download_url.startsWith("http://172.176.0.1:8100/")).toBe(true);
  });

  it("derives an origin from an mcpUrl, dropping its /mcp path", () => {
    expect(originFromMcpUrl("http://172.17.0.1:8100/mcp")).toBe("http://172.17.0.1:8100");
    expect(originFromMcpUrl("https://wolf.example.com/mcp")).toBe("https://wolf.example.com");
  });
});

describe("mcp_error propagation", () => {
  async function toolErrorFor(err: unknown): Promise<any> {
    const failing: MarketDataAccess = {
      async search() {
        throw err;
      },
      async resolve() {
        throw err;
      },
    };
    const { base } = await harness({ access: failing });
    const res = await rpc(base, callTool("series_fetch", { source: "fred", id: "DGS10" }));
    expect(res.json.result.isError).toBe(true);
    return { payload: toolPayload(res.json), text: res.text };
  }

  it("propagates not_found unchanged", async () => {
    const { payload } = await toolErrorFor(new WolfError("not_found", "FRED series not found"));
    expect(payload.error.kind).toBe("not_found");
    expect(payload.error.retryable).toBe(false);
  });

  it("propagates unavailable as a distinguishable RETRYABLE kind", async () => {
    const { payload } = await toolErrorFor(new WolfError("unavailable", "FRED request failed"));
    expect(payload.error.kind).toBe("unavailable");
    expect(payload.error.retryable).toBe(true);
  });

  it("propagates misconfigured naming the variable, never its value", async () => {
    const { payload, text } = await toolErrorFor(WolfError.misconfigured("FRED_API_KEY"));
    expect(payload.error.kind).toBe("misconfigured");
    expect(payload.error.message).toContain("FRED_API_KEY");
    expect(text).not.toContain(FRED_KEY);
  });

  it("maps an unrecognised throw to internal — never unavailable — and never echoes its message", async () => {
    const { payload } = await toolErrorFor(new Error(`boom ${SECRET} ${TOKEN}`));
    expect(payload.error.kind).toBe("internal");
    expect(payload.error.retryable).toBe(false);
    expect(payload.error.message).toBe("internal error");
  });

  it("never leaks the MCP token, the signing secret or the FRED key in a tool error body", async () => {
    const { text } = await toolErrorFor(new Error(`boom ${SECRET} ${TOKEN} ${FRED_KEY}`));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(FRED_KEY);
  });
});

describe("mcp_factory refuses to build without its credentials", () => {
  const marketdata = createMarketDataAccess({ connectors: { fred: connectorDouble() } });

  it("throws misconfigured naming WOLF_MCP_TOKEN when the token is empty", () => {
    expect(() =>
      createWolfMcp({
        mcpOrigin: "http://172.17.0.1:8100",
        mcpToken: "",
        seriesSecret: SECRET,
        marketdata,
      }),
    ).toThrow(/WOLF_MCP_TOKEN/);
  });

  it("throws misconfigured naming WOLF_SERIES_TOKEN_SECRET when the secret is empty", () => {
    expect(() =>
      createWolfMcp({
        mcpOrigin: "http://172.17.0.1:8100",
        mcpToken: TOKEN,
        seriesSecret: "",
        marketdata,
      }),
    ).toThrow(/WOLF_SERIES_TOKEN_SECRET/);
  });
});

describe("mcp_marketdata access", () => {
  it("constructs the FRED connector lazily, so a missing key does not stop wolf-api booting", async () => {
    const access = createMarketDataAccess({ fredApiKey: "" });
    await expect(access.resolve("fred", "DGS10")).rejects.toThrow(/FRED_API_KEY/);
    // …while Stooq keeps working (no key involved).
    const stooqFetch = vi.fn(
      async () =>
        new Response("Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,180.5,10\n", { status: 200 }),
    );
    const stooqAccess = createMarketDataAccess({
      fredApiKey: "",
      fetchImpl: stooqFetch as unknown as typeof fetch,
    });
    await expect(stooqAccess.resolve("stooq", "avav.us")).resolves.toMatchObject({ unit: "USD" });
  });

  it("normalises through W6's normalise() and reports unit USD for stooq, null for fred", async () => {
    const access = createMarketDataAccess({ connectors: { fred: connectorDouble(), stooq: stooqDouble() } });
    await expect(access.resolve("fred", "DGS10")).resolves.toEqual({
      csv: "timestamp,value\n2026-01-02T00:00:00Z,4.11\n2026-01-03T00:00:00Z,4.17\n",
      unit: null,
    });
    await expect(access.resolve("stooq", "avav.us")).resolves.toEqual({
      csv: "timestamp,value\n2026-01-02T00:00:00Z,180.5\n",
      unit: "USD",
    });
  });
});
