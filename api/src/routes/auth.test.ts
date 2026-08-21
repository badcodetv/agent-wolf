import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import express from "express";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createErrorHandler } from "../app.js";
import { loadConfig, type WolfConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createOrangeClient } from "../orange/client.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { createAuthRouter } from "./auth.js";

// design/2026-08-20-agent-wolf.md, W8's acceptance criteria: the allowlist and
// the three answers `POST /auth/verify-google` gives. Test names are prefixed
// `auth_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism — no msw, no
// nock, no live network). Local net connect stays enabled because the app
// under test is a real express server on 127.0.0.1.

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const ALLOWED = "kai@badcode.dev";
const CREDENTIAL = "google-id-token.for.tests";

interface Recorded {
  method: string;
  path: string;
  body: string;
  apiKey: string;
}

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;
let recorded: Recorded[];
let close: (() => void) | undefined;

beforeEach(() => {
  recorded = [];
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

function config(env: NodeJS.ProcessEnv = {}): WolfConfig {
  return loadConfig(
    {
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: ALLOWED,
      WOLF_API_KEY: API_KEY,
      ORANGE_BASE_URL: ORANGE,
      NODE_ENV: "test",
      ...env,
    },
    { readRouteTable: () => undefined },
  );
}

/** Answers `POST /auth/verify-google` with one canned response. */
function orangeAnswers(status: number, body: unknown): void {
  pool
    .intercept({ method: "POST", path: "/auth/verify-google" })
    .reply((opts) => {
      const headers = (opts.headers ?? {}) as Record<string, string>;
      recorded.push({
        method: "POST",
        path: String(opts.path),
        body: typeof opts.body === "string" ? opts.body : "",
        apiKey: headers["X-API-Key"] ?? headers["x-api-key"] ?? "",
      });
      return {
        statusCode: status,
        data: typeof body === "string" ? body : JSON.stringify(body),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    })
    .persist();
}

async function harness(cfg: WolfConfig = config()): Promise<string> {
  const logger = createLogger({ logLevel: "silent" });
  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.use(
    createAuthRouter({
      client: createOrangeClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger }),
      config: cfg,
      logger,
    }),
  );
  app.use(createErrorHandler(logger));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any; setCookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

// ── POST /api/auth/google ───────────────────────────────────────────────

describe("auth_google", () => {
  it("auth_google: an allowlisted identity is signed in, and the cookie is set", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness();

    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ email: ALLOWED });
    expect(res.setCookie ?? "").toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    // Server-side, with the project API key — that route is API-key-only
    // (`authenticatedByAPIKey`), and the credential goes nowhere else.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.apiKey).toBe(API_KEY);
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ credential: CREDENTIAL });
  });

  it("auth_google: an identity Orange VERIFIES but the allowlist does not contain is 403 forbidden, with no cookie", async () => {
    // Orange verifying a token is necessary, never sufficient.
    orangeAnswers(200, { email: "stranger@example.com", email_verified: true });
    const base = await harness();

    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    expect(res.status).toBe(403);
    expect(res.json.kind).toBe("forbidden");
    expect(res.setCookie).toBeNull();
  });

  it("auth_google: the allowlist match is case-insensitive", async () => {
    orangeAnswers(200, { email: "KAI@BadCode.dev", email_verified: true });
    const base = await harness();
    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ email: ALLOWED });
  });

  it("auth_google: Orange's 401 is `forbidden` — an invalid credential", async () => {
    orangeAnswers(401, "invalid credential");
    const base = await harness();

    const res = await post(base, "/api/auth/google", { credential: "not-a-token" });

    expect(res.json.kind).toBe("forbidden");
    expect(res.status).toBe(403);
    expect(res.json.message).toContain("invalid credential");
    expect(res.setCookie).toBeNull();
  });

  it("auth_google: Orange's 404 is `misconfigured` naming GOOGLE_CLIENT_ID, NOT a rejected user", async () => {
    // `registerVerifyGoogle` mounts nothing when GOOGLE_CLIENT_ID is unset on
    // ORANGE. A configuration hole must not read as a rejected sign-in.
    orangeAnswers(404, "404 page not found");
    const base = await harness();

    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    expect(res.json.kind).toBe("misconfigured");
    expect(res.json.kind).not.toBe("forbidden");
    expect(res.json.message).toContain("GOOGLE_CLIENT_ID");
  });

  it("auth_google: Orange's 403 is `misconfigured` naming WOLF_API_KEY — Wolf's credential, not the user's", async () => {
    orangeAnswers(403, "project api key required");
    const base = await harness();

    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    expect(res.json.kind).toBe("misconfigured");
    expect(res.json.message).toContain("WOLF_API_KEY");
  });

  it("auth_google: a body with no credential is 400 invalid and never reaches Orange", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness();

    const res = await post(base, "/api/auth/google", {});

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(recorded).toHaveLength(0);
  });

  it("auth_google: an identity with email_verified false is refused even on a 200", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: false });
    const base = await harness();
    const res = await post(base, "/api/auth/google", { credential: CREDENTIAL });
    expect(res.status).toBe(403);
    expect(res.setCookie).toBeNull();
  });
});

