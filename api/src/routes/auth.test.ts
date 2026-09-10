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
import { createBobClient } from "../bob/client.js";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, setSessionCookie } from "../auth/session.js";
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
const OTHER_SECRET = "a-completely-different-secret-0123456789ab";
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
let closers: Array<() => void>;

beforeEach(() => {
  recorded = [];
  closers = [];
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(ORANGE);
});

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

function config(env: NodeJS.ProcessEnv = {}): WolfConfig {
  return loadConfig(
    {
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: ALLOWED,
      WOLF_API_KEY: API_KEY,
      BOB_BASE_URL: ORANGE,
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

/**
 * `now` is only ever used to back-date the COOKIE'S ISSUE TIME on mint
 * (`createAuthRouter`'s injectable clock) — `requireSignedIn`'s expiry check
 * always uses the real `Date.now()`, so a test proves expiry by minting with
 * an old `now`, never by faking the clock the guard reads at request time.
 */
async function harness(cfg: WolfConfig = config(), now?: () => number): Promise<string> {
  const logger = createLogger({ logLevel: "silent" });
  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.use(
    createAuthRouter({
      client: createBobClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger }),
      config: cfg,
      logger,
      now,
    }),
  );
  app.use(createErrorHandler(logger));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  closers.push(() => server.close());
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

async function request(
  base: string,
  method: string,
  path: string,
  cookie?: string,
): Promise<{ status: number; json: any; setCookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
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

/** Pulls just the `wolf_session=...` pair out of a Set-Cookie header. */
function cookiePair(setCookie: string | null): string {
  const first = (setCookie ?? "").split(",")[0] ?? "";
  return first.split(";")[0] ?? "";
}

/** Everything on a Set-Cookie header except the leading `name=value` pair, as a set of lower-cased attribute tokens (order-independent). */
function cookieAttributes(setCookie: string | null): Set<string> {
  const parts = (setCookie ?? "").split(";").slice(1);
  return new Set(parts.map((p) => p.trim().toLowerCase()).filter((p) => p !== ""));
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

// ── GET /api/auth/me (W8b, owner decision R100) ─────────────────────────
//
// W8's guard (`requireSignedIn`) supplies four of the five 401 cases for
// free — no cookie, an unsigned cookie, a cookie signed with a different
// secret, and an expired cookie — because this route is simply mounted
// behind it. The fifth (an email removed from WOLF_ALLOWED_EMAILS after the
// cookie was issued) is not something the guard alone can know, so the
// route checks it itself and reports it through the SAME refusal helper.

describe("auth_me", () => {
  it("auth_me: 200 { email } for a valid signed cookie on the allowlist", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness();
    const signIn = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    const res = await request(base, "GET", "/api/auth/me", cookiePair(signIn.setCookie));

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ email: ALLOWED });
  });

  it("auth_me: 401 with no cookie at all", async () => {
    const base = await harness();

    const res = await request(base, "GET", "/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("auth_me: 401 with an unsigned cookie (no cookie-parser signature prefix)", async () => {
    const base = await harness();

    const res = await request(base, "GET", "/api/auth/me", `${SESSION_COOKIE_NAME}=not-a-signed-value`);

    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("auth_me: 401 with a cookie signed by a DIFFERENT secret", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const otherBase = await harness(config({ WOLF_SESSION_SECRET: OTHER_SECRET }));
    const signIn = await post(otherBase, "/api/auth/google", { credential: CREDENTIAL });

    const base = await harness(); // the real secret, SECRET
    const res = await request(base, "GET", "/api/auth/me", cookiePair(signIn.setCookie));

    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("auth_me: 401 with an expired cookie", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const longAgo = Date.now() - SESSION_MAX_AGE_MS - 60_000;
    const base = await harness(config(), () => longAgo);
    const signIn = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    const res = await request(base, "GET", "/api/auth/me", cookiePair(signIn.setCookie));

    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("auth_me: 401 for a validly-signed cookie whose email is no longer on WOLF_ALLOWED_EMAILS", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness(); // ALLOWED is on the allowlist here
    const signIn = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    // Same secret (so the signature still verifies), a narrower allowlist.
    const otherBase = await harness(config({ WOLF_ALLOWED_EMAILS: "someone-else@badcode.dev" }));
    const res = await request(otherBase, "GET", "/api/auth/me", cookiePair(signIn.setCookie));

    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("auth_me: the 401 body is requireSignedIn's own shape, not a second error taxonomy", async () => {
    const base = await harness();

    const res = await request(base, "GET", "/api/auth/me");

    // `notSignedInError` sets no `details`, and `res.json` drops undefined
    // keys entirely (JSON.stringify semantics), so the wire body carries
    // only `kind` and `message` — the same two keys every other WolfError
    // refusal in this file asserts on (`res.json.kind`).
    expect(Object.keys(res.json).sort()).toEqual(["kind", "message"].sort());
    expect(res.json.kind).toBe("forbidden");
    expect(typeof res.json.message).toBe("string");
  });

  it("auth_me: normalises the cookie's email the same way W8 does — trimmed and lower-cased", async () => {
    // Minted directly with `setSessionCookie`, bypassing /api/auth/google,
    // so the un-normalised input reaches the cookie exactly as given —
    // proving THIS route trims, not that the sign-in path already did.
    const cfg = config({ WOLF_ALLOWED_EMAILS: "kai@example.com" });
    const logger = createLogger({ logLevel: "silent" });
    const mintApp = express();
    mintApp.use(cookieParser(cfg.sessionSecret));
    mintApp.get("/mint", (_req, res) => {
      setSessionCookie(res, "  Kai@Example.COM  ", cfg, Date.now());
      res.status(204).send();
    });
    const mintServer = mintApp.listen(0);
    await new Promise<void>((resolve) => mintServer.once("listening", () => resolve()));
    closers.push(() => mintServer.close());
    const mintPort = (mintServer.address() as AddressInfo).port;
    const mintRes = await fetch(`http://127.0.0.1:${mintPort}/mint`);

    const base = await harness(cfg);
    const res = await request(base, "GET", "/api/auth/me", cookiePair(mintRes.headers.get("set-cookie")));

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ email: "kai@example.com" });
  });
});

// ── POST /api/auth/logout (W8b, owner decision R100) ────────────────────

describe("auth_logout", () => {
  it("auth_logout: 204 and clears wolf_session for a signed-in caller", async () => {
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness();
    const signIn = await post(base, "/api/auth/google", { credential: CREDENTIAL });

    const res = await request(base, "POST", "/api/auth/logout", cookiePair(signIn.setCookie));

    expect(res.status).toBe(204);
    // The cleared value is itself a signed cookie (an hmac of the empty
    // string, since `signed: true` travels through unchanged) — so it is
    // NOT literally empty. Same name, and an Expires in the deep past.
    expect(res.setCookie ?? "").toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    expect((res.setCookie ?? "").toLowerCase()).toContain("expires=thu, 01 jan 1970");
  });

  it("auth_logout: 204 even with NO cookie — signing out when already signed out is not an error", async () => {
    const base = await harness();

    const res = await request(base, "POST", "/api/auth/logout");

    expect(res.status).toBe(204);
  });

  it("auth_logout: 204 even with an invalid/expired cookie", async () => {
    const base = await harness();

    const res = await request(base, "POST", "/api/auth/logout", `${SESSION_COOKIE_NAME}=garbage`);

    expect(res.status).toBe(204);
  });

  it("auth_logout: GET is never allowed — 404 or 405, never 204", async () => {
    const base = await harness();

    const res = await request(base, "GET", "/api/auth/logout");

    expect([404, 405]).toContain(res.status);
  });

  it("auth_logout: the cleared cookie matches the minted one's name, path, SameSite and Secure attribute for attribute", async () => {
    // Expires/Max-Age are deliberately EXCLUDED from this comparison: an
    // immediate expiry that DIFFERS from the minted one is the entire point
    // of clearing a cookie, not a mismatch to catch. The criterion names
    // name, path, SameSite and Secure specifically — those are asserted
    // attribute for attribute; HttpOnly is checked too since it is the same
    // kind of security-relevant flag and the code path preserves it.
    orangeAnswers(200, { email: ALLOWED, email_verified: true });
    const base = await harness();
    const signIn = await post(base, "/api/auth/google", { credential: CREDENTIAL });
    const minted = cookieAttributes(signIn.setCookie);
    expect([...minted].some((a) => a.startsWith("max-age="))).toBe(true); // sanity: it WAS a maxAge cookie

    const res = await request(base, "POST", "/api/auth/logout", cookiePair(signIn.setCookie));
    const cleared = cookieAttributes(res.setCookie);

    // Same cookie NAME (the value itself differs deliberately: the cleared
    // value is a signature over the empty string, not literally empty).
    expect(cookiePair(res.setCookie).split("=")[0]).toBe(SESSION_COOKIE_NAME);
    // Same PATH and SameSite.
    expect(cleared.has("path=/")).toBe(true);
    expect(minted.has("path=/")).toBe(true);
    expect(cleared.has("samesite=lax")).toBe(true);
    expect(minted.has("samesite=lax")).toBe(true);
    // Same SECURE-ness (this test's NODE_ENV=test config sets it, so both
    // sides carry the flag — asserted rather than assumed).
    expect(cleared.has("secure")).toBe(minted.has("secure"));
    expect(minted.has("secure")).toBe(true);
    // HttpOnly on both, though not named explicitly in the criterion.
    expect(cleared.has("httponly")).toBe(true);
    expect(minted.has("httponly")).toBe(true);
    // The clearing cookie carries NO Max-Age — an immediate expiry, not a
    // 12-hour one, is what makes it a clear rather than a re-mint.
    expect([...cleared].some((a) => a.startsWith("max-age="))).toBe(false);
  });

  it("auth_logout: adds no unqualified guard — /api/auth/me stays guarded while /api/auth/logout stays open, on the very router this ticket edits", async () => {
    // Not a substitute for W8's own /mcp + /series/download proof (that
    // lives in app.test.ts, which this ticket does not own and re-runs
    // unchanged) — this is the local half: confirms `requireSignedIn` is
    // still attached to exactly the one route that needs it, not hoisted
    // onto the router as a whole by this ticket's edit.
    const base = await harness();
    const meNoCookie = await request(base, "GET", "/api/auth/me");
    const logoutNoCookie = await request(base, "POST", "/api/auth/logout");
    expect(meNoCookie.status).toBe(401); // /api/auth/me IS guarded — the control
    expect(logoutNoCookie.status).toBe(204); // /api/auth/logout is deliberately NOT guarded
  });
});
