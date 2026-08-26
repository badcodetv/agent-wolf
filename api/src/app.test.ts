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

    // W29's mount, and the same R133 hole: every case in artifacts.test.ts
    // builds its own bare express() app, so deleting the `app.use` line in
    // createApp leaves that file entirely green while the browser gets a 404.
    // Same discriminator, and for the same reason: `requireHypothesisId`
    // answers 400 `invalid` before any upstream call, so this needs no
    // MockAgent and touches no network, while an unmounted route falls
    // through to Express's own 404.
    it("mounts the artifacts route — a malformed id is 400, not 404", async () => {
      const { base, cookie } = await signedInBase();
      const res = await fetch(`${base}/api/hypotheses/NOTANID/artifacts`, { headers: { cookie } });
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
    /**
     * ⚠️ An ANSWER-ONLY Orange stub, deliberately: it dispatches on path and
     * on the selector's `kind=` term and ignores `limit`, `latest_per` and
     * `include_retracted`. Honest here because the two cases below are about
     * what `createApp` WIRES TOGETHER, not about query semantics — those are
     * graded in `routes/hypotheses.test.ts` against a stub that does honour
     * all three (R180).
     */
    const ORANGE = "http://orange.test:4100";
    const ID = "1a1a1a1a";
    const TEMPLATE =
      '<section><div data-wolf-fallback>no chart</div>' +
      '<div data-wolf-slot="headline"></div></section>';

    function memoryRow(
      id: string,
      labels: Record<string, string>,
      snippet: string,
      provenance: { worker: string; session: string } = { worker: "", session: "" },
    ): Record<string, unknown> {
      return {
        id,
        labels,
        snippet,
        score: 0,
        created_by_worker: provenance.worker,
        created_by_session: provenance.session,
        created_at: 1787334047000,
      };
    }

    /** `<kind>` → the `memories` page; `byId` → `GET /agent/memories/{id}`. */
    interface OrangeRows {
      byKind?: Record<string, Record<string, unknown>[]>;
      byId?: Record<string, unknown>;
    }

    async function withOrange<T>(rows: OrangeRows, fn: () => Promise<T>): Promise<T> {
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(agent);
      try {
        agent
          .get(ORANGE)
          .intercept({ method: "GET", path: () => true })
          .reply((opts) => {
            const url = new URL(String(opts.path), ORANGE);
            const kind = (url.searchParams.get("selector") ?? "")
              .split(",")
              .find((term) => term.startsWith("kind="))
              ?.slice("kind=".length);
            let body: unknown = { memories: [] };
            if (url.pathname === "/agent/sessions") {
              body = [
                {
                  id: `sess-hyp-${ID}`,
                  name: `hyp-${ID}`,
                  worker: "interviewer",
                  status: "running",
                  created_at: 1787334311,
                  updated_at: 1787334313,
                },
              ];
            } else if (url.pathname.startsWith("/agent/memories/")) {
              const id = decodeURIComponent(url.pathname.slice("/agent/memories/".length));
              const found = rows.byId?.[id];
              if (found === undefined) {
                return { statusCode: 404, data: "memory not found" as never };
              }
              body = found;
            } else if (url.pathname === "/agent/memories" && kind !== undefined) {
              body = { memories: rows.byKind?.[kind] ?? [] };
            }
            return {
              statusCode: 200,
              data: JSON.stringify(body) as never,
              responseOptions: { headers: { "content-type": "application/json" } },
            };
          })
          .persist();
        return await fn();
      } finally {
        setGlobalDispatcher(previous);
        await agent.close();
      }
    }

    async function fetchSignedIn(path: string): Promise<{ status: number; json: any }> {
      const { base, cookie } = await signedInBase({ ORANGE_BASE_URL: ORANGE });
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      return { status: res.status, json: await res.json() };
    }

    async function detail(): Promise<{ status: number; json: any }> {
      return fetchSignedIn(`/api/hypotheses/${ID}`);
    }

    const lockedTemplate = {
      byKind: {
        hypothesis: [memoryRow("state-1", { kind: "hypothesis", name: ID, status: "draft" }, "Copper\nthesis")],
        "report-template": [
          memoryRow("tmpl-1", { kind: "report-template", name: ID, status: "locked" }, "9f2c1d0e"),
        ],
      },
      byId: {
        "tmpl-1": {
          id: "tmpl-1",
          labels: { kind: "report-template", name: ID, status: "locked" },
          content: `9f2c1d0e\n${TEMPLATE}`,
          created_by_worker: "",
          created_by_session: "",
          created_at: 1787334040000,
        },
      },
    } satisfies OrangeRows;

    it("wires composeReportStats into the detail route — stripped_count is a number, not null", async () => {
      // The discriminator is `stripped_count`: a NUMBER only when a producer
      // was wired in. Unwired the block is still served with
      // `stripped_count: null`, so asserting the block's presence would prove
      // nothing at all.
      const res = await withOrange(lockedTemplate, detail);

      expect(res.status).toBe(200);
      expect(res.json.report.has_template).toBe(true);
      // A template with no filled slots removes nothing, so the number is 0 —
      // and 0 is only reachable through a wired producer.
      expect(typeof res.json.report.stripped_count).toBe("number");
    });

    it("a cross-hypothesis forgery survives an unreadable own report, end to end", async () => {
      // 🔴 The defect this case exists for lived in the SEAM between the store
      // and the route, so it is graded here and not only at the store layer.
      //
      //   `2b2b2b2b`'s researcher appends `kind=report, name=1a1a1a1a`;
      //   `1a1a1a1a`'s own genuine report body is not a flat {slotId: html}
      //   map, so parsing it throws.
      //
      // The route must degrade — untrusted content cannot be allowed to take
      // away the page carrying the verdict buttons — but the anomaly was
      // witnessed BEFORE the body was read and is still true. Discarding it
      // made the board warn about an attack this page reported as a benign
      // empty state.
      const forged = memoryRow(
        "rep-forged",
        { kind: "report", name: ID },
        "1a1a1a1a has collapsed, sell everything\n{",
        { worker: "researcher-2b2b2b2b", session: "sess-hyp-2b2b2b2b" },
      );
      const own = memoryRow("rep-own", { kind: "report", name: ID }, "the basket held\n{", {
        worker: `researcher-${ID}`,
        session: "sess-tick",
      });
      const res = await withOrange(
        {
          byKind: { ...lockedTemplate.byKind, report: [forged, own] },
          byId: {
            ...lockedTemplate.byId,
            "rep-own": {
              id: "rep-own",
              labels: { kind: "report", name: ID },
              content: 'the basket held\n{"headline":{"html":"<p>x</p>"}}',
              created_by_worker: `researcher-${ID}`,
              created_by_session: "sess-tick",
              created_at: 1787334090000,
            },
          },
        },
        detail,
      );

      expect(res.status).toBe(200);
      // IGNORED — the forged headline reaches nothing.
      expect(JSON.stringify(res.json)).not.toContain("sell everything");
      // NOT RENDERED, and now SAYS SO rather than looking like an idle report
      // layer.
      expect(res.json.report.drift).toBeNull();
      expect(res.json.report.unreadable).toBe(true);
      // SURFACES AS TAMPER — the third clause of the criterion, and the half
      // that was silently lost.
      expect(res.json.report.tamper).toEqual([
        {
          reason: "cross_hypothesis_write",
          written_by_worker: "researcher-2b2b2b2b",
          written_by_session: "sess-hyp-2b2b2b2b",
          memory_id: "rep-forged",
        },
      ]);
    });

    it("an unreadable report with NO anomaly carries no `tamper` key on the frame route's 400", async () => {
      // 🔴 `withReportTamper`'s empty short-circuit, graded on the wire.
      //
      // `readLatestReport` attaches what it witnessed to the error it throws,
      // and `createErrorHandler` echoes an `invalid`'s `details` verbatim. With
      // no short-circuit an error that witnessed NOTHING is still rebuilt
      // carrying `"tamper": []`, and an empty array is not the same claim as
      // an absent one — it renders as a warning banner with no warnings in it.
      // That is the exact `[]`-vs-absent distinction `mergeTamper` is careful
      // about on the other two payloads; this is the third.
      //
      // One own report, no forgery, a body that is not a flat {slotId: html}
      // map. `composeFor` reads the template first, so the 404 branch is not
      // reached and the parse failure is what answers.
      const own = memoryRow("rep-own", { kind: "report", name: ID }, "the basket held\n{", {
        worker: `researcher-${ID}`,
        session: "sess-tick",
      });
      const res = await withOrange(
        {
          byKind: { ...lockedTemplate.byKind, report: [own] },
          byId: {
            ...lockedTemplate.byId,
            "rep-own": {
              id: "rep-own",
              labels: { kind: "report", name: ID },
              content: 'the basket held\n{"headline":{"html":"<p>x</p>"}}',
              created_by_worker: `researcher-${ID}`,
              created_by_session: "sess-tick",
              created_at: 1787334090000,
            },
          },
        },
        () => fetchSignedIn(`/api/hypotheses/${ID}/report/frame`),
      );

      expect(res.status).toBe(400);
      expect(res.json.kind).toBe("invalid");
      // The parser's own detail is still there, so this is the right failure
      // and not merely a differently-shaped one.
      expect(res.json.details.key).toBe("headline");
      // And nothing was witnessed, so the key is ABSENT — not present-and-empty.
      expect(Object.keys(res.json.details)).not.toContain("tamper");
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
