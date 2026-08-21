import { readFileSync } from "node:fs";
import { z } from "zod";
import { WolfError } from "./errors.js";

/**
 * Env parsing for wolf-api. Fails fast at boot, naming the offending
 * variable via `WolfError.misconfigured`, rather than letting a bad value
 * surface later as a confusing runtime error.
 *
 * Only the variables the scaffold itself needs are read here. Later tickets
 * (Orange client, market-data providers, embed tokens, …) extend this
 * schema — see design/2026-08-20-agent-wolf.md § "Pinned technology
 * choices" and the per-ticket Files lists for what each one adds.
 *
 * `.env.example` also documents topology-only variables
 * (`ORANGE_DIND_CONTAINER`, `WOLF_WEB_PORT`) that this file does NOT read —
 * they configure docker-compose / nginx, not this process. `WOLF_MCP_URL`
 * IS read here (see § "DinD gateway discovery" below), even though
 * `.env.example` also documents it as a Docker-facing variable: it is both.
 */

const portSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535);

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export interface WolfConfig {
  /** Port wolf-api listens on. */
  port: number;
  /** pino log level. */
  logLevel: z.infer<typeof logLevelSchema>;
  /** `development` | `production` | `test`. */
  nodeEnv: string;
  /** The resolved MCP URL a session container should reach wolf-api's /mcp at. */
  mcpUrl: string;
  /** Where `mcpUrl` came from — for the one-line boot log entry. */
  mcpUrlSource: McpUrlSource;
}

// ── DinD gateway discovery (R43) ────────────────────────────────────────
//
// design/2026-08-20-agent-wolf.md § "Local topology and networking":
// "172.17.0.1 is a default, not a constant — discover it." Docker only
// allocates the 172.17.0.0/16 subnet for DinD's inner docker0 bridge when
// that subnet is free; W1's verifier reproduced it becoming 172.18.0.1.
// Session containers reach wolf-api at this address, so a silent shift
// makes every MCP tool call from inside a session time out with no obvious
// cause.
//
// Resolution order, exactly as the plan specifies:
//   1. `WOLF_MCP_URL` set explicitly in the environment — wins outright, no
//      discovery attempted. A real (non-compose) deployment sets this and
//      never runs the probe below.
//   2. Read the default route from DinD's own network namespace (wolf-api
//      shares it via `network_mode: "container:${ORANGE_DIND_CONTAINER}"`),
//      via /proc/net/route's destination-00000000 entry, and build
//      `http://<gateway>:<port>/mcp`.
//   3. Fall back to the literal 172.17.0.1.
// Whichever of 2/3 is used is logged at info, once, by the caller (index.ts,
// once a logger exists — config.ts itself only returns the source tag).

export type McpUrlSource = "explicit" | "discovered" | "fallback";

export const DEFAULT_GATEWAY_FALLBACK = "172.17.0.1";

/**
 * Where the default-route table is read from. Injectable so tests can
 * supply a fake table without touching the real filesystem — this is what
 * "unit-tested with a fake route source" (the W1 criterion) means.
 */
export interface RouteSource {
  /** Raw contents of a /proc/net/route-formatted table, or undefined if unavailable (e.g. not on Linux, or the file could not be read). */
  readRouteTable(): string | undefined;
}

export const procNetRouteSource: RouteSource = {
  readRouteTable(): string | undefined {
    try {
      return readFileSync("/proc/net/route", "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * Parses /proc/net/route's tab-separated table and returns the gateway of
 * the default route (the row whose Destination is `00000000`) as a dotted
 * decimal IPv4 address, or undefined if there is no such row or it is
 * malformed. A default-route row with Gateway `00000000` (a directly
 * connected route, no gateway) does not count.
 *
 * The Gateway column is 8 hex chars encoding the address in **little-endian
 * byte order** — e.g. gateway 172.24.176.1 (bytes AC 18 B0 01) appears as
 * "01B018AC". Decoding: split into four hex byte-pairs, reverse their
 * order, parse each as decimal.
 */
export function parseDefaultGatewayFromProcRoute(contents: string): string | undefined {
  const lines = contents.split("\n");
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    // Columns: Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
    const [, destination, gateway] = fields;
    if (destination !== "00000000") continue;
    if (!gateway || gateway === "00000000" || gateway.length !== 8) continue;
    if (!/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;

    const bytes = [
      gateway.slice(0, 2),
      gateway.slice(2, 4),
      gateway.slice(4, 6),
      gateway.slice(6, 8),
    ].map((hex) => parseInt(hex, 16));
    return bytes.slice().reverse().join(".");
  }
  return undefined;
}

export interface ResolvedMcpUrl {
  url: string;
  source: McpUrlSource;
}

/**
 * Resolves `mcpUrl` per the three-path rule above. `port` is wolf-api's own
 * already-resolved listen port, used to build the URL when discovery or the
 * fallback wins (an explicit `WOLF_MCP_URL` carries its own port and is
 * used verbatim).
 */
export function resolveMcpUrl(
  env: NodeJS.ProcessEnv,
  port: number,
  routeSource: RouteSource = procNetRouteSource,
): ResolvedMcpUrl {
  const explicit = env.WOLF_MCP_URL;
  if (explicit) {
    return { url: explicit, source: "explicit" };
  }

  const table = routeSource.readRouteTable();
  const gateway = table ? parseDefaultGatewayFromProcRoute(table) : undefined;
  if (gateway) {
    return { url: `http://${gateway}:${port}/mcp`, source: "discovered" };
  }

  return { url: `http://${DEFAULT_GATEWAY_FALLBACK}:${port}/mcp`, source: "fallback" };
}

// ── end DinD gateway discovery ──────────────────────────────────────────

/**
 * Reads and validates process.env. Throws a `WolfError` of kind
 * `misconfigured`, naming the offending variable, on any invalid value.
 * Pass an explicit `env` (e.g. in a test) to avoid depending on the real
 * process environment. `routeSource` is injectable for the same reason —
 * see `resolveMcpUrl`.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  routeSource: RouteSource = procNetRouteSource,
): WolfConfig {
  const portResult = portSchema.safeParse(env.WOLF_API_PORT ?? 8100);
  if (!portResult.success) {
    throw WolfError.misconfigured(
      "WOLF_API_PORT",
      `WOLF_API_PORT must be an integer between 1 and 65535, got ${JSON.stringify(env.WOLF_API_PORT)}`,
    );
  }

  const logLevelResult = logLevelSchema.safeParse(env.LOG_LEVEL ?? "info");
  if (!logLevelResult.success) {
    throw WolfError.misconfigured(
      "LOG_LEVEL",
      `LOG_LEVEL must be one of ${logLevelSchema.options.join(", ")}, got ${JSON.stringify(env.LOG_LEVEL)}`,
    );
  }

  const { url: mcpUrl, source: mcpUrlSource } = resolveMcpUrl(env, portResult.data, routeSource);

  return {
    port: portResult.data,
    logLevel: logLevelResult.data,
    nodeEnv: env.NODE_ENV ?? "development",
    mcpUrl,
    mcpUrlSource,
  };
}
