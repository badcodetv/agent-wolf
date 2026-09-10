#!/usr/bin/env node
/**
 * Thin CLI entrypoint for the `wolf` project bootstrap. All the logic lives
 * in api/src/bootstrap/bootstrap-project.ts (`runBootstrapFromEnv`) — this
 * file only imports and runs it, so it stays untested by design (the
 * logic it delegates to has its own suite:
 * api/src/bootstrap/bootstrap-project.test.ts).
 *
 * It is deliberately at the repo root, not under api/, so it can be run
 * directly against a real Orange deployment without going through api/'s
 * build step:
 *
 *   npx tsx scripts/bootstrap-project.ts
 *
 * Required in the environment: WOLF_API_KEY (the wolf project's API key).
 * Optional: BOB_BASE_URL (default http://localhost:8099, correct for
 * the compose stack — wolf-api shares DinD's network namespace), plus
 * whatever api/src/config.ts already reads (WOLF_MCP_URL, WOLF_BASE_IMAGE,
 * WOLF_CRITIC_CRON, …). Safe to re-run: a second run against an
 * already-bootstrapped project is a no-op.
 */
import { runBootstrapFromEnv } from "../api/src/bootstrap/bootstrap-project.js";

runBootstrapFromEnv()
  .then((result) => {
    // eslint-disable-next-line no-console
    console.log("wolf bootstrap complete:", JSON.stringify(result));
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("wolf bootstrap failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
