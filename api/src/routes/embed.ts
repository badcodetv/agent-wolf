/**
 * The embed-token route — one of the two places Wolf hands the browser
 * something that came from Bob (design/2026-08-20-agent-wolf.md, W11).
 *
 *   GET /api/hypotheses/:id/embed-token
 *     → 200 { token, expires_at_sec, embed_url }
 *     → 401 with no `wolf_session` cookie, and NO upstream request at all
 *     → 404 not_found when this hypothesis has no `hyp-<id>` session
 *
 * ## The three things here that are correctness, not style
 *
 * 1. **No `ttl_seconds` is sent, ever.** Bob's `clampEmbedTTL`
 *    (`go/cmd/agentd/embedtoken.go`) reads absent-or-zero as its own 900s
 *    default and clamps anything else into `[60, 3600]`. Hazard H1 of
 *    `docs/19-embedding.md` is that an embed token carries PROJECT-WIDE
 *    authority for its lifetime — its confinement to one session id is
 *    enforced only on session-by-id routes — so the TTL is the only bound
 *    this credential has, and asking for the 3600s ceiling would quadruple
 *    the blast radius of a leaked fragment for no gain. `client.createEmbedToken`
 *    omits the key entirely when no TTL is passed; `embed.test.ts` asserts the
 *    outbound body has no `ttl_seconds` key at all.
 *
 * 2. **`expires_at_sec` is unix SECONDS**, because that is the token's own
 *    `exp` claim, read back off the signed token by Bob rather than
 *    recomputed. W13 subtracts 120 from it to schedule a refresh; the unit is
 *    in the name because subtracting 120 from milliseconds gives a token that
 *    never refreshes, and 120 000 from seconds one that refreshes instantly —
 *    and neither ticket's own tests would see it.
 *
 * 3. **The token is returned in the BODY and the fragment is the client's
 *    job.** This route never builds `…#token=…` and never logs the token. A
 *    URL fragment is not sent to the server and does not reach an access log;
 *    a token this route had concatenated into a URL would land in every
 *    `pino` line, every proxy log and every error report that echoes a URL.
 *    `embed.test.ts` captures the real pino stream and asserts that neither
 *    the token nor `WOLF_API_KEY` appears in any line it wrote.
 */

import { Router, type Request, type Response } from "express";

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { WolfConfig } from "../config.js";
import type { BobClient } from "../bob/client.js";
import type { UnixSec } from "../bob/types.js";
import { requireSignedIn } from "../auth/session.js";
import { HYPOTHESIS_ID_PATTERN, sessionNameForHypothesis } from "../hypothesis/store.js";

/** What the browser gets. `expires_at_sec` is unix SECONDS (see the header). */
export interface EmbedTokenResponse {
  token: string;
  expires_at_sec: UnixSec;
  /** `${BOB_PUBLIC_URL}/embed/session/hyp-<id>` — no fragment. */
  embed_url: string;
}

/**
 * The embed page's URL for one hypothesis.
 *
 * Exported so `web/` can be tested against the same function that builds what
 * it renders, and so the `hyp-` prefix keeps coming from exactly one place
 * (`sessionNameForHypothesis`) rather than being re-spelled here — the
 * `hyp-hyp-…` bug § Vocabulary warns about is born from a second spelling.
 *
 * `publicUrl` arrives with its trailing slashes already trimmed by
 * `loadConfig`, so this is a plain concatenation and not a `new URL()` join
 * (which would silently drop a path prefix on a base like
 * `https://example.test/bob`).
 */
export function embedUrlFor(publicUrl: string, id: string): string {
  return `${publicUrl}/embed/session/${sessionNameForHypothesis(id)}`;
}

export interface CreateEmbedRouterOptions {
  client: BobClient;
  config: WolfConfig;
  logger: Logger;
}

export function createEmbedRouter(options: CreateEmbedRouterOptions): Router {
  const { client, config, logger } = options;
  const router = Router();

  // `requireSignedIn` PER ROUTE, not `app.use` and not even a path-prefixed
  // `router.use` (R79): W7's `/mcp` and `/series/download` sit at the app root
  // precisely because a session container has no cookie, and a guard mounted
  // any wider than the route it protects is how they get 401ed somewhere no
  // unit test looks. Placed BEFORE the handler, so a caller with no cookie is
  // refused before a single byte goes to Bob — `embed.test.ts` asserts the
  // upstream recorded zero requests.
  router.get(
    "/api/hypotheses/:id/embed-token",
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        const sessionName = sessionNameForHypothesis(id);

        // No TTL argument: Bob's own 900s default is the one we want, and
        // the client omits the key entirely when none is passed. A 404 here —
        // absent session, malformed name, or a name belonging to another
        // project, which Bob deliberately does not distinguish — becomes a
        // `not_found` WolfError through the client's standard status mapping.
        // This route is therefore not an existence oracle, and does not try
        // to be one.
        const { token, expiresAtSec } = await client.createEmbedToken(sessionName);

        // The id and the EXPIRY are loggable; the token is not. Note there is
        // no `token`, no `embed_url` and no key in this object — the whole
        // credential-handling rule of this ticket is one line of code and it
        // is this one.
        logger.info({ id, session: sessionName, expiresAtSec }, "embed token minted");

        const body: EmbedTokenResponse = {
          token,
          expires_at_sec: expiresAtSec,
          embed_url: embedUrlFor(config.bobPublicUrl, id),
        };
        res.status(200).json(body);
      })().catch(next);
    },
  );

  return router;
}

/**
 * The bare 8-hex id, or an `invalid` error.
 *
 * Re-stated here rather than imported from `routes/hypotheses.ts`, whose own
 * copy is deliberately private and whose file this ticket does not own — and
 * EXPORTED so `series.ts`, the other route W11 adds, uses this one rather
 * than growing a third spelling of the same rule. `hyp-` belongs to the
 * session NAME and nothing else (§ Vocabulary): a `hyp-`-prefixed value
 * arriving here is the `hyp-hyp-…` bug being born, and it would travel
 * straight into a memory selector and a dataset name.
 */
export function requireHypothesisId(raw: unknown): string {
  const id = (typeof raw === "string" ? raw : "").trim();
  if (!HYPOTHESIS_ID_PATTERN.test(id)) {
    throw new WolfError("invalid", "not a hypothesis id (expected 8 lowercase hex characters)", {
      details: { id: typeof raw === "string" ? raw : null },
    });
  }
  return id;
}
