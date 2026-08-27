import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WolfError } from "./errors.js";
import { parseTemplate } from "./report/template.js";
import {
  DEFAULT_ORANGE_PUBLIC_URL,
  DEFAULT_WOLF_POLL_INTERVAL_SECONDS,
  loadConfig,
  parseDocker0GatewayFromProcRoute,
  resolveMcpUrl,
  type RouteSource,
} from "./config.js";

/**
 * Encodes a dotted-decimal IPv4 address the way /proc/net/route holds it:
 * 8 hex characters, **little-endian byte order** (172.17.0.0 → "000011AC").
 */
function procRouteHex(ip: string): string {
  return ip
    .split(".")
    .map((n) => parseInt(n, 10))
    .reverse()
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * A fake /proc/net/route table as read from **inside DinD's netns**,
 * formatted the way the real file is (tab-separated, header row included).
 *
 * 🔴 The two arguments are the whole of W33 (R235). Under compose they name
 * DIFFERENT networks: `defaultVia` is the OUTER compose-network gateway,
 * which nothing inside a nested session container can reach, and
 * `docker0Network` is DinD's INNER bridge, which is the address a session
 * container actually uses. **A fixture that puts both on the same network
 * cannot fail, and is the reason the wrong-route probe survived every
 * ticket that consumed its answer.** Omit `docker0Network` to model a table
 * that has a default route and no docker0 bridge at all.
 */
function fakeRouteTable(opts: { defaultVia: string; docker0Network?: string }): string {
  // eth0's OWN /16, directly connected — the row a real table carries
  // alongside the default route, and 🔴 the one an interface-blind probe
  // picks up instead of docker0's. It is emitted BEFORE the docker0 row,
  // which is the order that makes an interface-blind probe answer wrongly.
  const ethNetwork = opts.defaultVia.split(".").slice(0, 2).concat(["0", "0"]).join(".");
  const rows = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    `eth0\t00000000\t${procRouteHex(opts.defaultVia)}\t0003\t0\t0\t0\t00000000\t0\t0\t0`,
    `eth0\t${procRouteHex(ethNetwork)}\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0`,
  ];
  if (opts.docker0Network !== undefined) {
    rows.push(
      `docker0\t${procRouteHex(opts.docker0Network)}\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0`,
    );
  }
  return rows.join("\n");
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

// R43 + 🔴 W33/R235: "172.17.0.1 is a default, not a constant — discover it."
// R43 got the FALLBACK right and the DISCOVERY wrong: it read DinD's
// **default route**, which under compose is the OUTER compose-network
// gateway, not DinD's inner **docker0** bridge — the one address a nested
// session container can reach. X1 measured the pair from inside a nested
// container: 172.17.0.1:8100/mcp → 401 (reachable), 172.26.0.1:8100/mcp →
// exit 7 (cannot connect), while the probe had discovered 172.26.0.1.
//
// 🔴 Every fixture below therefore puts the default route and docker0 on
// DIFFERENT networks. They agree on a plain Docker install and differ under
// compose, so a fixture where they agree passes either way and proves
// nothing.
describe("resolveMcpUrl / DinD gateway discovery", () => {
  it("path 1: an explicit WOLF_MCP_URL wins outright — discovery is not even attempted", () => {
    let called = false;
    const routeSource: RouteSource = {
      readRouteTable: () => {
        called = true;
        return fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.17.0.0" });
      },
    };

    const resolved = resolveMcpUrl({ WOLF_MCP_URL: "http://example.internal:9000/mcp" }, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://example.internal:9000/mcp", source: "explicit" });
    expect(called).toBe(false);
  });

  it("path 1: an explicit WOLF_MCP_URL wins even when the probe WOULD have found a docker0 gateway", () => {
    // The escape hatch is the only reason the R235 defect was survivable —
    // X1's rig sets the variable, so it was unaffected. A "discovery also
    // runs and wins" regression would take that hatch away.
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.18.0.0" }),
    );

    const resolved = resolveMcpUrl({ WOLF_MCP_URL: "http://wolf-api.internal:8100/mcp" }, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://wolf-api.internal:8100/mcp", source: "explicit" });
    // The claim this case carries that its sibling above does not: the
    // explicit value beats a LIVE discovered answer, not merely an absent one.
    expect(resolved.url).not.toContain("172.18.0.1");
  });

  it("path 1: an EMPTY WOLF_MCP_URL is treated as unset, so discovery still runs (R80)", () => {
    // 🔴 Load-bearing, and it is the compose stack's ordinary state:
    // `docker-compose.yml:33` forwards `WOLF_MCP_URL: ${WOLF_MCP_URL:-}`, so
    // an operator who has NOT set the variable gets "" in the container, not
    // absence. Discovery only ever runs because "" is falsy here — treating
    // "" as an explicit value would make every session's mcpUrl the empty
    // string, which fails the same silent way a wrong gateway does.
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.18.0.0" }),
    );

    const resolved = resolveMcpUrl({ WOLF_MCP_URL: "" }, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.18.0.1:8100/mcp", source: "discovered" });
  });

  it("path 2: discovers DinD's docker0 gateway, NOT the default route (R235)", () => {
    // Exactly X1's measured compose reading: default route 172.26.0.1 (the
    // outer compose network — exit 7 from a nested container), docker0
    // 172.17.0.0/16 (401 — reachable).
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.17.0.0" }),
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "discovered" });
    expect(resolved.url).not.toContain("172.26.0.1");
  });

  it("path 2: follows docker0 onto a NON-default subnet — so neither the default route nor the literal fallback can pass this", () => {
    // R43's own reproduction: Docker allocates 172.18.0.0/16 for docker0
    // when 172.17.0.0/16 is already taken. 172.18.0.1 is neither the
    // default-route address nor the 172.17.0.1 fallback, so this is the
    // case that separates a real probe from either wrong answer.
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.18.0.0" }),
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.18.0.1:8100/mcp", source: "discovered" });
    expect(resolved.url).not.toContain("172.26.0.1");
    expect(resolved.url).not.toContain("172.17.0.1");
  });

  it("path 2 uses the already-resolved port, not a hard-coded one", () => {
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.18.0.0" }),
    );

    const resolved = resolveMcpUrl({}, 9100, routeSource);

    expect(resolved).toEqual({ url: "http://172.18.0.1:9100/mcp", source: "discovered" });
  });

  it("path 3: no WOLF_MCP_URL and no readable route table — falls back to 172.17.0.1", () => {
    const routeSource = routeSourceReturning(undefined);

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "fallback" });
  });

  it("path 3: a table with a default route but NO docker0 row falls back — the default route is never used as the gateway", () => {
    // 🔴 The inversion of the R235 defect, pinned: the old probe answered
    // "http://172.26.0.1:8100/mcp" (source `discovered`) for this exact
    // table, and an interface-blind one would answer the same from eth0's
    // directly-connected row. dockerd may not have created docker0 yet when wolf-api boots,
    // and the documented default is a better answer than an address on the
    // wrong side of the bridge.
    const routeSource = routeSourceReturning(fakeRouteTable({ defaultVia: "172.26.0.1" }));

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "fallback" });
    expect(resolved.url).not.toContain("172.26.0.1");
  });

  it("path 3: falls back when docker0's destination is malformed", () => {
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        "eth0\t00000000\t01001AAC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
        "docker0\tnothex11\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "fallback" });
  });

  it("ignores a docker0 row that routes THROUGH a gateway, and takes the directly-connected subnet", () => {
    // A docker0 row whose Gateway is not 00000000 is a route to somewhere
    // ELSE that happens to leave via the bridge; its Destination is not the
    // bridge's own network, so deriving the bridge address from it is wrong.
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        "eth0\t00000000\t01001AAC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
        // 10.99.0.0 via 172.17.0.9, out of docker0 — must be skipped.
        "docker0\t0000630A\t090011AC\t0003\t0\t0\t0\t0000FFFF\t0\t0\t0\n" +
        // docker0's own directly-connected subnet, 172.18.0.0/16.
        "docker0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.18.0.1:8100/mcp", source: "discovered" });
    // 10.99.0.1 is what the skipped, routed-through row would have yielded.
    expect(resolved.url).not.toContain("10.99.0.1");
  });

  it("ignores a docker0 row whose destination is 00000000 rather than deriving 0.0.0.1 from it", () => {
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        "docker0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "fallback" });
  });

  it("ignores a docker0 network whose last octet is 255, rather than deriving a .256", () => {
    const routeSource = routeSourceReturning(
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
        // 172.18.0.255 — not a network address; +1 would be 172.18.0.256.
        "docker0\tFF0012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    );

    const resolved = resolveMcpUrl({}, 8100, routeSource);

    expect(resolved).toEqual({ url: "http://172.17.0.1:8100/mcp", source: "fallback" });
  });

  it("parseDocker0GatewayFromProcRoute decodes the little-endian Destination column and adds one", () => {
    // The eth0 row is a line captured verbatim from a real DinD-adjacent
    // host: "01B018AC" decodes to 172.24.176.1 and matched `ip route show
    // default` there. 🔴 It is present to be IGNORED — it is the answer the
    // R235 defect returned. The docker0 row's "000011AC" is the
    // little-endian encoding of network 172.17.0.0, whose bridge address is
    // 172.17.0.1.
    const table =
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
      "eth0\t00000000\t01B018AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0";

    expect(parseDocker0GatewayFromProcRoute(table)).toBe("172.17.0.1");
  });

  it("parseDocker0GatewayFromProcRoute returns undefined when there is no docker0 row", () => {
    const table =
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
      "eth0\t00000000\t01B018AC\t0003\t0\t0\t0\t00000000\t0\t0\t0";

    expect(parseDocker0GatewayFromProcRoute(table)).toBeUndefined();
  });

  it("loadConfig wires resolveMcpUrl through with the routeSource parameter", () => {
    const routeSource = routeSourceReturning(
      fakeRouteTable({ defaultVia: "172.26.0.1", docker0Network: "172.30.0.0" }),
    );

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

// ── W8: the auth + Orange-credential variables ──────────────────────────
//
// R92: `ORANGE_BASE_URL` and `WOLF_API_KEY` are pinned HERE, in the typed
// config, and documented in `.env.example`. W12's bootstrap still reads them
// straight from `process.env` with its own default — that reader moves in a
// later ticket; this is the variables' home.

describe("loadConfig — W8's variables", () => {
  const noRoutes: RouteSource = { readRouteTable: () => undefined };

  it("defaults ORANGE_BASE_URL to agentd as seen from inside DinD's netns", () => {
    expect(loadConfig({}, noRoutes).orangeBaseUrl).toBe("http://localhost:8099");
  });

  it("reads ORANGE_BASE_URL when set, and treats an EMPTY value as unset (R80)", () => {
    expect(loadConfig({ ORANGE_BASE_URL: "http://orange:8099" }, noRoutes).orangeBaseUrl).toBe(
      "http://orange:8099",
    );
    // docker compose forwards an unset optional variable as "", not as absent.
    expect(loadConfig({ ORANGE_BASE_URL: "" }, noRoutes).orangeBaseUrl).toBe(
      "http://localhost:8099",
    );
  });

  it("fails fast naming ORANGE_BASE_URL when it is not an absolute http(s) URL", () => {
    for (const bad of ["orange:8099", "/agent", "ftp://orange"]) {
      try {
        loadConfig({ ORANGE_BASE_URL: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("ORANGE_BASE_URL");
      }
    }
  });

  it("reads WOLF_API_KEY, and leaves it empty when unset (createApp is what refuses to boot)", () => {
    expect(loadConfig({ WOLF_API_KEY: "wolf-key" }, noRoutes).orangeApiKey).toBe("wolf-key");
    expect(loadConfig({}, noRoutes).orangeApiKey).toBe("");
  });

  it("parses WOLF_ALLOWED_EMAILS: comma-separated, trimmed, lowercased", () => {
    const config = loadConfig(
      { WOLF_ALLOWED_EMAILS: " Kai@BadCode.dev ,jack@badcode.dev, " },
      noRoutes,
    );
    expect([...config.allowedEmails]).toEqual(["kai@badcode.dev", "jack@badcode.dev"]);
  });

  it("leaves the allowlist EMPTY when unset — and empty never means everyone", () => {
    // The fatal decision is `assertSessionConfigured`'s (see auth/session.ts):
    // `loadConfig` is also what scripts/bootstrap-project.ts runs through.
    expect(loadConfig({}, noRoutes).allowedEmails.size).toBe(0);
  });

  it("fails fast naming WOLF_ALLOWED_EMAILS on a token that is not a full address", () => {
    for (const bad of ["@badcode.dev", "*", "kai", "kai@badcode"]) {
      try {
        loadConfig({ WOLF_ALLOWED_EMAILS: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).message).toContain("WOLF_ALLOWED_EMAILS");
      }
    }
  });

  it("fails fast naming WOLF_SESSION_SECRET when it is shorter than 32 characters", () => {
    expect(loadConfig({ WOLF_SESSION_SECRET: "x".repeat(32) }, noRoutes).sessionSecret).toHaveLength(
      32,
    );
    try {
      loadConfig({ WOLF_SESSION_SECRET: "x".repeat(31) }, noRoutes);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("WOLF_SESSION_SECRET");
    }
  });

  it("parses WOLF_TEST_LOGIN into email:password, splitting on the FIRST colon", () => {
    const config = loadConfig(
      { WOLF_TEST_LOGIN: "Kai@BadCode.dev:pass:with:colons", NODE_ENV: "test" },
      noRoutes,
    );
    expect(config.testLogin).toEqual({ email: "kai@badcode.dev", password: "pass:with:colons" });
  });

  it("leaves testLogin null when WOLF_TEST_LOGIN is unset or empty", () => {
    expect(loadConfig({}, noRoutes).testLogin).toBeNull();
    expect(loadConfig({ WOLF_TEST_LOGIN: "" }, noRoutes).testLogin).toBeNull();
  });

  it("refuses WOLF_TEST_LOGIN alongside NODE_ENV=production (owner decision B6)", () => {
    try {
      loadConfig({ WOLF_TEST_LOGIN: "kai@badcode.dev:pw", NODE_ENV: "production" }, noRoutes);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("WOLF_TEST_LOGIN");
    }
  });
});

// design/2026-08-20-agent-wolf.md, W9's Files line: "modify … api/src/config.ts,
// … .env.example and docker-compose.yml (WOLF_TEARDOWN_DRAIN_SECONDS,
// WOLF_SCHEDULE_CRON — both files, R81/R110)". `config.test.ts` moves with
// `config.ts` on the ownership table (R94).
describe("WOLF_SCHEDULE_CRON / WOLF_TEARDOWN_DRAIN_SECONDS (W9)", () => {
  const noRoutes = routeSourceReturning(undefined);

  it("defaults to a once-daily 5-field cron and a 60-second drain bound", () => {
    const config = loadConfig({}, noRoutes);
    expect(config.scheduleCron).toBe("0 6 * * *");
    expect(config.scheduleCron.trim().split(/\s+/)).toHaveLength(5);
    expect(config.teardownDrainSeconds).toBe(60);
  });

  it("is overridable, so an e2e run can schedule * * * * * and see a tick", () => {
    const config = loadConfig(
      { WOLF_SCHEDULE_CRON: "* * * * *", WOLF_TEARDOWN_DRAIN_SECONDS: "5" },
      noRoutes,
    );
    expect(config.scheduleCron).toBe("* * * * *");
    expect(config.teardownDrainSeconds).toBe(5);
  });

  it("treats BOTH as absent when compose forwards them as the empty string (R80)", () => {
    // `${VAR:-}` arrives as "" — and `z.coerce.number()` turns "" into 0,
    // which here would silently mean "never wait for a delivery to drain"
    // while looking exactly like the default.
    const config = loadConfig(
      { WOLF_SCHEDULE_CRON: "", WOLF_TEARDOWN_DRAIN_SECONDS: "" },
      noRoutes,
    );
    expect(config.scheduleCron).toBe("0 6 * * *");
    expect(config.teardownDrainSeconds).toBe(60);
  });

  it("fails fast naming WOLF_SCHEDULE_CRON on a nickname — @daily is never emitted", () => {
    // agentdb.Schedule.Cron is validated on write and refuses nicknames
    // outright, and go-live would hit that AFTER the locked spec memory has
    // already been appended — which nothing can take back.
    for (const bad of ["@daily", "@hourly", "0 6 * *", "0 6 * * * *"]) {
      try {
        loadConfig({ WOLF_SCHEDULE_CRON: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_SCHEDULE_CRON");
      }
    }
  });

  it("fails fast naming WOLF_TEARDOWN_DRAIN_SECONDS when it is not a whole count of seconds", () => {
    for (const bad of ["-1", "1.5", "a minute", "60s"]) {
      try {
        loadConfig({ WOLF_TEARDOWN_DRAIN_SECONDS: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_TEARDOWN_DRAIN_SECONDS");
      }
    }
  });

  it("accepts a zero drain bound: proceed immediately, but still POLL once", () => {
    const config = loadConfig({ WOLF_TEARDOWN_DRAIN_SECONDS: "0" }, noRoutes);
    expect(config.teardownDrainSeconds).toBe(0);
  });
});

describe("WOLF_REPORT_MAX_BYTES / WOLF_SERIES_MAX_POINTS (W16)", () => {
  const noRoutes = routeSourceReturning(undefined);

  it("defaults to a 512000-byte template budget and 5000 points per metric", () => {
    const config = loadConfig({}, noRoutes);
    expect(config.reportMaxBytes).toBe(512_000);
    expect(config.seriesMaxPoints).toBe(5000);
  });

  it("is overridable — a small stack can cap a template harder than the default", () => {
    const config = loadConfig(
      { WOLF_REPORT_MAX_BYTES: "65536", WOLF_SERIES_MAX_POINTS: "250" },
      noRoutes,
    );
    expect(config.reportMaxBytes).toBe(65_536);
    expect(config.seriesMaxPoints).toBe(250);
  });

  it("treats BOTH as absent when compose forwards them as the empty string (R80)", () => {
    // Without present(), z.coerce.number() turns "" into 0 — a 0-byte
    // template limit rejects every template a human ever writes, and a
    // 0-point cap draws an empty chart. Both would look like the default.
    const config = loadConfig(
      { WOLF_REPORT_MAX_BYTES: "", WOLF_SERIES_MAX_POINTS: "" },
      noRoutes,
    );
    expect(config.reportMaxBytes).toBe(512_000);
    expect(config.seriesMaxPoints).toBe(5000);
  });

  it("fails fast naming WOLF_REPORT_MAX_BYTES when it is not a whole positive count", () => {
    for (const bad of ["0", "-1", "1.5", "512kb", "half a meg"]) {
      try {
        loadConfig({ WOLF_REPORT_MAX_BYTES: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_REPORT_MAX_BYTES");
      }
    }
  });

  it("fails fast naming WOLF_SERIES_MAX_POINTS when it is not a whole positive count", () => {
    for (const bad of ["0", "-10", "2.5", "5k"]) {
      try {
        loadConfig({ WOLF_SERIES_MAX_POINTS: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_SERIES_MAX_POINTS");
      }
    }
  });

  it("the default budget is what parseTemplate is HANDED, not what it reads", () => {
    // W16's first criterion: parseTemplate(html, maxBytes) takes the limit as
    // a parameter and reads no config. This test is the config half of that
    // contract — the parser half lives in src/report/template.test.ts.
    const html = `<div data-wolf-fallback>no chart</div><p>${"x".repeat(200)}</p>`;
    const { reportMaxBytes } = loadConfig({}, noRoutes);
    expect(parseTemplate(html, reportMaxBytes).valid).toBe(true);
    expect(parseTemplate(html, 10).valid).toBe(false);
  });
});

// design/2026-08-20-agent-wolf.md, W10's Files line: "modify … api/src/config.ts,
// api/src/config.test.ts, .env.example AND docker-compose.yml
// (WOLF_POLL_INTERVAL_SECONDS — all three places, R81/R110/R111)". The third
// place is enforced by the block at the bottom of this file; these cases
// gate the VALUE.
describe("WOLF_POLL_INTERVAL_SECONDS (W10)", () => {
  const noRoutes = routeSourceReturning(undefined);

  it("defaults to 300 seconds", () => {
    expect(loadConfig({}, noRoutes).pollIntervalSeconds).toBe(
      DEFAULT_WOLF_POLL_INTERVAL_SECONDS,
    );
    expect(DEFAULT_WOLF_POLL_INTERVAL_SECONDS).toBe(300);
  });

  it("is overridable, so an e2e run can poll every second", () => {
    expect(loadConfig({ WOLF_POLL_INTERVAL_SECONDS: "1" }, noRoutes).pollIntervalSeconds).toBe(1);
  });

  it("treats the empty string as ABSENT and falls back to the default (R80)", () => {
    // Compose forwards `${WOLF_POLL_INTERVAL_SECONDS:-}` as "", and
    // `z.coerce.number()` turns "" into 0 — a 0 ms interval that spins the
    // event loop while looking exactly like the default. `present()` is what
    // stops that, and this is the test that says so.
    expect(loadConfig({ WOLF_POLL_INTERVAL_SECONDS: "" }, noRoutes).pollIntervalSeconds).toBe(300);
    expect(Number("")).toBe(0); // the coercion this guards against
  });

  it("fails fast naming the variable on a value that is not a whole count of seconds in range", () => {
    for (const bad of ["0", "-1", "1.5", "5m", "300s", "86401", "abc"]) {
      try {
        loadConfig({ WOLF_POLL_INTERVAL_SECONDS: bad }, noRoutes);
        throw new Error(`expected loadConfig to throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("WOLF_POLL_INTERVAL_SECONDS");
      }
    }
  });

  it("is documented in .env.example with its _SECONDS unit spelled out", () => {
    const example = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.example"),
      "utf8",
    );
    expect(example).toContain("WOLF_POLL_INTERVAL_SECONDS=300");
    expect(example).toContain("SECONDS");
  });
});

// design/2026-08-20-agent-wolf.md, W11: `ORANGE_PUBLIC_URL` is the
// BROWSER-reachable Orange origin and the base of every `embed_url`. It is a
// SECOND variable on purpose — ORANGE_BASE_URL is agentd inside DinD's netns,
// which no browser can reach — so the cases below gate that the two never
// collapse into one. The "reaches the container" half is enforced by the
// R81/R110 block below.
describe("ORANGE_PUBLIC_URL (W11)", () => {
  const noRoutes = routeSourceReturning(undefined);

  it("defaults to the agent-orange stack's published web origin, NOT agentd", () => {
    const config = loadConfig({}, noRoutes);
    expect(config.orangePublicUrl).toBe(DEFAULT_ORANGE_PUBLIC_URL);
    expect(config.orangePublicUrl).toBe("http://localhost:8080");
    // 8099 is agentd in DinD's netns; a browser cannot reach it.
    expect(config.orangePublicUrl).not.toBe(config.orangeBaseUrl);
  });

  it("reads ORANGE_PUBLIC_URL when set, independently of ORANGE_BASE_URL", () => {
    const config = loadConfig(
      { ORANGE_PUBLIC_URL: "https://orange.badcode.dev", ORANGE_BASE_URL: "http://localhost:9000" },
      noRoutes,
    );
    expect(config.orangePublicUrl).toBe("https://orange.badcode.dev");
    expect(config.orangeBaseUrl).toBe("http://localhost:9000");
  });

  it("treats an EMPTY value as absent (R80) rather than as a bare-path origin", () => {
    // Compose forwards an unset optional variable as "", and `"" ?? default`
    // is `""` — which would build embed_url as a same-origin path that
    // resolves against WOLF's own origin and 404s inside the iframe.
    expect(loadConfig({ ORANGE_PUBLIC_URL: "" }, noRoutes).orangePublicUrl).toBe(
      DEFAULT_ORANGE_PUBLIC_URL,
    );
  });

  it("trims trailing slashes, so an embed_url never doubles one", () => {
    expect(
      loadConfig({ ORANGE_PUBLIC_URL: "http://localhost:8080///" }, noRoutes).orangePublicUrl,
    ).toBe("http://localhost:8080");
  });

  it("fails fast naming ORANGE_PUBLIC_URL when it is not an absolute http(s) URL", () => {
    for (const bad of ["localhost:8080", "/embed", "ftp://orange.test"]) {
      try {
        loadConfig({ ORANGE_PUBLIC_URL: bad }, noRoutes);
        expect.unreachable(`ORANGE_PUBLIC_URL=${bad} should have been refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(WolfError);
        expect((err as WolfError).kind).toBe("misconfigured");
        expect((err as WolfError).message).toContain("ORANGE_PUBLIC_URL");
      }
    }
  });

  it("is documented in .env.example, with the frame-ancestors trap spelled out", () => {
    const example = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.example"),
      "utf8",
    );
    expect(example).toContain("ORANGE_PUBLIC_URL=http://localhost:8080");
    // O8's allowed_origins is the other half: an origin missing there means
    // the browser blocks the chat iframe with no error on the Wolf side.
    expect(example).toContain("allowed_origins");
    expect(example).toContain("frame-ancestors");
  });
});

// ─── R81/R110: the three places, enforced mechanically ─────────────────────
//
// A variable read by this module still never reaches the running process
// without an `environment:` entry under `wolf-api` in docker-compose.yml —
// Compose injects nothing from `.env` on its own. Every wave since W1 has
// been told that rule in prose and it has been broken anyway: W12 shipped
// WOLF_BASE_IMAGE and WOLF_CRITIC_CRON with no compose entry (found by W9's
// implementer in wave 6, two waves later, by reading the file), and both W9
// and W16 were written with Files lines that stopped at `.env.example`.
//
// Prose does not enforce it. This does. It is deliberately a source scan
// rather than a config assertion, because the failure it catches is the
// absence of a line, which no amount of exercising `loadConfig` can see.
describe("R81/R110: every variable config.ts reads reaches the container", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  /**
   * Variables that appear in docker-compose.yml but are deliberately NOT read
   * by config.ts — they configure Compose itself, not the wolf-api process.
   * This module's own header comment names them.
   */
  const COMPOSE_ONLY = new Set(["ORANGE_DIND_CONTAINER", "WOLF_WEB_PORT"]);

  /** `env.FOO` inside a doc comment illustrating the R80 hazard, not a real read. */
  const NOT_A_REAL_READ = new Set(["FOO"]);

  function variablesConfigReads(): string[] {
    const src = readFileSync(join(repoRoot, "api", "src", "config.ts"), "utf8");
    const names = new Set<string>();
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
      const name = m[1];
      if (name && !NOT_A_REAL_READ.has(name)) names.add(name);
    }
    return [...names].sort();
  }

  function wolfApiEnvironmentKeys(): Set<string> {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l.startsWith("  wolf-api:"));
    expect(start, "no `wolf-api:` service in docker-compose.yml").toBeGreaterThanOrEqual(0);
    // The service block ends at the next line indented by exactly two spaces.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^ {2}\S/.test(line)) {
        end = i;
        break;
      }
    }
    const keys = new Set<string>();
    for (const line of lines.slice(start, end)) {
      const m = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
      if (m?.[1]) keys.add(m[1]);
    }
    return keys;
  }

  it("finds a non-trivial number of variables, so a broken scan cannot pass vacuously", () => {
    const read = variablesConfigReads();
    expect(read.length).toBeGreaterThan(10);
    expect(read).toContain("WOLF_API_KEY");
    expect(wolfApiEnvironmentKeys().size).toBeGreaterThan(10);
  });

  it("every variable config.ts reads has an `environment:` entry under wolf-api", () => {
    const composeKeys = wolfApiEnvironmentKeys();
    const missing = variablesConfigReads().filter((name) => !composeKeys.has(name));
    expect(
      missing,
      `read by api/src/config.ts but absent from docker-compose.yml's wolf-api environment block, ` +
        `so the value an operator sets in .env would silently never reach the container (R81/R110): ` +
        `${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every variable config.ts reads is documented in .env.example", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
    );
    const missing = variablesConfigReads().filter((name) => !documented.has(name));
    expect(
      missing,
      `read by api/src/config.ts but undocumented in .env.example: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no compose entry names a variable nothing reads, beyond the documented Compose-only ones", () => {
    const read = new Set(variablesConfigReads());
    // LOG_LEVEL and NODE_ENV are read through the same module; anything else
    // unaccounted for is either a typo or a variable whose reader was deleted.
    const stray = [...wolfApiEnvironmentKeys()].filter(
      (name) => !read.has(name) && !COMPOSE_ONLY.has(name),
    );
    expect(stray, `named in docker-compose.yml but read by nothing: ${stray.join(", ")}`).toEqual([]);
  });
});
