/**
 * Sign-in. Two routes, both mounted under the LITERAL `/api` prefix (R37 —
 * nothing rewrites it: nginx's `/api/` location and vite's `/api` proxy both
 * forward the full path).
 *
 *   POST /api/auth/google      { credential } → 200 { email } + wolf_session
 *   POST /api/auth/dev-login   { email, password } → the same, and mounted
 *                              ONLY when WOLF_TEST_LOGIN is set (owner
 *                              decision B6; X1 signs in through it because
 *                              Playwright cannot obtain a real Google ID
 *                              token offline).
 *   GET  /api/auth/me          → 200 { email } for the signed-in caller,
 *                              401 otherwise. Owner decision 2026-08-21
 *                              (R100, ticket W8b): W8 shipped the cookie and
 *                              the guard but no way for the UI to ask "am I
 *                              signed in, and as whom?".
 *   POST /api/auth/logout      → 204, always, clearing wolf_session.
 *                              **POST, never GET** — a GET logout is
 *                              triggerable by a prefetch, an `<img>` tag or a
 *                              link inside a report panel, and this product
 *                              renders model-authored HTML in an iframe, so a
 *                              cross-site sign-out is a real reachable attack
 *                              here. Succeeds (204) even with no cookie:
 *                              signing out when already signed out is not an
 *                              error, and a 401 here would make the UI's
 *                              sign-out button fail exactly when a user most
 *                              wants it to work — an expired session.
 *
 * ⚠️ **Bob verifying a credential is necessary, never sufficient.**
 * `POST /auth/verify-google` is an identity oracle and nothing more: it
 * mints no token, grants no project and knows nothing about Wolf's users
 * (`go/cmd/agentd/googleauth.go`, `verifyResponse`'s doc comment). The
 * allowlist below is what decides, and a verified identity that is not on it
 * is **403 `forbidden`** — distinct from the 401 `requireSignedIn` answers a
 * request carrying no cookie at all.
 */

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { WolfConfig } from "../config.js";
import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BobClient } from "../bob/client.js";
import {
  clearSessionCookie,
  isAllowed,
  notSignedInError,
  requireSignedIn,
  setSessionCookie,
  signedInUser,
} from "../auth/session.js";

export interface CreateAuthRouterOptions {
  client: BobClient;
  config: WolfConfig;
  logger: Logger;
  /** Injectable clock, so a test can prove the cookie's issue time. */
  now?: () => number;
}

