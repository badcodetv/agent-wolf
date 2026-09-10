/**
 * The Orange conversation, embedded.
 *
 * 🔴 **This is a RAIL, not a block in a document** (UI design § 5). It renders
 * at `height: 100%` and carries NO pixel height of its own; the rail container
 * (`components/ChatRail.tsx`) is what is `position: sticky; top: 0;
 * height: 100vh`. That is the whole reason D4 makes the detail page two
 * columns: a rail's height is the viewport's, and a cross-origin frame's
 * content height cannot be measured from outside — so any pixel height here
 * would be a guess that is wrong at every viewport but the one it was written
 * on.
 *
 * ## The token, and the two units that must not be confused
 *
 * `GET /api/hypotheses/:id/embed-token` answers
 * `{ token, expires_at_sec, embed_url }`, and **`expires_at_sec` is unix
 * SECONDS** — it is the token's own `exp` claim, read back off the signed
 * token by Orange (`go/cmd/agentd/embedtoken.go`). Milliseconds are what
 * `Date.now()` speaks. Multiplying is not optional and it is not cosmetic:
 * reading the value as milliseconds gives a deadline ~55 000 years out (a
 * token that never refreshes and silently dies mid-conversation), and reading
 * `120_000` as seconds gives a token that refreshes on arrival, forever.
 *
 * ## Why a REMOUNT, not just a new `src`
 *
 * The embed page reads its token from the URL fragment once, at load. A
 * cross-origin frame handed a new `src` that differs only after the `#` does
 * not necessarily navigate at all. Changing React's `key` forces a fresh
 * element and a fresh document.
 *
 * ## The token is held in component state and NOWHERE else
 *
 * Not `localStorage`, not `sessionStorage`, not a module-level cache. An
 * Orange embed token carries PROJECT-WIDE authority for its lifetime
 * (`docs/19-embedding.md`, hazard H1); its short TTL is the only bound it has,
 * and persisting it widens the blast radius of any script on this origin from
 * "this render" to "until it expires". The fragment placement is the same
 * rule: a fragment is never sent to a server and never reaches an access log.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Severity from "./trust/Severity.js";
import { ApiError, fetchEmbedToken, sessionNameForHypothesis } from "../api/client.js";
import { orangePublicUrl } from "../env.js";

/** Re-mint this long before expiry. W13's criterion, in milliseconds. */
export const REFRESH_MARGIN_MS = 120_000;

/**
 * The floor on the gap between two mints. A server handing out tokens that are
 * already inside the refresh window must not turn this component into an
 * unthrottled request loop — one that would keep going for as long as the tab
 * is open, against a credential-minting route.
 */
export const MIN_REFRESH_DELAY_MS = 1_000;

/** `setTimeout` truncates to a 32-bit signed int; anything longer fires immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * `${VITE_BOB_PUBLIC_URL}/embed/session/hyp-<id>#token=<token>`.
 *
 * The origin comes from the build variable, never from a literal here and
 * never from the API's own `embed_url`: the browser is what has to reach it,
 * and `BOB_PUBLIC_URL` on the API side is the same origin expressed for a
 * different consumer. (They must agree — see `.env.example`.)
 */
export function embedSrc(hypothesisId: string, token: string): string {
  const session = sessionNameForHypothesis(hypothesisId);
  return `${orangePublicUrl()}/embed/session/${session}#token=${encodeURIComponent(token)}`;
}

/** Milliseconds to wait before re-minting a token expiring at `expiresAtSec` (unix SECONDS). */
export function refreshDelayMs(expiresAtSec: number, nowMs: number): number {
  const deadlineMs = expiresAtSec * 1000 - REFRESH_MARGIN_MS;
  return Math.min(Math.max(deadlineMs - nowMs, MIN_REFRESH_DELAY_MS), MAX_TIMEOUT_MS);
}

interface MintedToken {
  token: string;
  expiresAtSec: number;
  /** Bumped on every mint; it is React's `key`, so a new token remounts the frame. */
  generation: number;
}

export interface BobChatFrameProps {
  /** The BARE 8-hex id. The `hyp-` prefix is added by `sessionNameForHypothesis`, once. */
  hypothesisId: string;
  /** The accessible name of the frame. */
  title?: string;
}

export default function BobChatFrame({
  hypothesisId,
  title = "Agent Wolf interview conversation",
}: BobChatFrameProps) {
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const generation = useRef(0);

  const mint = useCallback(
    async (alive: () => boolean): Promise<number | null> => {
      try {
        const response = await fetchEmbedToken(hypothesisId);
        if (!alive()) return null;
        generation.current += 1;
        setMinted({
          token: response.token,
          expiresAtSec: response.expires_at_sec,
          generation: generation.current,
        });
        setFailure(null);
        return response.expires_at_sec;
      } catch (err) {
        if (!alive()) return null;
        // The server's own sentence, verbatim — "host port pool is exhausted"
        // is operational and actionable, and a flattened "could not load chat"
        // throws away the only useful part.
        setFailure(err instanceof ApiError ? err.message : "could not mint an embed token");
        return null;
      }
    },
    [hypothesisId],
  );

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => mounted;

    const cycle = (): void => {
      void mint(alive).then((expiresAtSec) => {
        if (!mounted || expiresAtSec === null) return;
        timer = setTimeout(cycle, refreshDelayMs(expiresAtSec, Date.now()));
      });
    };
    cycle();

    return () => {
      mounted = false;
      // Nothing survives the unmount: no timer, and no token — `minted` goes
      // with the component, which is the only place it ever lived.
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mint]);

  if (failure !== null) {
    return (
      <Box sx={{ p: 2 }}>
        <Severity level="degraded" cause={`the conversation could not be loaded — ${failure}`} />
      </Box>
    );
  }

  if (minted === null) {
    return (
      <Skeleton
        data-testid="bob-chat-frame-loading"
        variant="rectangular"
        // 100%, not a pixel box: the placeholder must not resize the rail when
        // the real frame replaces it.
        sx={{ width: "100%", height: "100%" }}
      />
    );
  }

  return (
    <iframe
      // The key is the whole refresh mechanism: a new token is a new document.
      key={minted.generation}
      data-testid="bob-chat-frame"
      title={title}
      src={embedSrc(hypothesisId, minted.token)}
      // `height: 100%` and nothing else. No `height` attribute, no min-height
      // in pixels — § 5's rule, and the reason the rail exists.
      style={{ width: "100%", height: "100%", border: "0", display: "block" }}
    />
  );
}