// ── POST /api/auth/dev-login (owner decision B6) ────────────────────────

describe("auth_dev_login", () => {
  it("auth_dev_login: is NOT mounted when WOLF_TEST_LOGIN is unset", async () => {
    const base = await harness();
    const res = await post(base, "/api/auth/dev-login", { email: ALLOWED, password: "pw" });
    expect(res.status).toBe(404);
  });

  it("auth_dev_login: signs in with the configured pair when WOLF_TEST_LOGIN is set", async () => {
    const base = await harness(config({ WOLF_TEST_LOGIN: `${ALLOWED}:hunter2` }));
    const res = await post(base, "/api/auth/dev-login", { email: ALLOWED, password: "hunter2" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ email: ALLOWED });
    expect(res.setCookie ?? "").toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    // Google is never consulted: that is the whole point offline.
    expect(recorded).toHaveLength(0);
  });

  it("auth_dev_login: a wrong password is 403, with no cookie", async () => {
    const base = await harness(config({ WOLF_TEST_LOGIN: `${ALLOWED}:hunter2` }));
    const res = await post(base, "/api/auth/dev-login", { email: ALLOWED, password: "wrong" });
    expect(res.status).toBe(403);
    expect(res.setCookie).toBeNull();
  });

  it("auth_dev_login: the allowlist still applies to the test login", async () => {
    const base = await harness(
      config({ WOLF_TEST_LOGIN: "stranger@example.com:hunter2", WOLF_ALLOWED_EMAILS: ALLOWED }),
    );
    const res = await post(base, "/api/auth/dev-login", {
      email: "stranger@example.com",
      password: "hunter2",
    });
    expect(res.status).toBe(403);
  });

  it("auth_dev_login: WOLF_TEST_LOGIN refuses to boot alongside NODE_ENV=production", () => {
    expect(() =>
      loadConfig(
        {
          WOLF_SESSION_SECRET: SECRET,
          WOLF_ALLOWED_EMAILS: ALLOWED,
          WOLF_TEST_LOGIN: `${ALLOWED}:hunter2`,
          NODE_ENV: "production",
        },
        { readRouteTable: () => undefined },
      ),
    ).toThrow(/WOLF_TEST_LOGIN/);
  });

  it("auth_dev_login: a WOLF_TEST_LOGIN with no password half is refused at boot", () => {
    expect(() =>
      loadConfig(
        { WOLF_SESSION_SECRET: SECRET, WOLF_ALLOWED_EMAILS: ALLOWED, WOLF_TEST_LOGIN: ALLOWED },
        { readRouteTable: () => undefined },
      ),
    ).toThrow(/WOLF_TEST_LOGIN/);
  });
});
