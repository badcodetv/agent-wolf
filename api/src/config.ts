import { randomBytes } from "node:crypto";
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

/** A whole, non-negative count of SECONDS. Every duration variable in this
 * codebase ends in `_SECONDS` and holds a plain integer — see the house
 * rule in design/2026-08-20-agent-wolf.md § "Parallelism and file
 * ownership": "5m" in a variable whose unit is unstated is exactly the
 * ambiguity § Vocabulary exists to prevent. */
const secondsSchema = z.coerce.number().int().min(0);

/** A whole COUNT (of bytes, of points, …), at least one. Zero is never a
 * meaningful budget: a 0-byte template limit rejects every template and a
 * 0-point series limit draws an empty chart, and both look exactly like the
 * default when compose forwards an unset variable as "" (R80). */
const countSchema = z.coerce.number().int().min(1);

/**
 * `WOLF_MCP_TOKEN`'s pinned shape (**W7 owner pick — R49 records that its
 * length and charset were pinned nowhere**): at least 32 and at most 128
 * characters from the URL-safe base64 alphabet.
 *
 *  - **≥32 chars** because this single bearer value is the only thing
 *    standing between any process that can reach wolf-api and its
 *    market-data tools; a constant-time compare does not save a short one.
 *  - **`[A-Za-z0-9_-]` only** because the value travels as an HTTP header
 *    (`X-Wolf-Mcp-Token`) and through Orange's MCP header interpolation
 *    (`${WOLF_MCP_TOKEN}`) and a shell `export` in X1's `run.sh` — spaces,
 *    quotes and `$` are how that chain breaks silently.
 *
 * Generate one with:
 *   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
 */
const MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * `WOLF_CRITIC_CRON`'s pinned shape (W12): a plain 5-field cron expression,
 * never a nickname. Orange's schedule store refuses `@weekly` and friends
 * outright (`go/agentdb/schedules.go:827`), so validating the shape here —
 * before it ever reaches `POST /agent/schedules` — turns a bad value into a
 * boot-time `misconfigured` error naming this variable, rather than a
 * bootstrap script failing opaquely partway through provisioning the `wolf`
 * project. This is a shape check, not a full cron grammar: it does not
 * validate that each field's *value* is in range, only that there are
 * exactly five whitespace-separated fields and none of them is a `@…`
 * nickname.
 */
const CRON_NICKNAME_PATTERN = /^@/;

function isFiveFieldCron(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || CRON_NICKNAME_PATTERN.test(trimmed)) return false;
  return trimmed.split(/\s+/).length === 5;
}

