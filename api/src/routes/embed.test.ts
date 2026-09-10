import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import pino from "pino";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createErrorHandler } from "../app.js";
import { loadConfig, type WolfConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createBobClient } from "../bob/client.js";
import { setSessionCookie } from "../auth/session.js";
import { createEmbedRouter, embedUrlFor } from "./embed.js";

// design/2026-08-20-agent-wolf.md, W11's acceptance criteria for
// `GET /api/hypotheses/:id/embed-token`. Test names are prefixed `embed_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism — no msw, no
// nock, no live network). Every body below is SYNTHETIC and is not presented
// as a recording: `POST /agent/embed-token`'s real answer is two fields
// (`go/cmd/agentd/embedtoken.go`'s `embedTokenResponse`), and that is what the
// stub returns.

const ORANGE = "http://orange.test:4100";
const PUBLIC = "http://orange-public.test:8080";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";

/**
 * A token that is unmistakable in a log line: three JWT-ish segments, and a
 * middle segment nothing else in the process could produce by accident. The
 * "never logged" assertion greps for it, so a substring that could appear for
 * some other reason would make that test pass vacuously.
 */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.WOLF-EMBED-TOKEN-SENTINEL-9f3a1c.sig-4b2e";

// ── The stub Orange ─────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: string;
}

interface Answer {
  status: number;
  body: string;
}

interface StubConfig {
  /** The answer to `POST /agent/embed-token`. */
  embedToken?: Answer;
}

class Stub {
  readonly requests: Recorded[] = [];

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {}

  get embedTokenRequests(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/embed-token");
  }

  install(): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          this.requests.push({
            method,
            path,
            body: typeof opts.body === "string" ? opts.body : "",
          });
          const answer = this.route(method, new URL(path, ORANGE).pathname);
          return {
            statusCode: answer.status,
            data: answer.body as never,
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        })
        .persist();
    }
  }

  private route(method: string, path: string): Answer {
    if (method === "POST" && path === "/agent/embed-token") {
      return (
        this.config.embedToken ?? {
          status: 200,
          // Orange's real field names: `token` and `expires_at`, the latter
          // being the token's own `exp` claim in unix SECONDS.
          body: JSON.stringify({ token: TOKEN, expires_at: 1787334947 }),
        }
      );
    }
    return { status: 404, body: `unrouted in the stub: ${path}` };
  }
}

// ── Harness ─────────────────────────────────────────────────────────────

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;
let close: (() => void) | undefined;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(ORANGE);
});