const googleBody = z.object({ credential: z.string().min(1) });
const devLoginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new WolfError("invalid", `${what} is not a valid request body`, {
      details: {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

/**
 * Maps the three answers `POST /auth/verify-google` gives, plus the one the
 * plan's criteria do not name.
 *
 *   200 → continue.
 *   401 → `forbidden` ("invalid credential"). Bob answers 401 for every
 *         rejection — bad signature, wrong audience, unverified address —
 *         deliberately, so it must not be reported as anything finer.
 *   404 → **`misconfigured` naming `GOOGLE_CLIENT_ID`**: `registerVerifyGoogle`
 *         mounts nothing when that variable is unset ON BOB, and a
 *         configuration hole must not read as a rejected user. The Bob
 *         client already maps this one (W2), so it arrives here as
 *         `misconfigured` and is rethrown untouched.
 *   403 → the route is API-key-only (`authenticatedByAPIKey`), so a 403 means
 *         WOLF_API_KEY is not a project API key. That is Wolf's own
 *         misconfiguration, not the user's, and reporting it as `forbidden`
 *         would blame the person signing in.
 */
function classifyVerifyFailure(err: unknown): never {
  if (err instanceof WolfError) {
    if (err.kind === "misconfigured") throw err;
    if (err.status === 401) {
      throw new WolfError("forbidden", "invalid credential");
    }
    if (err.status === 403) {
      throw WolfError.misconfigured(
        "WOLF_API_KEY",
        "WOLF_API_KEY: Bob refused wolf-api's credential on POST /auth/verify-google — " +
          "that route answers only to a project API key (X-API-Key)",
      );
    }
  }
  throw err;
}

/** Constant-time string compare that does not leak length through timing. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createAuthRouter(options: CreateAuthRouterOptions): Router {
  const { client, config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const router = Router();

  // NOTE: no `requireSignedIn` on this router — signing in is how the cookie
  // comes to exist. Every OTHER Wolf router mounts the guard itself (R79).
  router.post("/api/auth/google", async (req: Request, res: Response) => {
    const { credential } = parseBody(googleBody, req.body, "POST /api/auth/google");

    let identity;
    try {
      identity = await client.verifyGoogle(credential);
    } catch (err) {
      classifyVerifyFailure(err);
    }

    // Bob only ever returns `email_verified: true` on a 200 today. Checked
    // anyway: the field exists so a caller reads the fact rather than knowing
    // the rule, and a future Bob that relaxes it must not silently sign
    // somebody in here.
    if (!identity.emailVerified || identity.email === "") {
      throw new WolfError("forbidden", "invalid credential");
    }
    if (!isAllowed(identity.email, config)) {
      // Logged at warn with the address: a refused sign-in is the one thing an
      // operator will be asked about, and the address is not a secret.
      logger.warn({ email: identity.email }, "sign-in refused: not on WOLF_ALLOWED_EMAILS");
      throw new WolfError("forbidden", "this account is not allowed to use Agent Wolf");
    }

    const user = setSessionCookie(res, identity.email, config, now());
    logger.info({ email: user.email }, "signed in");
    res.status(200).json({ email: user.email });
  });

  const testLogin = config.testLogin;
  if (testLogin !== null) {
    // Owner decision B6. Mounted only when WOLF_TEST_LOGIN is set, and
    // `loadConfig` refuses that variable outright when NODE_ENV=production —
    // so this route cannot exist in a production build, which `auth.test.ts`
    // asserts by 404 rather than by reading the source.
    logger.warn(
      { route: "/api/auth/dev-login" },
      "WOLF_TEST_LOGIN is set: mounting the test-only login, which verifies no Google credential",
    );
    router.post("/api/auth/dev-login", (req: Request, res: Response) => {
      const body = parseBody(devLoginBody, req.body, "POST /api/auth/dev-login");
      const email = body.email.trim().toLowerCase();
      // Both halves must match, and the allowlist still applies: the test
      // login is a way to skip GOOGLE, not a way to skip the allowlist.
      if (!secretEquals(email, testLogin.email) || !secretEquals(body.password, testLogin.password)) {
        throw new WolfError("forbidden", "invalid test credentials");
      }
      if (!isAllowed(email, config)) {
        throw new WolfError("forbidden", "this account is not allowed to use Agent Wolf");
      }
      const user = setSessionCookie(res, email, config, now());
      res.status(200).json({ email: user.email });
    });
  }

  // GET /api/auth/me — mounted behind `requireSignedIn` on this one route,
  // never globally (R79): the four "no cookie at all" refusals (missing,
  // unsigned, wrong secret, expired) come from the guard for free, in the
  // exact same shape every other guarded route answers with. The guard
  // alone does not know about the allowlist, though — it only proves the
  // cookie is validly signed and unexpired — so a fifth case, an email that
  // was removed from WOLF_ALLOWED_EMAILS after the cookie was issued, is
  // checked here and reported through the SAME `notSignedInError` helper
  // the guard itself uses, so it is not a second error shape.
  router.get("/api/auth/me", requireSignedIn, (req: Request, res: Response) => {
    const user = signedInUser(req);
    // Normalised the same way the rest of W8 normalises an email (see
    // `devLoginBody` above and `isAllowed`'s own trim): trimmed, then
    // lower-cased. `setSessionCookie` already lower-cases on the way in but
    // does not trim, so this is not redundant — it is what makes the
    // response trustworthy without asking `web/` to normalise anything.
    const email = user.email.trim().toLowerCase();
    if (!isAllowed(email, config)) {
      throw notSignedInError("this account is no longer on WOLF_ALLOWED_EMAILS");
    }
    res.status(200).json({ email });
  });

  // POST /api/auth/logout — deliberately NOT behind `requireSignedIn`:
  // signing out with no cookie, or an already-invalid one, is success (204),
  // not a 401. Clears with the exact same cookie name/path/SameSite/Secure
  // attributes it was minted with (`clearSessionCookie` shares
  // `sessionCookieOptions` with `setSessionCookie` for this reason) — a
  // Set-Cookie that differs in any attribute does not reliably clear the
  // original, and the browser treats it as a different cookie.
  router.post("/api/auth/logout", (_req: Request, res: Response) => {
    clearSessionCookie(res, config);
    res.status(204).send();
  });

  return router;
}
