import { defineConfig } from "@playwright/test";

/**
 * X1's Playwright config. The stacks are stood up by `e2e/run.sh` before this
 * runs; nothing here starts a server.
 *
 * TIMEOUTS ARE LARGE ON PURPOSE, AND THE REASON IS NOT SLOWNESS.
 * There is **no force-fire route** for a schedule: agentd's scheduler fires on
 * cron minutes only and refuses nicknames (`go/agentdb/schedules.go:827`), so a
 * spec that needs a tick must wait for a real minute boundary, then for a
 * container to be provisioned inside DinD, then for the harness to run several
 * model turns, then for wolf-api's poller to sweep. Ten minutes per test is the
 * honest budget for that chain; a shorter one produces flakes that read as
 * product defects.
 */
const BASE_URL = process.env.X1_WOLF_BASE ?? "http://localhost:8091";

export default defineConfig({
  testDir: ".",
  testMatch: ["features/*.spec.ts"],
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  // Parallel across FILES, serial within one — the same pairing agent-bob's
  // stack rig uses. Each spec file owns its own hypothesis (its own session,
  // worker, schedule and datasets), so the files share nothing but the host
  // port pool and DinD. `fullyParallel: true` would break the `serial`
  // describes these specs depend on and must not be raised alone.
  fullyParallel: false,
  workers: Number(process.env.X1_WORKERS) || 3,
  // No retries. A retried e2e hides exactly the intermittent container-level
  // failure this ticket exists to find.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
});
