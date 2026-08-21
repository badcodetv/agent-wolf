import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";

import { createApp, createErrorHandler } from "../app.js";
import { loadConfig, type WolfConfig } from "../config.js";
import { WolfError } from "../errors.js";
import { createLogger } from "../logger.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  assertSessionConfigured,
  isAllowed,
  requireSignedIn,
  setSessionCookie,
  signedInUser,
} from "./session.js";

// design/2026-08-20-agent-wolf.md, W8's acceptance criteria: the cookie, the
// guard, and R79 — "requireSignedIn is exported and mounted PER ROUTER, never
// globally". Test names are prefixed `session_`.

const SECRET = "session-secret-for-tests-0123456789abcdef";
const MCP_TOKEN = "wolf-mcp-token-for-tests-0123456789abcdef";
const ALLOWED = "kai@badcode.dev";

function config(env: NodeJS.ProcessEnv = {}): WolfConfig {
  return loadConfig(
    {
      WOLF_MCP_TOKEN: MCP_TOKEN,
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: ALLOWED,
      WOLF_API_KEY: "wolf-api-key-for-tests",
      ...env,
    },
    { readRouteTable: () => undefined },
  );
}

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A minimal app carrying the same three pieces the real one does — the
 * signing secret, a route that mints a cookie, and a router that guards
 * itself — so the cookie's flags and the guard can be exercised without
 * standing up Orange.
 */
async function harness(cfg: WolfConfig = config()): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.post("/sign-in", (req: Request, res: Response) => {
    const body = req.body as { email?: string; issuedAtMs?: number };
    const user = setSessionCookie(res, body.email ?? ALLOWED, cfg, body.issuedAtMs ?? Date.now());
    res.status(200).json({ email: user.email });
  });
  const guarded = express.Router();
  guarded.use(requireSignedIn);
  guarded.get("/api/who", (req: Request, res: Response) => {
    res.status(200).json({ email: signedInUser(req).email });
  });
  app.use(guarded);
  app.use(createErrorHandler(createLogger({ logLevel: "silent" })));
  return listen(app);
}

async function signIn(
  base: string,
  body: Record<string, unknown> = {},
): Promise<{ cookie: string; setCookie: string }> {
  const res = await fetch(`${base}/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0] ?? "", setCookie };
}

// ── The cookie ──────────────────────────────────────────────────────────

describe("session_cookie", () => {
  it("session_cookie: is named wolf_session and carries HttpOnly, SameSite=Lax, Secure and a 12h Max-Age", async () => {
    const base = await harness(config({ NODE_ENV: "production" }));
    const { setCookie } = await signIn(base);

    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//i);
    // Express writes Max-Age in whole SECONDS; SESSION_MAX_AGE_MS is ms.
    expect(setCookie).toMatch(new RegExp(`Max-Age=${SESSION_MAX_AGE_MS / 1000}\\b`, "i"));
    // The value is signed: cookie-parser's signature prefix is `s:`, which
    // arrives URI-encoded as `s%3A`.
    expect(setCookie).toMatch(/=s%3A/);
  });

  it("session_cookie: drops Secure in development, where the browser would otherwise refuse the cookie over plain HTTP", async () => {
    const base = await harness(config({ NODE_ENV: "development" }));
    const { setCookie } = await signIn(base);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("session_cookie: lowercases the address it signs", async () => {
    const base = await harness();
    const res = await fetch(`${base}/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "KAI@BadCode.dev" }),
    });
    await expect(res.json()).resolves.toEqual({ email: "kai@badcode.dev" });
  });
});

// ── requireSignedIn ─────────────────────────────────────────────────────

describe("session_require_signed_in", () => {
  it("session_require_signed_in: a request with no cookie is 401 kind=forbidden", async () => {
    const base = await harness();
    const res = await fetch(`${base}/api/who`);
    expect(res.status).toBe(401);
    // 401 (not the taxonomy's default 403 for `forbidden`) is what keeps "you
    // are not signed in" distinguishable from the allowlist's "you are signed
    // in and still not allowed".
    await expect(res.json()).resolves.toMatchObject({ kind: "forbidden" });
  });

  it("session_require_signed_in: a valid cookie reaches the handler with the signed-in address", async () => {
    const base = await harness();
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/api/who`, { headers: { cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ email: ALLOWED });
  });

  it("session_require_signed_in: a cookie whose SIGNATURE is altered is rejected 401", async () => {
    const base = await harness();
    const { cookie } = await signIn(base);
    // Flip the last character of the signature. cookie-parser verifies the
    // HMAC and, on failure, does not populate `signedCookies` at all.
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect(tampered).not.toBe(cookie);
    const res = await fetch(`${base}/api/who`, { headers: { cookie: tampered } });
    expect(res.status).toBe(401);
  });

  it("session_require_signed_in: a cookie whose PAYLOAD is edited is rejected 401 (the signature covers it)", async () => {
    const base = await harness();
    const forged = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      JSON.stringify({ email: "attacker@example.com", iat_ms: Date.now() }),
    )}`;
    const res = await fetch(`${base}/api/who`, { headers: { cookie: forged } });
    expect(res.status).toBe(401);
  });

  it("session_require_signed_in: an expired cookie is rejected server-side, not merely by the browser", async () => {
    // The cookie's Max-Age is enforced by the BROWSER; a client that keeps
    // sending a stale cookie would otherwise stay signed in forever, because
    // the signature itself never expires.
    const base = await harness();
    const { cookie } = await signIn(base, { issuedAtMs: Date.now() - SESSION_MAX_AGE_MS - 1000 });
    const res = await fetch(`${base}/api/who`, { headers: { cookie } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ kind: "forbidden" });
  });
});

