/**
 * W7 — the byte route the `series_fetch` tool points at:
 * `GET /series/download?token=<t>`.
 *
 * design/2026-08-20-agent-wolf.md § W7 (agent-orange repo):
 *
 *   "W7 owns the byte route … mounted on wolf-api OUTSIDE the /api prefix
 *   and outside the session-cookie auth W8 installs — a session container
 *   has no cookie and reaches wolf-api directly at
 *   http://<dind-gateway>:<port>, not through nginx. It is authenticated
 *   SOLELY by the `token` query parameter (a query parameter, not a header:
 *   the agent uses `curl`, and a header would force it to compose one)."
 *
 * Two rules this file exists to enforce:
 *
 *  1. **The route is stateless — the token IS the request.** There is no
 *     server-side blob store: a download re-resolves `(source, id, from,
 *     to)` through W6's connectors + cache and normalises again. Nothing to
 *     reap, and no second copy of the bytes to drift from the first.
 *  2. **The route is not an existence oracle.** Every rejection — wrong
 *     series, expired, tampered payload, missing/malformed token — is the
 *     same 403 with a byte-identical body. A caller learns nothing about
 *     which series exist or why its token failed.
 *
 * Nothing here reads `process.env`: the secret and the resolver are
 * constructor arguments (W7 acceptance criterion).
 *
 * ⚠️ **Never log a download URL.** It carries the token in its query
 * string; the plan states this as a house rule (§ "Pinned technology
 * choices", the logging row). The shared error handler logs `req.path`,
 * which excludes the query string — keep it that way.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { MarketDataAccess, SeriesSource } from "./tools.js";

/** The path the route is mounted at, and the path minted URLs carry. Defined
 * once here so the minter and the router cannot disagree. */
export const SERIES_DOWNLOAD_PATH = "/series/download";

/** Default lifetime of a minted download URL, in seconds. Kept short: the
 * token travels through the model's context and the persisted transcript
 * (§ "The dataset atom" states the same caveat for `dataset_get`). */
export const DEFAULT_SERIES_URL_TTL_SEC = 300;

/** The single 403 body, byte-identical for every rejection reason. */
const FORBIDDEN_BODY = JSON.stringify({ kind: "forbidden", message: "invalid or expired token" });

export interface SeriesTokenPayload {
  source: SeriesSource;
  id: string;
  /** Inclusive start date, `YYYY-MM-DD`. Absent means "the provider's default start". */
  from?: string;
  /** Inclusive end date, `YYYY-MM-DD`. Absent means "the provider's default end". */
  to?: string;
  /** Expiry, unix **seconds** (§ "Shared shapes": encode the unit in every type you write). */
  exp: number;
}

const payloadSchema = z.object({
  source: z.enum(["fred", "stooq"]),
  id: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  exp: z.number().int(),
});

/**
 * Canonical JSON for the signed payload. Written field by field, in a fixed
 * order, and omitting absent optionals entirely — so the same scope always
 * produces the same bytes and therefore the same signature.
 */
function canonicalPayload(payload: SeriesTokenPayload): string {
  const ordered: Record<string, unknown> = { source: payload.source, id: payload.id };
  if (payload.from !== undefined) ordered.from = payload.from;
  if (payload.to !== undefined) ordered.to = payload.to;
  ordered.exp = payload.exp;
  return JSON.stringify(ordered);
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Constant-time string comparison that is also safe for inputs of
 * DIFFERENT lengths: `timingSafeEqual` throws on a length mismatch, and
 * catching that throw would itself be a length oracle, so both sides are
 * hashed to a fixed 32 bytes first.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHmac("sha256", "constant-time-compare").update(a).digest();
  const digestB = createHmac("sha256", "constant-time-compare").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Mints a token scoped to exactly one series and one time window:
 * `base64url(payload).base64url(HMAC-SHA256(payload))`.
 */
export function signSeriesToken(payload: SeriesTokenPayload, secret: string): string {
  const encoded = Buffer.from(canonicalPayload(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded, secret)}`;
}

/**
 * Verifies a token and returns its payload, or `undefined` for ANY failure
 * — bad shape, bad signature, unparseable payload, or expired. The caller
 * must not distinguish these: they all answer with the same 403.
 */
export function verifySeriesToken(
  token: string | undefined,
  secret: string,
  nowSec: number,
): SeriesTokenPayload | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [encoded, signature] = parts as [string, string];
  if (encoded.length === 0 || signature.length === 0) return undefined;
  if (!constantTimeEquals(hmac(encoded, secret), signature)) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) return undefined;
  if (parsed.data.exp <= nowSec) return undefined;
  return parsed.data;
}

/** Builds the absolute URL the `series_fetch` tool returns. */
export function seriesDownloadUrl(origin: string, token: string): string {
  return `${origin}${SERIES_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;
}

export interface SeriesDownloadRouterOptions {
  /** HMAC key. Supplied by the caller (`WOLF_SERIES_TOKEN_SECRET`); never read from the environment here. */
  secret: string;
  /** W6's connectors + cache, behind the resolve seam. */
  access: MarketDataAccess;
  /** Injectable clock in unix SECONDS. Defaults to the real one. */
  nowSec?: () => number;
}

function forbid(res: Response): void {
  res.status(403);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(FORBIDDEN_BODY);
}

/**
 * The router. Registers the FULL path (`/series/download`), so mounting is
 * `app.use(seriesDownloadRouter)` and the path lives in exactly one place.
 */
export function createSeriesDownloadRouter(options: SeriesDownloadRouterOptions): Router {
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const router = Router();

  router.get(SERIES_DOWNLOAD_PATH, (req: Request, res: Response, next: NextFunction) => {
    const raw = req.query.token;
    const token = typeof raw === "string" ? raw : undefined;
    const payload = verifySeriesToken(token, options.secret, nowSec());
    if (!payload) {
      forbid(res);
      return;
    }

    // The token is authoritative for WHAT is served. Explicit query
    // parameters are allowed (a human or a tool may echo them back) but
    // must agree with the token's scope — a token minted for
    // (fred, DGS10) may not fetch (stooq, avav.us).
    const claimed: Record<string, string | undefined> = {
      source: typeof req.query.source === "string" ? req.query.source : undefined,
      id: typeof req.query.id === "string" ? req.query.id : undefined,
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
    };
    const scope: Record<string, string | undefined> = {
      source: payload.source,
      id: payload.id,
      from: payload.from,
      to: payload.to,
    };
    for (const key of Object.keys(claimed)) {
      if (claimed[key] !== undefined && claimed[key] !== scope[key]) {
        forbid(res);
        return;
      }
    }

    void options.access
      .resolve(payload.source, payload.id, payload.from, payload.to)
      .then(({ csv }) => {
        // Literally `text/csv` per the acceptance criterion, plus nosniff so
        // a browser cannot be talked into interpreting the body as anything
        // else. `no-store` because the URL carries a credential.
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        // Sent as a Buffer, not a string: express appends `; charset=utf-8`
        // to a string body's Content-Type, and the acceptance criterion
        // pins the header at exactly `text/csv`.
        res.status(200).send(Buffer.from(csv, "utf8"));
      })
      // An upstream failure is NOT a 403: the caller was authorised, the
      // provider failed. The shared error handler maps the typed kind
      // (`unavailable` → 503 and retryable, `internal` → 500 with no
      // message passed through).
      .catch(next);
  });

  return router;
}
