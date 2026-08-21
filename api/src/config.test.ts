import { describe, expect, it } from "vitest";
import { WolfError } from "./errors.js";
import {
  DEFAULT_GATEWAY_FALLBACK,
  loadConfig,
  parseDefaultGatewayFromProcRoute,
  resolveMcpUrl,
  type RouteSource,
} from "./config.js";

/** A fake /proc/net/route table with a default route via `gatewayIp`, formatted the way the real file is (tab-separated, header row included). */
function fakeRouteTable(gatewayIp: string): string {
  const octets = gatewayIp.split(".").map((n) => parseInt(n, 10));
  const gatewayHex = octets
    .slice()
    .reverse()
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    `eth0\t00000000\t${gatewayHex}\t0003\t0\t0\t0\t00000000\t0\t0\t0`,
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");
}

function routeSourceReturning(table: string | undefined): RouteSource {
  return { readRouteTable: () => table };
}

describe("loadConfig", () => {
  it("returns defaults on an empty env", () => {
    // A fake, empty route source: this test asserts the port/logLevel/nodeEnv
    // defaults, not gateway discovery (that has its own describe block below)
    // — and must not depend on whether the machine running it has a real
    // /proc/net/route (CI may not be Linux; a container may have none).
    const config = loadConfig({}, routeSourceReturning(undefined));
    expect(config.port).toBe(8100);
    expect(config.logLevel).toBe("info");
    expect(config.nodeEnv).toBe("development");
  });

  it("reads WOLF_API_PORT, LOG_LEVEL and NODE_ENV when set", () => {
    const config = loadConfig(
      { WOLF_API_PORT: "9100", LOG_LEVEL: "debug", NODE_ENV: "test" },
      routeSourceReturning(undefined),
    );
    expect(config.port).toBe(9100);
    expect(config.logLevel).toBe("debug");
    expect(config.nodeEnv).toBe("test");
  });

  it("fails fast naming WOLF_API_PORT when it is not a valid port", () => {
    expect(() => loadConfig({ WOLF_API_PORT: "not-a-number" })).toThrow(WolfError);
    try {
      loadConfig({ WOLF_API_PORT: "not-a-number" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("WOLF_API_PORT");
    }
  });

  it("fails fast naming LOG_LEVEL when it is not a known level", () => {
    try {
      loadConfig({ LOG_LEVEL: "very-loud" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("LOG_LEVEL");
    }
  });
});

// R43: "172.17.0.1 is a default, not a constant — discover it." Three
// resolution paths, each unit-tested with a fake route source so none of
// this depends on the real machine's networking.
describe("resolveMcpUrl / DinD gateway discovery", () => {
  it("path 1: an explicit WOLF_MCP_URL wins outright — discovery is not even attempted", () => {
    let called = false;
    const routeSource: RouteSource = {
      readRouteTable: () => {
        called = true;
        return fakeRouteTable("172.99.0.1");
      },
    };

    const resolved = resolveMcpUrl({ WOLF_MCP_URL: "http://example.internal:9000/mcp" }, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://example.internal:9000/mcp", source: "explicit" });
    expect(called).toBe(false);
  });

  it("path 2: no WOLF_MCP_URL — discovers the gateway from a fake default-route table", () => {
    const routeSource = routeSourceReturning(fakeRouteTable("172.24.176.1"));

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.24.176.1:8100/mcp", source: "discovered" });
  });

  it("path 2 uses the already-resolved port, not a hard-coded one", () => {
    const routeSource = routeSourceReturning(fakeRouteTable("172.18.0.1"));

    const resolved = resolveMcpUrl({}, 9100, routeSource);

    expect(resolved).toEqual({ url: "http://172.18.0.1:9100/mcp", source: "discovered" });
  });

  it("path 3: no WOLF_MCP_URL and no readable route table — falls back to 172.17.0.1", () => {
    const routeSource = routeSourceReturning(undefined);

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: `http://${DEFAULT_GATEWAY_FALLBACK}:8100/mcp`, source: "fallback" });
  });

  it("path 3: falls back when the route table has no default-route row (destination 00000000)", () => {
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: `http://${DEFAULT_GATEWAY_FALLBACK}:8100/mcp`, source: "fallback" });
  });

  it("path 3: falls back when the default-route row's gateway is 00000000 (directly connected, no gateway)", () => {
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        "eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved.source).toBe("fallback");
  });

  it("parseDefaultGatewayFromProcRoute decodes a real captured /proc/net/route line (172.24.176.1)", () => {
    // Captured verbatim from a real DinD-adjacent host: little-endian hex
    // "01B018AC" decodes to 172.24.176.1, matching `ip route show default`
    // on that same host.
    const real =
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
      "eth0\t00000000\t01B018AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0";

    expect(parseDefaultGatewayFromProcRoute(real)).toBe("172.24.176.1");
  });

  it("loadConfig wires resolveMcpUrl through with the routeSource parameter", () => {
    const routeSource = routeSourceReturning(fakeRouteTable("172.30.0.1"));

    const config = loadConfig({ WOLF_API_PORT: "8200" }, routeSource);

    expect(config.mcpUrl).toBe("http://172.30.0.1:8200/mcp");
    expect(config.mcpUrlSource).toBe("discovered");
  });
});

// ── W7: the market-data / MCP variables ─────────────────────────────────
//
// design/2026-08-20-agent-wolf.md § "Parallelism and file ownership": each
// ticket adds only the variables its own criteria name, and documents each
// in `.env.example`. W7 adds FRED_API_KEY and
// WOLF_MARKETDATA_CACHE_TTL_SECONDS (formally requested by W6's Notes) plus
// its own WOLF_MCP_TOKEN, WOLF_SERIES_TOKEN_SECRET and
// WOLF_SERIES_URL_TTL_SECONDS.
describe("loadConfig — W7 market-data and MCP variables", () => {
  const noRoutes = routeSourceReturning(undefined);
  const GOOD_TOKEN = "wolf-mcp-token-for-tests-0123456789abcdef";

  it("defaults: no FRED key, a 3600s cache TTL, a 300s series-URL TTL, and no MCP token", () => {
    const config = loadConfig({}, noRoutes);
    expect(config.fredApiKey).toBe("");
    expect(config.marketDataCacheTtlSeconds).toBe(3600);
    expect(config.seriesUrlTtlSeconds).toBe(300);
    expect(config.mcpToken).toBe("");
  });

  it("passes FRED_API_KEY through unchanged", () => {
    const config = loadConfig({ FRED_API_KEY: "abcdef0123456789abcdef0123456789" }, noRoutes);
    expect(config.fredApiKey).toBe("abcdef0123456789abcdef0123456789");
  });

  it("reads WOLF_MARKETDATA_CACHE_TTL_SECONDS as whole SECONDS", () => {
    const config = loadConfig({ WOLF_MARKETDATA_CACHE_TTL_SECONDS: "60" }, noRoutes);
    expect(config.marketDataCacheTtlSeconds).toBe(60);
  });

  it("fails fast naming WOLF_MARKETDATA_CACHE_TTL_SECONDS on a non-integer (e.g. a '5m' duration string)", () => {
    try {
      loadConfig({ WOLF_MARKETDATA_CACHE_TTL_SECONDS: "5m" }, noRoutes);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).message).toContain("WOLF_MARKETDATA_CACHE_TTL_SECONDS");
    }
  });

  it("reads WOLF_SERIES_URL_TTL_SECONDS and rejects one outside 1..3600", () => {
    expect(loadConfig({ WOLF_SERIES_URL_TTL_SECONDS: "60" }, noRoutes).seriesUrlTtlSeconds).toBe(60);
    for (const bad of ["0", "3601", "not-a-number"]) {
      try {
        loadConfig({ WOLF_SERIES_URL_TTL_SECONDS: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).message).toContain("WOLF_SERIES_URL_TTL_SECONDS");
      }
    }
  });

  // docker-compose forwards optional variables as `FOO: ${FOO:-}`, which
  // sets them to "" when the operator left them out of .env. Empty must
  // mean ABSENT, not 0 — a coerced 0 would be a 0-second cache TTL (never
  // cache) and an out-of-range URL TTL (refuse to boot).
  it("treats an EMPTY duration variable as absent, not as 0", () => {
    const config = loadConfig(
      {
        WOLF_MARKETDATA_CACHE_TTL_SECONDS: "",
        WOLF_SERIES_URL_TTL_SECONDS: "",
        FRED_API_KEY: "",
        WOLF_MCP_TOKEN: "",
        WOLF_SERIES_TOKEN_SECRET: "",
      },
      noRoutes,
    );
    expect(config.marketDataCacheTtlSeconds).toBe(3600);
    expect(config.seriesUrlTtlSeconds).toBe(300);
    expect(config.seriesTokenSecretSource).toBe("generated");
  });

  it("accepts a well-formed WOLF_MCP_TOKEN", () => {
    expect(loadConfig({ WOLF_MCP_TOKEN: GOOD_TOKEN }, noRoutes).mcpToken).toBe(GOOD_TOKEN);
  });

  it("fails fast naming WOLF_MCP_TOKEN when it is too short or carries a character the chain would mangle", () => {
    for (const bad of ["short", `${GOOD_TOKEN} `, "has spaces in it and is long enough to pass length", "$WOLF_MCP_TOKEN_0123456789abcdef"]) {
      try {
        loadConfig({ WOLF_MCP_TOKEN: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_MCP_TOKEN");
      }
    }
  });

  it("never echoes a rejected token's VALUE in the error it raises", () => {
    try {
      loadConfig({ WOLF_MCP_TOKEN: "sekrit-but-too-short" }, noRoutes);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect((err as WolfError).message).not.toContain("sekrit-but-too-short");
    }
  });

  it("generates a per-boot series-token secret when WOLF_SERIES_TOKEN_SECRET is unset", () => {
    const a = loadConfig({}, noRoutes);
    const b = loadConfig({}, noRoutes);
    expect(a.seriesTokenSecretSource).toBe("generated");
    expect(a.seriesTokenSecret.length).toBeGreaterThanOrEqual(32);
    // Freshly random per boot — not a committed constant.
    expect(a.seriesTokenSecret).not.toBe(b.seriesTokenSecret);
  });

  it("uses WOLF_SERIES_TOKEN_SECRET when set, and rejects one shorter than 32 characters", () => {
    const secret = "a-series-token-secret-of-sufficient-length";
    const config = loadConfig({ WOLF_SERIES_TOKEN_SECRET: secret }, noRoutes);
    expect(config.seriesTokenSecret).toBe(secret);
    expect(config.seriesTokenSecretSource).toBe("env");

    try {
      loadConfig({ WOLF_SERIES_TOKEN_SECRET: "too-short" }, noRoutes);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).message).toContain("WOLF_SERIES_TOKEN_SECRET");
    }
  });
});

