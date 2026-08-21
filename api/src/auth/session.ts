/**
 * The signed-cookie session: how wolf-api knows who is asking.
 *
 * Wolf holds no server-side session state, so there is no session store and
 * no session library — the pinned mechanism (design/2026-08-20-agent-wolf.md
 * § "Pinned technology choices") is `cookie-parser`'s BUILT-IN signing over
 * `WOLF_SESSION_SECRET`. The cookie carries the signed-in address and the
 * moment it was issued, and nothing else: no privileges, no project, no
 * token. Everything Wolf is allowed to do, it does with its own
 * `WOLF_API_KEY`.
 *
 * ⚠️ **`requireSignedIn` is mounted PER ROUTER, never globally** (R79,
 * promoted to a W8 acceptance criterion on 2026-08-21). W7's `/mcp` and
 * `/series/download` sit deliberately at the app ROOT, outside `/api` and
 * outside any cookie: a session container has no cookie and reaches
 * wolf-api directly at the DinD gateway. `app.use(requireSignedIn)` would
 * 401 the entire market-data surface INSIDE containers — where none of this
 * repo's unit tests look — and X1 is where it would first surface, nine
 * tickets and one container later. `app.test.ts` asserts both routes answer
 * something other than 401 with no cookie, and that `app.ts` contains no
 * unqualified `app.use(requireSignedIn)`.
 */

import type { NextFunction, Request, Response } from "express";
import type { CookieOptions } from "express";
import type { WolfConfig } from "../config.js";
import { WolfError } from "../errors.js";

/** The cookie's name. One name, stated once. */
export const SESSION_COOKIE_NAME = "wolf_session";

/** 12 hours, in milliseconds — `res.cookie`'s `maxAge` unit. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Who is signed in. There is nothing else in a Wolf session. */
export interface SignedInUser {
  /** Lowercased, exactly as it was matched against the allowlist. */
  email: string;
  /** When the cookie was issued (unix ms) — see `isExpired`. */
  issuedAtMs: number;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `requireSignedIn`; absent on every route it does not guard. */
    wolfUser?: SignedInUser;
  }
}

/**
 * The cookie flags, in one place so the route tests and the routes cannot
 * drift apart.
 *
 * `secure` is on everywhere EXCEPT `NODE_ENV === "development"`: a `Secure`
 * cookie is dropped by the browser over plain HTTP, which is what local
 * development is, and everything else — including the compose stack, whose
 * `.env.example` sets `NODE_ENV=production` — is expected to be behind TLS.
 * `SameSite=Lax` (not `None`) because Wolf's own page is the only thing that
 * calls these routes; the Orange chat iframe is a *child* frame and carries
 * its own embed token, never this cookie.
 */
export function sessionCookieOptions(config: WolfConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv !== "development",
    signed: true,
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  };
}

interface CookiePayload {
  email: string;
  iat_ms: number;
}

/** Serialises the payload. `res.cookie` URI-encodes the value, so JSON is safe. */
function encodePayload(user: SignedInUser): string {
  const payload: CookiePayload = { email: user.email, iat_ms: user.issuedAtMs };
  return JSON.stringify(payload);
}

function decodePayload(raw: string): SignedInUser | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const payload = parsed as Partial<CookiePayload>;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  if (typeof payload.iat_ms !== "number" || !Number.isFinite(payload.iat_ms)) return null;
  return { email: payload.email, issuedAtMs: payload.iat_ms };
}

/**
 * The cookie's `maxAge` is enforced by the BROWSER, so a client that simply
 * keeps sending a stale cookie would stay signed in forever — the signature
 * itself never expires. The issue time therefore travels inside the signed
 * value and is checked here, server-side, against the same 12 hours.
 */
export function isExpired(user: SignedInUser, nowMs: number = Date.now()): boolean {
  return nowMs - user.issuedAtMs >= SESSION_MAX_AGE_MS;
}

/**
 * Signs `email` into the `wolf_session` cookie on `res`.
 *
 * ⚠️ **The address is TRIMMED as well as lower-cased, and it is trimmed
 * HERE — once, at the mint site** (**R103**, folded into W9). Every read
 * site takes the address straight out of the cookie: `GET /api/auth/me`,
 * and every route that mounts `requireSignedIn` and reads
 * `req.wolfUser.email` — W9's four human routes, W10's poller and W11's
 * two. An untrimmed address reaches an allowlist comparison and the
 * `owner` label on every memory Wolf writes, and the Kubernetes label
 * value charset (§ "Vocabulary": `^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)
 * forbids spaces — so a leading space presents as *"this user's hypotheses
 * do not appear"*, not as anything auth-shaped. Trimming at three read
 * sites is three chances to forget; trimming at the one place the value
 * enters the system is none.
 */