afterEach(async () => {
  close?.();
  close = undefined;
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

function config(overrides: Record<string, string> = {}): WolfConfig {
  return loadConfig(
    {
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: OWNER,
      WOLF_API_KEY: API_KEY,
      BOB_BASE_URL: ORANGE,
      BOB_PUBLIC_URL: PUBLIC,
      NODE_ENV: "test",
      ...overrides,
    },
    { readRouteTable: () => undefined },
  );
}

/** A real pino instance writing into an array, so "never logged" is graded
 * against what the process ACTUALLY emitted rather than against a spy. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback): void {
      lines.push(String(chunk));
      callback();
    },
  });
  // `level: "trace"`, deliberately: a logger set to `info` would let a debug
  // line carrying a credential through unexamined.
  return { logger: pino({ level: "trace" }, stream) as unknown as Logger, lines };
}

interface Harness {
  base: string;
  stub: Stub;
  cookie: string;
  lines: string[];
}

async function harness(stubConfig: StubConfig = {}, cfg: WolfConfig = config()): Promise<Harness> {
  const stub = new Stub(pool, stubConfig);
  stub.install();
  const { logger, lines } = capturingLogger();
  const client = createBobClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger });

  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.post("/test-sign-in", (_req: Request, res: Response) => {
    setSessionCookie(res, OWNER, cfg);
    res.status(200).end();
  });
  app.use(createEmbedRouter({ client, config: cfg, logger }));
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const signIn = await fetch(`${base}/test-sign-in`, { method: "POST" });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, stub, cookie, lines };
}

async function get(
  h: Harness,
  path: string,
  withCookie = true,
): Promise<{ status: number; json: any; raw: string }> {
  const res = await fetch(`${h.base}${path}`, {
    headers: withCookie ? { cookie: h.cookie } : {},
    redirect: "manual",
  });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: res.status, json, raw };
}

// ── The happy path and the response shape ───────────────────────────────

describe("embed_token", () => {
  it("embed_token: mints through POST /agent/embed-token and returns token, expires_at_sec and embed_url", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      token: TOKEN,
      expires_at_sec: 1787334947,
      embed_url: `${PUBLIC}/embed/session/hyp-${ID}`,
    });

    // Exactly one upstream call, and it names the SESSION, never the bare id.
    expect(h.stub.embedTokenRequests).toHaveLength(1);
    const body = JSON.parse(h.stub.embedTokenRequests[0]?.body ?? "{}");
    expect(body.session).toBe(`hyp-${ID}`);
  });

  it("embed_token: the outbound body carries NO ttl_seconds key at all, so Orange applies its own 900s default", async () => {
    const h = await harness();
    await get(h, `/api/hypotheses/${ID}/embed-token`);

    const raw = h.stub.embedTokenRequests[0]?.body ?? "";
    const body = JSON.parse(raw);
    // `not.toHaveProperty`, not `toBeUndefined`: the criterion is about the
    // KEY. `{"ttl_seconds": 0}` would also read as the default on the Orange
    // side, but `{"ttl_seconds": 3600}` is one careless edit away from it and
    // the ceiling is the one value hazard H1 says never to ask for.
    expect(body).not.toHaveProperty("ttl_seconds");
    expect(raw).not.toContain("ttl_seconds");
    expect(raw).not.toContain("3600");
  });

  it("embed_token: expires_at_sec is unix SECONDS, passed through from Orange's exp claim", async () => {
    const h = await harness({
      embedToken: { status: 200, body: JSON.stringify({ token: TOKEN, expires_at: 1787334947 }) },
    });
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    // Seconds, not milliseconds. W13 computes a T-120s refresh from this, and
    // a value in ms would be ~1.787e12 — a token that never refreshes.
    expect(res.json.expires_at_sec).toBe(1787334947);
    expect(res.json.expires_at_sec).toBeLessThan(1e11);
  });

  it("embed_token: embed_url is the BROWSER-reachable Orange origin, never BOB_BASE_URL", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    expect(res.json.embed_url).toBe(`${PUBLIC}/embed/session/hyp-${ID}`);
    // BOB_BASE_URL is agentd inside DinD's netns; a browser cannot reach it.
    expect(res.json.embed_url).not.toContain(ORANGE);
  });

  it("embed_token: BOB_PUBLIC_URL's trailing slash never doubles in embed_url", async () => {
    const h = await harness({}, config({ BOB_PUBLIC_URL: `${PUBLIC}/` }));
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    expect(res.json.embed_url).toBe(`${PUBLIC}/embed/session/hyp-${ID}`);
  });

  it("embed_token: the route never builds the fragment — the token is in the BODY only", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    // A `#token=…` built here would put the credential into whatever the
    // client does with the URL. The client appends the fragment.
    expect(res.json.embed_url).not.toContain("#");
    expect(res.json.embed_url).not.toContain(TOKEN);
    expect(res.json.embed_url).not.toContain("token=");
  });

  it("embed_token: embedUrlFor adds the hyp- prefix exactly once", () => {
    // § Vocabulary: ids are BARE and the prefix belongs to the session name.
    expect(embedUrlFor(PUBLIC, ID)).toBe(`${PUBLIC}/embed/session/hyp-${ID}`);
    expect(embedUrlFor(PUBLIC, ID)).not.toContain("hyp-hyp-");
  });
});

// ── The credential rule ─────────────────────────────────────────────────

describe("embed_token_credentials", () => {
  it("embed_token_credentials: neither the token nor WOLF_API_KEY appears in ANY captured pino line", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);
    expect(res.status).toBe(200);

    // The logger really did write — otherwise this whole test is vacuous.
    expect(h.lines.length).toBeGreaterThan(0);
    const logged = h.lines.join("\n");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("WOLF-EMBED-TOKEN-SENTINEL");
    expect(logged).not.toContain(API_KEY);
    // And the route did log something useful about the mint, so "nothing was
    // logged" is not how it passes.
    expect(logged).toContain("embed token minted");
  });

  it("embed_token_credentials: a FAILED mint logs no credential either", async () => {
    const h = await harness({ embedToken: { status: 403, body: "project api key required" } });
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    expect(res.status).toBe(403);
    const logged = h.lines.join("\n");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(TOKEN);
    // The upstream body is carried on the WolfError but is NOT logged and is
    // NOT echoed to the client beyond the taxonomy message.
    expect(res.raw).not.toContain(API_KEY);
  });
});

// ── Authentication, and the 404 ─────────────────────────────────────────

describe("embed_token_auth", () => {
  it("embed_token_auth: no wolf_session cookie is 401, no token, and NO upstream request at all", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`, false);

    expect(res.status).toBe(401);
    expect(res.raw).not.toContain(TOKEN);
    // The guard runs BEFORE the handler: Orange was never asked. An
    // implementation that minted first and checked after would leak a
    // project-authority token's worth of work to an anonymous caller.
    expect(h.stub.requests).toEqual([]);
  });

  it("embed_token_auth: a forged cookie signature is 401 and still makes no upstream request", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/api/hypotheses/${ID}/embed-token`, {
      headers: { cookie: "wolf_session=s%3Anot-a-valid-signature.deadbeef" },
    });

    expect(res.status).toBe(401);
    expect(h.stub.requests).toEqual([]);
  });
});

describe("embed_token_not_found", () => {
  it("embed_token_not_found: Orange's 404 for an absent session becomes 404 not_found", async () => {
    const h = await harness({ embedToken: { status: 404, body: "session not found" } });
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
  });

  it("embed_token_not_found: absent and another-project are ONE answer — the route is not an existence oracle", async () => {
    // Orange answers 404 for absent, malformed and foreign alike
    // (go/cmd/agentd/embedtoken.go), and Wolf does not try to tell them apart.
    const h = await harness({ embedToken: { status: 404, body: "session not found" } });
    const res = await get(h, `/api/hypotheses/deadbeef/embed-token`);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(JSON.stringify(res.json)).not.toContain("another project");
  });

  it("embed_token_not_found: a malformed hypothesis id is 400 invalid and never reaches Orange", async () => {
    const h = await harness();
    // `hyp-`-prefixed: the `hyp-hyp-…` bug § Vocabulary warns about.
    const res = await get(h, `/api/hypotheses/hyp-1a2b3c4d/embed-token`);

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.requests).toEqual([]);
  });

  it("embed_token_not_found: an Orange outage is unavailable, NOT not_found", async () => {
    const h = await harness({ embedToken: { status: 503, body: "upstream down" } });
    const res = await get(h, `/api/hypotheses/${ID}/embed-token`);

    // The two must stay distinguishable: "there is no such hypothesis" and
    // "Orange is down" are different things for the UI to say.
    expect(res.status).toBe(503);
    expect(res.json.kind).toBe("unavailable");
  });
});
