import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { WolfError } from "./errors.js";
import { createBobClient } from "./bob/client.js";
import { createHypothesisStore } from "./hypothesis/store.js";
import { createPoller } from "./hypothesis/poller.js";

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
  // gateway discovery" section — a wrong DinD bridge address here, whether
  // because the bridge moved (R43) or because the probe read the wrong row
  // (W33/R235), makes every MCP tool call from inside a session FAIL TO
  // CONNECT with no error on the Wolf side, so this line is the diagnostic
  // for that failure mode.
  //
  // 🔴 X1 measured `curl` exit 7 — could not connect. That is an ERROR, not
  // a hang, and on this stack exit 7 is the immediate-negative case: a
  // refusal returns in ~0.4ms, while a routable-but-dead address exhausts
  // the kernel's SYN retries and returns exit 28 at ~131s — never 7. So an
  // exit 7 did come back fast. Diagnose by the exit CODE all the same, not
  // by the clock, and compare this line's `mcpUrl` against DinD's own
  // docker0 address.
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

    // ⚠️ THE EVALUATION POLLER STARTS HERE, AFTER `listen`, AND NOWHERE ELSE.
    //
    // W10's second acceptance criterion: "The interval is started in
    // api/src/index.ts after app.listen, NEVER as an import side effect. A
    // test that imports createApp asserts no timer was scheduled — otherwise
    // every route test in the repo starts a live poller." `app.ts` therefore
    // does not import this module at all, and `createPoller` schedules
    // nothing until `start()` is called. `poller.test.ts` gates both halves.
    //
    // Started INSIDE the listen callback rather than after it so the first
    // tick cannot race the port actually being bound — the poller talks to
    // Bob, not to this process, but a poller running while the process is
    // still failing to bind would delete tick sessions for a service that is
    // about to exit.
    //
    // This is a SECOND Bob client and a second hypothesis store: createApp
    // builds its own and returns only the Express app, and app.ts belongs to
    // other tickets. The per-id transition mutex is shared at module scope in
    // store.ts precisely so those two stores still serialise state changes
    // against each other.
    const client = createBobClient({
      baseUrl: config.bobBaseUrl,
      apiKey: config.bobApiKey,
      logger,
    });
    const poller = createPoller({
      client,
      store: createHypothesisStore({ client, logger }),
      logger,
      config: { pollIntervalSeconds: config.pollIntervalSeconds },
    });
    poller.start();
  });
}

main();