/**
 * Treats an EMPTY environment variable as absent.
 *
 * This is not pedantry: `docker-compose.yml` forwards optional variables as
 * `FOO: ${FOO:-}`, which sets them to the empty string when the operator
 * left them out of `.env`. Empty string is not nullish, so a plain
 * `env.FOO ?? default` would hand `""` to `z.coerce.number()`, which
 * coerces it to **0** — silently turning "unset, use the default" into a
 * 0-second cache TTL or an out-of-range URL TTL.
 */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

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
  /** `WOLF_MCP_TOKEN`: the credential a session container presents to
   * `/mcp` in the bare `X-Wolf-Mcp-Token` header. Empty when unset — the
   * MCP server factory (`createWolfMcp`) refuses to build without it, so
   * wolf-api fails at boot rather than serving market data unauthenticated.
   * **Never log this value.** */
  mcpToken: string;
  /** `FRED_API_KEY`, passed straight through to `createFredClient`, which
   * raises `WolfError.misconfigured("FRED_API_KEY")` at construction when
   * it is empty (W6). Empty is allowed here: the FRED connector is built
   * lazily, so a keyless stack still boots and still serves Stooq.
   * **Never log this value.** */
  fredApiKey: string;
  /** `WOLF_MARKETDATA_CACHE_TTL_SECONDS` (default 3600). Whole seconds;
   * `createCache` takes milliseconds, so the ×1000 happens exactly once,
   * where the cache is constructed (W6's Notes). */
  marketDataCacheTtlSeconds: number;
  /** `WOLF_SERIES_TOKEN_SECRET`: the HMAC key for `/series/download`
   * tokens. **Never log this value.** */
  seriesTokenSecret: string;
  /** Where `seriesTokenSecret` came from — for the one-line boot log entry. */
  seriesTokenSecretSource: SeriesTokenSecretSource;
  /** `WOLF_SERIES_URL_TTL_SECONDS` (default 300): how long a minted
   * download URL stays valid. Kept short — the URL carries its token
   * through the model's context and the persisted transcript. */
  seriesUrlTtlSeconds: number;
  /** `WOLF_BASE_IMAGE` (default `agent-wolf:dev`): the image every session
   * in the `wolf` Orange project launches from, written into the project's
   * `base_image` setting by the bootstrap script (W12). Not read anywhere
   * else in this process — this is config for the bootstrap, not for
   * serving requests. */
  wolfBaseImage: string;
  /** `WOLF_CRITIC_CRON` (default `0 4 * * 1`, i.e. Mondays at 04:00): the
   * cron the bootstrap script (W12) registers for the project-level
   * `critic` worker's weekly schedule. Must be a plain 5-field expression —
   * see `isFiveFieldCron`'s doc comment for why. */
  criticCron: string;
  /** `WOLF_SCHEDULE_CRON` (default `0 6 * * *`, i.e. every day at 06:00):
   * the cron W9 registers for each hypothesis's per-hypothesis daily
   * `researcher-<id>` schedule at go-live. A plain 5-field expression,
   * never a nickname — `agentdb.Schedule.Cron` is validated on write and
   * refuses `@daily` outright (`go/agentdb/schedules.go:827`), so a bad
   * value is caught here, at boot, naming this variable, rather than as a
   * 4xx in the middle of provisioning. Overridable precisely so X1 can run
   * `* * * * *` and see a tick inside a test run. */
  scheduleCron: string;
  /** `WOLF_TEARDOWN_DRAIN_SECONDS` (default 60): how long W9's ordered
   * teardown waits for this hypothesis's already-queued deliveries to
   * drain after its schedule is deleted, before proceeding anyway and
   * logging the delivery ids it left behind. A whole count of SECONDS. */
  teardownDrainSeconds: number;
  /** `ORANGE_BASE_URL` (default `http://localhost:8099`): where Orange's
   * agentd answers. In the compose stack wolf-api shares DinD's network
   * namespace, so agentd is on `localhost:8099` — which is why that is the
   * default rather than a compose service name. Pinned here (R92) because
   * W12's bootstrap had to read it straight from `process.env` with its own
   * hardcoded default: no ticket in its dependency set owned `config.ts`.
   * A later ticket moves that reader onto this field; W12's bootstrap is
   * deliberately NOT edited here. */
  orangeBaseUrl: string;
  /** `WOLF_API_KEY`: the `wolf` project's Orange API key, sent as
   * `X-API-Key` on every call wolf-api makes to Orange. Empty when unset —
   * `createApp` refuses to build without it, so an unset key is a loud boot
   * failure naming the variable rather than a 403 on the first request.
   * It is a DIFFERENT credential from `WOLF_MCP_TOKEN` (which authenticates
   * a session container TO wolf-api). **Never log this value.** */
  orangeApiKey: string;
  /** `WOLF_ALLOWED_EMAILS`, parsed: lowercased, whitespace-trimmed full
   * addresses. EMPTY WHEN UNSET, and `createApp` refuses to build on an
   * empty set — an empty allowlist must never silently mean "everyone".
   * Orange verifying a Google credential is necessary, never sufficient. */
  allowedEmails: ReadonlySet<string>;
  /** `WOLF_SESSION_SECRET`: the key `cookie-parser` signs the `wolf_session`
   * cookie with. Empty when unset; `createApp` refuses to build without it.
   * At least 32 characters when set. **Never log this value.** */
  sessionSecret: string;
  /** `WOLF_REPORT_MAX_BYTES` (default 512000): the byte budget for one
   * report template, handed to `parseTemplate(html, maxBytes)` as a
   * PARAMETER — that function reads no config itself, so this is the one
   * place the number lives. A template is a memory row that a human reviews
   * at go-live and that every frame render re-reads; the cap is what stops
   * an interview from locking half a megabyte of minified chart library into
   * the scoreboard. Whole BYTES, not characters: `parseTemplate` measures
   * `Buffer.byteLength(html, "utf8")`. */
  reportMaxBytes: number;
  /** `WOLF_SERIES_MAX_POINTS` (default 5000): the per-metric cap on points
   * injected into the report frame (W18's `buildSeriesPayload` downsamples
   * to it, always keeping the first and last point). It bounds the size of
   * the `window.__WOLF_SERIES__` blob the frame carries, which is inlined
   * into the document on every render. A whole COUNT of points. */
  seriesMaxPoints: number;
  /** `WOLF_TEST_LOGIN`, parsed from `email:password` — the test-only login
   * (owner decision B6). `null` unless the variable is set, and setting it
   * alongside `NODE_ENV=production` is a boot-time failure: the route it
   * mounts skips Google entirely. **Never log the password.** */
  testLogin: TestLogin | null;
}

