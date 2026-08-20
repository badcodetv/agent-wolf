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
 * (`ORANGE_DIND_CONTAINER`, `WOLF_WEB_PORT`, `WOLF_MCP_URL`) that this file
 * does NOT read — they configure docker-compose / nginx, not this process.
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
}

/**
 * Reads and validates process.env. Throws a `WolfError` of kind
 * `misconfigured`, naming the offending variable, on any invalid value.
 * Pass an explicit `env` (e.g. in a test) to avoid depending on the real
 * process environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WolfConfig {
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

  return {
    port: portResult.data,
    logLevel: logLevelResult.data,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
