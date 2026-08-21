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
