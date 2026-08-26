import { afterEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
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
    async function signedInBase(
      env: NodeJS.ProcessEnv = {},
    ): Promise<{ base: string; cookie: string }> {
      const base = await listen(
        createApp(
          createLogger({ logLevel: "silent" }),
          testConfig({ WOLF_TEST_LOGIN: "kai@badcode.dev:test-password", ...env }),
        ),
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

    // W22's wiring. `createApp` is the ONLY place `composeReportStats` is
    // handed to the hypotheses router, so this is the only test that can fail
    // when that argument is dropped — every test in hypotheses.test.ts builds
    // its own bare express() app and injects its own (or none), which is
    // exactly the R133 hole W11's two cases above were added to close.
    //
    // The discriminator is `stripped_count`: a NUMBER only when a producer
    // was wired in. Unwired the block is still served with
    // `stripped_count: null`, so asserting the block's presence would prove
    // nothing at all.
    it("wires composeReportStats into the detail route — stripped_count is a number, not null", async () => {
      const ID = "1a1a1a1a";
      const TEMPLATE =
        '<section><div data-wolf-fallback>no chart</div>' +
        '<div data-wolf-slot="headline"></div></section>';
      // ⚠️ An ANSWER-ONLY stub, deliberately: it dispatches on path and on the
      // selector's `kind=` term and ignores `limit`, `latest_per` and
      // `include_retracted`. That is honest here because the assertion is
      // about ONE thing — whether a producer was wired in — and not about
      // query semantics, which `routes/hypotheses.test.ts` grades against a
      // stub that does honour those three (R180).
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(agent);
      try {
        const pool = agent.get("http://orange.test:4100");
        pool
          .intercept({ method: "GET", path: () => true })
          .reply((opts) => {
            const url = new URL(String(opts.path), "http://orange.test:4100");
            const selector = url.searchParams.get("selector") ?? "";
            const kind = selector
              .split(",")
              .find((term) => term.startsWith("kind="))
              ?.slice("kind=".length);
            const memory = (
              id: string,
              labels: Record<string, string>,
              snippet: string,
            ): Record<string, unknown> => ({
              id,
              labels,
              snippet,
              score: 0,
              created_by_worker: "",
              created_by_session: "",
              created_at: 1787334047000,
            });
            let body: unknown = { memories: [] };
            if (url.pathname === "/agent/sessions") {
              body = [
                {
                  id: "sess-hyp-1a1a1a1a",
                  name: `hyp-${ID}`,
                  worker: "interviewer",
                  status: "running",
                  created_at: 1787334311,
                  updated_at: 1787334313,
                },
              ];
            } else if (url.pathname === `/agent/memories/tmpl-1`) {
              body = {
                id: "tmpl-1",
                labels: { kind: "report-template", name: ID, status: "locked" },
                content: `9f2c1d0e\n${TEMPLATE}`,
                created_by_worker: "",
                created_by_session: "",
                created_at: 1787334040000,
              };
            } else if (url.pathname === "/agent/memories" && kind === "hypothesis") {
              body = {
                memories: [
                  memory("state-1", { kind: "hypothesis", name: ID, status: "draft" }, "Copper\nthesis"),
                ],
              };
            } else if (url.pathname === "/agent/memories" && kind === "report-template") {
              body = {
                memories: [
                  memory("tmpl-1", { kind: "report-template", name: ID, status: "locked" }, "9f2c1d0e"),
                ],
              };
            }
            return {
              statusCode: 200,
              data: JSON.stringify(body) as never,
              responseOptions: { headers: { "content-type": "application/json" } },
            };
          })
          .persist();

        const { base, cookie } = await signedInBase({ ORANGE_BASE_URL: "http://orange.test:4100" });
        const res = await fetch(`${base}/api/hypotheses/${ID}`, { headers: { cookie } });
        expect(res.status).toBe(200);
        const detail = (await res.json()) as { report: { has_template: boolean; stripped_count: unknown } };
        expect(detail.report.has_template).toBe(true);
        // A template with no filled slots removes nothing, so the number is 0
        // — and 0 is only reachable through a wired producer. `null` here is
        // the unwired app.
        expect(typeof detail.report.stripped_count).toBe("number");
      } finally {
        setGlobalDispatcher(previous);
        await agent.close();
      }
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
