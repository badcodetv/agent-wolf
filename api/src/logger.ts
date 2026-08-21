import pino from "pino";
import type { WolfConfig } from "./config.js";

/**
 * One JSON-to-stdout logger for the whole process, per
 * design/2026-08-20-agent-wolf.md § "Pinned technology choices": pino, one
 * line per request, and never a credential or a `download_url`.
 */
export function createLogger(config: Pick<WolfConfig, "logLevel">) {
  return pino({ level: config.logLevel });
}

export type Logger = ReturnType<typeof createLogger>;
