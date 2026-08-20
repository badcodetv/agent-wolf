import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { WolfError } from "./errors.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config fails fast, before a logger even exists — misconfiguration is
    // fatal at boot, not something to log-and-continue.
    if (err instanceof WolfError) {
      // eslint-disable-next-line no-console
      console.error(`[wolf-api] fatal: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config);
  const app = createApp(logger);

  app.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, "wolf-api listening");
  });
}

main();