// ── R79: mounted per router, never globally ─────────────────────────────

describe("session_r79_per_router", () => {
  it("session_r79_per_router: /mcp answers a token-authenticated call with NO cookie, and does not 401", async () => {
    // A session container has no cookie and reaches wolf-api directly at the
    // DinD gateway. `app.use(requireSignedIn)` would 401 the whole
    // market-data surface INSIDE containers, where no unit test in this repo
    // looks — X1 is where it would first surface, nine tickets later.
    const base = await listen(createApp(createLogger({ logLevel: "silent" }), config()));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-wolf-mcp-token": MCP_TOKEN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(body.result?.tools)).toBe(true);
  });

  it("session_r79_per_router: /series/download with NO cookie is refused by its own token check (403), not by the cookie guard (401)", async () => {
    const base = await listen(createApp(createLogger({ logLevel: "silent" }), config()));
    const res = await fetch(`${base}/series/download`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(403);
  });

  it("session_r79_per_router: app.ts contains no unqualified app.use(requireSignedIn)", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    // Line-anchored, so a comment mentioning the anti-pattern cannot trip it.
    expect(source).not.toMatch(/^\s*app\.use\(\s*requireSignedIn/m);
  });
});

// ── The boot-time configuration checks ──────────────────────────────────

describe("session_boot_config", () => {
  it("session_boot_config: an unset WOLF_SESSION_SECRET is a misconfigured failure naming it", () => {
    const cfg = loadConfig(
      { WOLF_ALLOWED_EMAILS: ALLOWED, WOLF_API_KEY: "k" },
      { readRouteTable: () => undefined },
    );
    expect(() => assertSessionConfigured(cfg)).toThrow(/WOLF_SESSION_SECRET/);
    try {
      assertSessionConfigured(cfg);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).details).toMatchObject({ variable: "WOLF_SESSION_SECRET" });
    }
  });

  it("session_boot_config: a session secret shorter than 32 characters is refused by loadConfig", () => {
    expect(() =>
      loadConfig({ WOLF_SESSION_SECRET: "too-short" }, { readRouteTable: () => undefined }),
    ).toThrow(/WOLF_SESSION_SECRET/);
  });

  it("session_boot_config: an EMPTY allowlist is fatal — it must never silently mean everyone", () => {
    const cfg = loadConfig(
      { WOLF_SESSION_SECRET: SECRET, WOLF_API_KEY: "k" },
      { readRouteTable: () => undefined },
    );
    expect(cfg.allowedEmails.size).toBe(0);
    expect(() => assertSessionConfigured(cfg)).toThrow(/WOLF_ALLOWED_EMAILS/);
  });

  it("session_boot_config: an unset WOLF_API_KEY is fatal, naming it", () => {
    const cfg = loadConfig(
      { WOLF_SESSION_SECRET: SECRET, WOLF_ALLOWED_EMAILS: ALLOWED },
      { readRouteTable: () => undefined },
    );
    expect(() => assertSessionConfigured(cfg)).toThrow(/WOLF_API_KEY/);
  });

  it("session_boot_config: createApp refuses to build when the session secret is missing", () => {
    const cfg = loadConfig(
      { WOLF_MCP_TOKEN: MCP_TOKEN, WOLF_ALLOWED_EMAILS: ALLOWED, WOLF_API_KEY: "k" },
      { readRouteTable: () => undefined },
    );
    expect(() => createApp(createLogger({ logLevel: "silent" }), cfg)).toThrow(
      /WOLF_SESSION_SECRET/,
    );
  });
});

// ── The allowlist ───────────────────────────────────────────────────────

describe("session_allowlist", () => {
  it("session_allowlist: matches case-insensitively and ignores surrounding whitespace", () => {
    const cfg = config({ WOLF_ALLOWED_EMAILS: " Kai@BadCode.dev , jack@badcode.dev " });
    expect([...cfg.allowedEmails]).toEqual(["kai@badcode.dev", "jack@badcode.dev"]);
    expect(isAllowed("KAI@badcode.DEV", cfg)).toBe(true);
    expect(isAllowed("  jack@badcode.dev ", cfg)).toBe(true);
    expect(isAllowed("someone@else.com", cfg)).toBe(false);
  });

  it("session_allowlist: a value that is not a full address fails at boot rather than being dropped", () => {
    // `@badcode.dev` would allowlist nobody while looking like a domain rule.
    expect(() =>
      loadConfig(
        { WOLF_SESSION_SECRET: SECRET, WOLF_ALLOWED_EMAILS: "@badcode.dev" },
        { readRouteTable: () => undefined },
      ),
    ).toThrow(/WOLF_ALLOWED_EMAILS/);
    expect(() =>
      loadConfig(
        { WOLF_SESSION_SECRET: SECRET, WOLF_ALLOWED_EMAILS: "*" },
        { readRouteTable: () => undefined },
      ),
    ).toThrow(/WOLF_ALLOWED_EMAILS/);
  });
});