/** The one test-only credential pair, parsed from `WOLF_TEST_LOGIN`. */
export interface TestLogin {
  email: string;
  password: string;
}

/**
 * Where the download-token signing secret came from.
 *
 * `generated` means `WOLF_SERIES_TOKEN_SECRET` was unset and a fresh random
 * 32-byte secret was minted for this process. That is deliberate, and it is
 * NOT a weak default: there is no committed fallback value to leak, and the
 * only consequence is that download URLs minted before a restart stop
 * verifying after it — bounded anyway by a 300s TTL. Set the variable when
 * more than one wolf-api process must honour each other's URLs.
 */
export type SeriesTokenSecretSource = "env" | "generated";

/** Default lifetime of a `/series/download` URL, in seconds (W7). */
export const DEFAULT_SERIES_URL_TTL_SECONDS = 300;

/** Default market-data cache TTL, in seconds (W6: "default 3600s"). */
export const DEFAULT_MARKETDATA_CACHE_TTL_SECONDS = 3600;

/** Default `base_image` the bootstrap script sets on the `wolf` project (W12). */
export const DEFAULT_WOLF_BASE_IMAGE = "agent-wolf:dev";

/** Default cron for the project-level `critic` schedule (W12): Mondays at 04:00. */
export const DEFAULT_WOLF_CRITIC_CRON = "0 4 * * 1";

/** Default cron for a hypothesis's daily `researcher-<id>` schedule (W9): 06:00 every day. */
export const DEFAULT_WOLF_SCHEDULE_CRON = "0 6 * * *";

/** Default drain bound for W9's ordered teardown, in whole seconds. */
export const DEFAULT_WOLF_TEARDOWN_DRAIN_SECONDS = 60;

/** Default byte budget for one report template (W16): 512000 bytes. */
export const DEFAULT_WOLF_REPORT_MAX_BYTES = 512_000;

/** Default per-metric point cap for the report frame's series payload (W16/W18): 5000. */
export const DEFAULT_WOLF_SERIES_MAX_POINTS = 5000;

/** Default `ORANGE_BASE_URL` (R92): agentd, seen from inside DinD's netns. */
export const DEFAULT_ORANGE_BASE_URL = "http://localhost:8099";

