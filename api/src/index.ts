import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { WolfError } from "./errors.js";

/**
 * A `WolfError` raised while wiring the process up is fatal and gets one
 * readable line, not a stack trace. Anything else rethrows: an unexpected
 * throw during boot is a bug, and its stack is what diagnoses it.
 *
 * `err.message` is safe to print here because every boot-time `WolfError`
 * is a `misconfigured` one, which by construction names the offending
 * VARIABLE and never carries its value.
 */
function fatal(err: unknown): never {
  if (err instanceof WolfError) {
    // eslint-disable-next-line no-console
    console.error(`[wolf-api] fatal: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config fails fast, before a logger even exists — misconfiguration is
    // fatal at boot, not something to log-and-continue.
    fatal(err);
  }

  const logger = createLogger(config);
  // Also fatal-on-misconfiguration: createApp builds the MCP server, which
  // refuses to exist without WOLF_MCP_TOKEN (W7). Without this catch the
  // operator would get a stack trace instead of the one line naming the
  // variable they forgot to set.
  let app;
  try {
    app = createApp(logger, config);
  } catch (err) {
    fatal(err);
  }

  // Logged once, at boot: which of the three WOLF_MCP_URL resolution paths
  // (explicit / discovered / fallback) was used. See config.ts's "DinD
  // gateway discovery" section — a silent shift in the DinD bridge address
  // makes every MCP tool call from inside a session time out with no
  // obvious cause, so this line is the diagnostic for that failure mode.
  logger.info({ mcpUrl: config.mcpUrl, mcpUrlSource: config.mcpUrlSource }, "resolved WOLF_MCP_URL");

  // Which of the two signing-secret paths was taken. The VALUE is never
  // logged — only where it came from. `generated` means download URLs
  // minted before a restart stop verifying after it (bounded anyway by
  // WOLF_SERIES_URL_TTL_SECONDS), which is the diagnostic for "the agent's
  // curl started 403-ing after a redeploy".
  logger.info(
    { seriesTokenSecretSource: config.seriesTokenSecretSource },
    "resolved WOLF_SERIES_TOKEN_SECRET",
  );

  app.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, "wolf-api listening");
  });
}

main();
