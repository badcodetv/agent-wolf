import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApp, createErrorHandler } from "./app.js";
import { createLogger } from "./logger.js";
import { loadConfig } from "./config.js";

/** A config good enough to build the app: a well-formed MCP token (W7 —
 * `createWolfMcp` refuses to build without one), the three variables W8's
 * `assertSessionConfigured` requires at boot (session secret, allowlist,
 * Orange API key), and no route table, so gateway discovery does not depend
 * on the machine running the test. */
function testConfig(env: NodeJS.ProcessEnv = {}) {
  return loadConfig(
    {
      WOLF_MCP_TOKEN: "wolf-mcp-token-for-tests-0123456789abcdef",
      WOLF_SESSION_SECRET: "session-secret-for-tests-0123456789abcdef",
      WOLF_ALLOWED_EMAILS: "kai@badcode.dev",
      WOLF_API_KEY: "wolf-api-key-for-tests",
      ...env,
    },
    { readRouteTable: () => undefined },
  );
}

describe("createApp", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("answers GET /api/healthz with 200", async () => {
    const app = createApp(createLogger({ logLevel: "silent" }), testConfig());
    const server = app.listen(0);
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  // R39 leak test: an unhandled throw must be classified `internal` (500)
  // and its message must NEVER reach the response body — it may contain a
  // stack trace or a credential. Mounted on a minimal throwaway app (rather
  // than adding a test-only route to createApp's real route table) that
  // wires up the exact same createErrorHandler the production app uses.
  it("maps an unhandled throw to kind=internal, status 500, and never echoes its message", async () => {
    const app = express();
    app.get("/api/boom", () => {
      throw new Error("secret-ish detail");
    });
    app.use(createErrorHandler(createLogger({ logLevel: "silent" })));

    const server = app.listen(0);
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/boom`);
    const bodyText = await res.text();

    expect(res.status).toBe(500);
    expect(bodyText).not.toContain("secret-ish detail");
    expect(JSON.parse(bodyText)).toEqual({ kind: "internal", message: "internal error" });
  });

  // W7's mount. X1 fails without these two lines in createApp, and the
  // failure would first surface nine tickets later, inside a container.
  describe("W7 market-data mount", () => {
    async function listen(app: ReturnType<typeof createApp>): Promise<string> {
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      close = () => server.close();
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    }

    it("mounts /mcp — an unauthenticated call is rejected, not 404", async () => {
      const base = await listen(createApp(createLogger({ logLevel: "silent" }), testConfig()));
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("mounts /series/download — a tokenless call is 403, not 404", async () => {
      const base = await listen(createApp(createLogger({ logLevel: "silent" }), testConfig()));
      const res = await fetch(`${base}/series/download`);
      expect(res.status).toBe(403);
    });

    // W11's mount, added 2026-08-24 after its verifier found the hole (R133).
    // Removing BOTH `app.use` lines left the whole suite green — 32 files,
    // 1018 tests — because every test in embed.test.ts and series.test.ts
    // builds its own bare express() app and never exercises createApp. In
    // production both routes would 404 and nothing would say so; the failure
    // would first surface in W13, in a browser.
    //
    // ⚠️ "401 when signed out" does NOT discriminate here, and asserting it
    // would be a test that only looks like a guard: W8 mounts a PATH-PREFIXED
    // `router.use("/api/hypotheses", requireSignedIn)` (routes/hypotheses.ts:396),
    // so every path under that prefix 401s whether or not W11's routers are
    // mounted. Verified: with both mounts deleted, a signed-out probe still
    // returned 401.
    //
    // So: sign in, then send a MALFORMED id. W11's `requireHypothesisId`
    // rejects it as 400 `invalid` BEFORE any upstream call, so this needs no
    // MockAgent and touches no network. Unmounted, Express falls through to
    // 404. 400-vs-404 is the discriminator.
    async function signedInBase(): Promise<{ base: string; cookie: string }> {
      const base = await listen(
        createApp(createLogger({ logLevel: "silent" }), testConfig({ WOLF_TEST_LOGIN: "kai@badcode.dev:test-password" })),
      );
      const res = await fetch(`${base}/api/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "kai@badcode.dev", password: "test-password" }),
      });
      expect(res.status).toBeLessThan(400);
      return { base, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
    }

    it("mounts the embed-token route — a malformed id is 400, not 404", async () => {
      const { base, cookie } = await signedInBase();
      const res = await fetch(`${base}/api/hypotheses/NOTANID/embed-token`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it("mounts the series route — a malformed id is 400, not 404", async () => {
      const { base, cookie } = await signedInBase();
      const res = await fetch(`${base}/api/hypotheses/NOTANID/series/brent_crude`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it("refuses to build at all when WOLF_MCP_TOKEN is unset, naming the variable", () => {
      // W7's check runs BEFORE W8's session checks in createApp, deliberately:
      // this assertion is what would otherwise start naming WOLF_SESSION_SECRET.
      const withoutToken = loadConfig(
        { WOLF_SESSION_SECRET: "session-secret-for-tests-0123456789abcdef", WOLF_ALLOWED_EMAILS: "kai@badcode.dev", WOLF_API_KEY: "k" },
        { readRouteTable: () => undefined },
      );
      expect(() => createApp(createLogger({ logLevel: "silent" }), withoutToken)).toThrow(
        /WOLF_MCP_TOKEN/,
      );
    });
  });
});