/** Minimum length of `WOLF_SESSION_SECRET`. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * A plausible full email address. Deliberately strict about the two things
 * that would silently WIDEN the allowlist: a bare domain (`@badcode.dev`)
 * and a wildcard (`*`) are rejected rather than accepted-and-ignored, so
 * `WOLF_ALLOWED_EMAILS=@badcode.dev` fails at boot instead of allowlisting
 * nobody (or, worse, being read by some later reader as a domain rule).
 */
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Parses `WOLF_ALLOWED_EMAILS`: comma-separated, case-insensitive,
 * whitespace-trimmed full Google addresses.
 *
 * Returns an EMPTY set when the variable is unset or empty — this function
 * does not decide whether that is fatal (`createApp` does, at boot), because
 * `loadConfig` is also what `scripts/bootstrap-project.ts` runs through and
 * that tool signs nobody in. What it does refuse is a value that is present
 * but malformed: a token that is not an address at all is a typo, and
 * silently dropping it removes a person from the allowlist with no error
 * anywhere.
 */
export function parseAllowedEmails(raw: string | undefined): ReadonlySet<string> {
  const value = present(raw);
  if (value === undefined) return new Set<string>();
  const out = new Set<string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (!EMAIL_PATTERN.test(trimmed)) {
      throw WolfError.misconfigured(
        "WOLF_ALLOWED_EMAILS",
        "WOLF_ALLOWED_EMAILS must be a comma-separated list of full email addresses; " +
          `${JSON.stringify(trimmed)} is not one (a bare domain or a wildcard is not accepted)`,
      );
    }
    out.add(trimmed.toLowerCase());
  }
  return out;
}

/**
 * Parses `WOLF_TEST_LOGIN` (`email:password`) into its two halves, or null
 * when the variable is unset. Split on the FIRST colon: an email address
 * cannot contain one, a password very well may.
 */