// design/2026-08-20-agent-wolf.md, W12's Files line: "modify api/src/config.ts
// and .env.example (WOLF_BASE_IMAGE, WOLF_CRITIC_CRON only)".
describe("WOLF_BASE_IMAGE / WOLF_CRITIC_CRON (W12)", () => {
  const noRoutes = routeSourceReturning(undefined);

  it("defaults wolfBaseImage to agent-wolf:dev and criticCron to Mondays at 04:00", () => {
    const config = loadConfig({}, noRoutes);
    expect(config.wolfBaseImage).toBe("agent-wolf:dev");
    expect(config.criticCron).toBe("0 4 * * 1");
  });

  it("reads WOLF_BASE_IMAGE and WOLF_CRITIC_CRON when set", () => {
    const config = loadConfig(
      { WOLF_BASE_IMAGE: "agent-wolf:2026-08-21", WOLF_CRITIC_CRON: "30 5 * * 3" },
      noRoutes,
    );
    expect(config.wolfBaseImage).toBe("agent-wolf:2026-08-21");
    expect(config.criticCron).toBe("30 5 * * 3");
  });

  it("treats an empty WOLF_BASE_IMAGE as absent (R80's present() rule) and falls back to the default", () => {
    // Compose forwards an unset optional variable as "" via `${VAR:-}`, not
    // as absent — this is the same trap W7 documented for numeric variables,
    // and it applies here even though wolfBaseImage is a plain string: an
    // operator who leaves WOLF_BASE_IMAGE unset in .env must still get the
    // real default, not an empty base_image written into project settings.
    const config = loadConfig({ WOLF_BASE_IMAGE: "" }, noRoutes);
    expect(config.wolfBaseImage).toBe("agent-wolf:dev");
  });

  it("treats an empty WOLF_CRITIC_CRON as absent and falls back to the default", () => {
    const config = loadConfig({ WOLF_CRITIC_CRON: "" }, noRoutes);
    expect(config.criticCron).toBe("0 4 * * 1");
  });

  it("fails fast naming WOLF_CRITIC_CRON when it is a nickname Orange's schedule store rejects", () => {
    // go/agentdb/schedules.go:827 refuses `@weekly` and friends outright.
    for (const bad of ["@weekly", "@daily", "@hourly"]) {
      try {
        loadConfig({ WOLF_CRITIC_CRON: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_CRITIC_CRON");
      }
    }
  });

  it("fails fast naming WOLF_CRITIC_CRON when it does not have exactly five fields", () => {
    for (const bad of ["0 4 * *", "0 4 * * 1 *", "not-a-cron"]) {
      try {
        loadConfig({ WOLF_CRITIC_CRON: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_CRITIC_CRON");
      }
    }
  });

  it("accepts a 5-field cron with irregular whitespace between fields", () => {
    const config = loadConfig({ WOLF_CRITIC_CRON: "0   4 *\t* 1" }, noRoutes);
    expect(config.criticCron).toBe("0   4 *\t* 1");
  });
});