export function setSessionCookie(
  res: Response,
  email: string,
  config: WolfConfig,
  nowMs: number = Date.now(),
): SignedInUser {
  const user: SignedInUser = { email: email.trim().toLowerCase(), issuedAtMs: nowMs };
  res.cookie(SESSION_COOKIE_NAME, encodePayload(user), sessionCookieOptions(config));
  return user;
}

/** Clears it. Same flags minus `maxAge`, or the browser keeps the old one. */
export function clearSessionCookie(res: Response, config: WolfConfig): void {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions(config);
  res.clearCookie(SESSION_COOKIE_NAME, rest);
}

/**
 * 401, kind `forbidden`. The kind is the taxonomy's (there is no
 * `unauthenticated` kind and adding one is forbidden), and the STATUS is
 * overridden to 401 so "you are not signed in" stays distinguishable from
 * the allowlist's 403 "you are signed in and still not allowed".
 */
export function notSignedInError(reason: string): WolfError {
  return new WolfError("forbidden", `sign in required: ${reason}`, { status: 401 });
}

/**
 * The guard every authenticated Wolf router mounts — W9, W10 and W11 all
 * take it from here. Read the ⚠️ at the top of this file before mounting it
 * anywhere other than on a router.
 */
export function requireSignedIn(req: Request, _res: Response, next: NextFunction): void {
  // cookie-parser puts a *string* here only when the signature verified; a
  // tampered value lands in `req.cookies` and shows up here as `false`.
  const raw: unknown = (req.signedCookies as Record<string, unknown> | undefined)?.[
    SESSION_COOKIE_NAME
  ];
  if (typeof raw !== "string" || raw === "") {
    next(notSignedInError("no valid wolf_session cookie"));
    return;
  }
  const user = decodePayload(raw);
  if (user === null) {
    next(notSignedInError("the wolf_session cookie is not readable"));
    return;
  }
  if (isExpired(user)) {
    // Not cleared here: `requireSignedIn` is a BARE middleware (W9, W10 and
    // W11 mount it by name, not through a factory) and so has no config to
    // build the matching cookie flags from — and a `clearCookie` whose flags
    // do not match the ones the cookie was set with is a no-op anyway. The
    // 401 is what the UI acts on; signing in again overwrites the cookie.
    next(notSignedInError("the session has expired"));
    return;
  }
  req.wolfUser = user;
  next();
}

/**
 * The signed-in user, for a handler that runs BEHIND `requireSignedIn`.
 * Throws `internal` rather than returning null: reaching a guarded handler
 * with no user is a wiring bug in Wolf, not a caller error, and `internal`
 * is the kind that says so without echoing anything to the client.
 */
export function signedInUser(req: Request): SignedInUser {
  const user = req.wolfUser;
  if (user === undefined) {
    throw new WolfError("internal", "handler ran without requireSignedIn in front of it");
  }
  return user;
}

/**
 * The boot-time check for everything the cookie needs, run from `createApp`
 * so an unset variable is a loud one-line boot failure naming it (W7's
 * `createWolfMcp` precedent) rather than a 401 nobody can explain.
 *
 * An EMPTY allowlist is fatal here, deliberately: "unset or empty must not
 * silently mean everyone" is this ticket's first acceptance criterion, and
 * the only way to make that true without breaking
 * `scripts/bootstrap-project.ts` — which calls `loadConfig()` and signs
 * nobody in — is to fail where the sign-in routes are actually mounted.
 */
export function assertSessionConfigured(config: WolfConfig): void {
  if (config.sessionSecret === "") {
    throw WolfError.misconfigured(
      "WOLF_SESSION_SECRET",
      "WOLF_SESSION_SECRET must be set (at least 32 characters) — it signs the wolf_session cookie",
    );
  }
  if (config.allowedEmails.size === 0) {
    throw WolfError.misconfigured(
      "WOLF_ALLOWED_EMAILS",
      "WOLF_ALLOWED_EMAILS must list at least one address — an empty allowlist would mean " +
        "every Google account Orange can verify, which is not what an unset variable means",
    );
  }
  if (config.orangeApiKey === "") {
    throw WolfError.misconfigured(
      "WOLF_API_KEY",
      "WOLF_API_KEY must be set — it is the wolf project's Orange API key, and every route " +
        "wolf-api serves reaches Orange with it",
    );
  }
}

/** Case-insensitive allowlist membership. The set is already lowercased. */
export function isAllowed(email: string, config: WolfConfig): boolean {
  return config.allowedEmails.has(email.trim().toLowerCase());
}