export function parseTestLogin(raw: string | undefined, nodeEnv: string): TestLogin | null {
  const value = present(raw);
  if (value === undefined) return null;
  // Owner decision B6: the dev-login route "refus[es] to boot alongside
  // production settings". It verifies no Google credential at all, so a
  // production process that has it mounted is a sign-in bypass for anyone
  // who can reach the port.
  if (nodeEnv === "production") {
    throw WolfError.misconfigured(
      "WOLF_TEST_LOGIN",
      "WOLF_TEST_LOGIN mounts a test-only login that verifies no Google credential; " +
        "it must not be set when NODE_ENV=production (unset one of the two)",
    );
  }
  const colon = value.indexOf(":");
  const email = colon < 0 ? "" : value.slice(0, colon).trim();
  const password = colon < 0 ? "" : value.slice(colon + 1);
  if (email === "" || password === "") {
    throw WolfError.misconfigured(
      "WOLF_TEST_LOGIN",
      'WOLF_TEST_LOGIN must be "email:password" with both halves non-empty',
    );
  }
  return { email: email.toLowerCase(), password };
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

  // WOLF_MCP_TOKEN. Empty is allowed HERE (so `loadConfig` stays usable in
  // tests and tools that never mount /mcp) but not by `createWolfMcp`,
  // which every boot goes through — so an unset token is a loud boot
  // failure, never a silently unauthenticated MCP server. A value that IS
  // set must be well formed; a token that Docker, a shell or Orange's
  // `${VAR}` interpolation would mangle is worse than no token, because it
  // fails at first tool call inside a container.
  const mcpToken = env.WOLF_MCP_TOKEN ?? "";
  if (mcpToken !== "" && !MCP_TOKEN_PATTERN.test(mcpToken)) {
    throw WolfError.misconfigured(
      "WOLF_MCP_TOKEN",
      "WOLF_MCP_TOKEN must be 32-128 characters of [A-Za-z0-9_-] " +
        "(generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')",
    );
  }

  const cacheTtlResult = secondsSchema.safeParse(
    present(env.WOLF_MARKETDATA_CACHE_TTL_SECONDS) ?? DEFAULT_MARKETDATA_CACHE_TTL_SECONDS,
  );
  if (!cacheTtlResult.success) {
    throw WolfError.misconfigured(
      "WOLF_MARKETDATA_CACHE_TTL_SECONDS",
      "WOLF_MARKETDATA_CACHE_TTL_SECONDS must be a whole number of seconds (>= 0), got " +
        JSON.stringify(env.WOLF_MARKETDATA_CACHE_TTL_SECONDS),
    );
  }

  const seriesTtlResult = secondsSchema
    .refine((value) => value >= 1 && value <= 3600)
    .safeParse(present(env.WOLF_SERIES_URL_TTL_SECONDS) ?? DEFAULT_SERIES_URL_TTL_SECONDS);
  if (!seriesTtlResult.success) {
    throw WolfError.misconfigured(
      "WOLF_SERIES_URL_TTL_SECONDS",
      "WOLF_SERIES_URL_TTL_SECONDS must be a whole number of seconds between 1 and 3600, got " +
        JSON.stringify(env.WOLF_SERIES_URL_TTL_SECONDS),
    );
  }

  const seriesSecretFromEnv = env.WOLF_SERIES_TOKEN_SECRET ?? "";
  if (seriesSecretFromEnv !== "" && seriesSecretFromEnv.length < 32) {
    throw WolfError.misconfigured(
      "WOLF_SERIES_TOKEN_SECRET",
      "WOLF_SERIES_TOKEN_SECRET must be at least 32 characters, or unset to generate one per boot",
    );
  }

  const wolfBaseImage = present(env.WOLF_BASE_IMAGE) ?? DEFAULT_WOLF_BASE_IMAGE;

  const criticCron = present(env.WOLF_CRITIC_CRON) ?? DEFAULT_WOLF_CRITIC_CRON;
  if (!isFiveFieldCron(criticCron)) {
    throw WolfError.misconfigured(
      "WOLF_CRITIC_CRON",
      "WOLF_CRITIC_CRON must be a plain 5-field cron expression (never a nickname like " +
        `@weekly — Orange's schedule store rejects those), got ${JSON.stringify(env.WOLF_CRITIC_CRON)}`,
    );
  }

  // W9's per-hypothesis daily schedule. Same 5-field rule as WOLF_CRITIC_CRON
  // above, and for the same reason: Orange validates `cron` on write and
  // refuses nicknames, so `@daily` would fail inside go-live's step 3 —
  // after the locked spec has already been appended, which is a rollback
  // this ticket then has to perform for a value that could have been
  // rejected at boot.
  const scheduleCron = present(env.WOLF_SCHEDULE_CRON) ?? DEFAULT_WOLF_SCHEDULE_CRON;
  if (!isFiveFieldCron(scheduleCron)) {
    throw WolfError.misconfigured(
      "WOLF_SCHEDULE_CRON",
      "WOLF_SCHEDULE_CRON must be a plain 5-field cron expression (never a nickname like " +
        `@daily — Orange's schedule store rejects those), got ${JSON.stringify(env.WOLF_SCHEDULE_CRON)}`,
    );
  }

  // `present()` (R80) rather than `??` on the raw value: compose forwards an
  // unset optional variable as the EMPTY STRING, and `z.coerce.number()`
  // turns "" into 0 — which here would mean "never wait for a delivery to
  // drain" while looking exactly like the default.
  const drainResult = secondsSchema.safeParse(
    present(env.WOLF_TEARDOWN_DRAIN_SECONDS) ?? DEFAULT_WOLF_TEARDOWN_DRAIN_SECONDS,
  );
  if (!drainResult.success) {
    throw WolfError.misconfigured(
      "WOLF_TEARDOWN_DRAIN_SECONDS",
      "WOLF_TEARDOWN_DRAIN_SECONDS must be a whole number of seconds (>= 0), got " +
        JSON.stringify(env.WOLF_TEARDOWN_DRAIN_SECONDS),
    );
  }

  const orangeBaseUrl = present(env.ORANGE_BASE_URL)?.trim() ?? DEFAULT_ORANGE_BASE_URL;
  if (!/^https?:\/\/[^\s]+$/.test(orangeBaseUrl)) {
    throw WolfError.misconfigured(
      "ORANGE_BASE_URL",
      "ORANGE_BASE_URL must be an absolute http(s) URL (e.g. http://localhost:8099), got " +
        JSON.stringify(env.ORANGE_BASE_URL),
    );
  }

  // Shape-checked here; PRESENCE is enforced by `createApp` (see WOLF_MCP_TOKEN
  // above for the same split, and W7's precedent for why): `loadConfig` is also
  // what `scripts/bootstrap-project.ts` runs through, and that tool signs
  // nobody in — requiring a session secret to provision a project would make
  // the bootstrap unrunnable for a variable it never reads.
  const sessionSecret = env.WOLF_SESSION_SECRET ?? "";
  if (sessionSecret !== "" && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw WolfError.misconfigured(
      "WOLF_SESSION_SECRET",
      `WOLF_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        "(generate one with: openssl rand -base64 32)",
    );
  }

  // W16's two report-layer budgets. Both go through `present()` (R80) for
  // the reason that helper exists: compose forwards an unset optional
  // variable as the EMPTY STRING, and `z.coerce.number()` turns "" into 0 —
  // which here would be a 0-byte template limit that rejects every template
  // and a 0-point series cap that draws an empty chart, both while looking
  // exactly like the default.
  const reportMaxBytesResult = countSchema.safeParse(
    present(env.WOLF_REPORT_MAX_BYTES) ?? DEFAULT_WOLF_REPORT_MAX_BYTES,
  );
  if (!reportMaxBytesResult.success) {
    throw WolfError.misconfigured(
      "WOLF_REPORT_MAX_BYTES",
      "WOLF_REPORT_MAX_BYTES must be a whole number of BYTES (>= 1), got " +
        JSON.stringify(env.WOLF_REPORT_MAX_BYTES),
    );
  }

  const seriesMaxPointsResult = countSchema.safeParse(
    present(env.WOLF_SERIES_MAX_POINTS) ?? DEFAULT_WOLF_SERIES_MAX_POINTS,
  );
  if (!seriesMaxPointsResult.success) {
    throw WolfError.misconfigured(
      "WOLF_SERIES_MAX_POINTS",
      "WOLF_SERIES_MAX_POINTS must be a whole COUNT of points (>= 1), got " +
        JSON.stringify(env.WOLF_SERIES_MAX_POINTS),
    );
  }

  const nodeEnv = env.NODE_ENV ?? "development";

  return {
    port: portResult.data,
    logLevel: logLevelResult.data,
    nodeEnv,
    mcpUrl,
    mcpUrlSource,
    mcpToken,
    fredApiKey: env.FRED_API_KEY ?? "",
    marketDataCacheTtlSeconds: cacheTtlResult.data,
    seriesTokenSecret: seriesSecretFromEnv || randomBytes(32).toString("base64url"),
    seriesTokenSecretSource: seriesSecretFromEnv ? "env" : "generated",
    seriesUrlTtlSeconds: seriesTtlResult.data,
    wolfBaseImage,
    criticCron,
    scheduleCron,
    teardownDrainSeconds: drainResult.data,
    reportMaxBytes: reportMaxBytesResult.data,
    seriesMaxPoints: seriesMaxPointsResult.data,
    orangeBaseUrl,
    orangeApiKey: env.WOLF_API_KEY ?? "",
    allowedEmails: parseAllowedEmails(env.WOLF_ALLOWED_EMAILS),
    sessionSecret,
    testLogin: parseTestLogin(env.WOLF_TEST_LOGIN, nodeEnv),
  };
}
