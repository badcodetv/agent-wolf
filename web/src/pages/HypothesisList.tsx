/**
 * The board — an ATTENTION QUEUE, not a chronological list
 * (`design/2026-08-24-agent-wolf-ui.md` § 4).
 *
 * Four sections, in a fixed order: NEEDS A HUMAN / WATCH / IN INTERVIEW /
 * HOLDING. Membership is `attention_tier`, computed server-side by W27; this
 * page groups and sorts (`board/tiers.ts`) and renders. It does not decide a
 * tier, and there is no chronological fallback — see that module's header.
 *
 * 🔴 **One request.** `GET /api/hypotheses` returns every row with its tier,
 * counts, condition summary and headline already computed. There is no
 * per-card follow-up, and a test with twelve hypotheses asserts exactly one
 * fetch. The API pays two `latest_per` reads for the whole board regardless of
 * hypothesis count; a per-card read would undo that at the only layer that
 * cannot see it.
 *
 * 🔴 **An empty NEEDS A HUMAN section still renders**, with a count of zero.
 * "Nothing needs you" has to be something you can SEE; inferring it from an
 * absent heading is how a board that failed to load looks identical to a board
 * with nothing on it.
 *
 * The heading says "a human", not "you": anyone allowlisted may act on
 * anything, and `owner` is a byline (§ 4, D5).
 */

import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import { Link as RouterLink } from "react-router";
import Severity from "../components/trust/Severity.js";
import ArchiveButton from "../components/ArchiveButton.js";
import HypothesisRow from "../components/HypothesisRow.js";
import { ApiError, fetchBoard } from "../api/client.js";
import type { BoardRow } from "../api/types.js";
import { ATTENTION_TIERS, type AttentionTier } from "../api/types.js";
import { groupByTier, partitionBoard, TIER_HEADINGS, type TieredRow } from "../board/tiers.js";

/** Collapsed by default, § 4. Everything else is expanded. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<AttentionTier> = new Set<AttentionTier>(["holding"]);

/** What an empty section says. NEEDS A HUMAN's is the one that matters. */
const EMPTY_TEXT: Record<AttentionTier, string> = {
  needs_human: "Nothing needs a human right now.",
  watch: "Nothing on watch.",
  in_interview: "No interviews in progress.",
  holding: "Nothing holding.",
};

function Section({
  tier,
  rows,
  onChanged,
}: {
  tier: AttentionTier;
  rows: TieredRow[];
  /** A row archived itself; the board must re-read rather than guess. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(!COLLAPSED_BY_DEFAULT.has(tier));

  return (
    <Box data-testid={`board-section-${tier}`} data-tier={tier} sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <Typography
          data-testid="board-section-heading"
          sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary" }}
        >
          {`${TIER_HEADINGS[tier]}  (${rows.length})`}
        </Typography>
        <Button
          data-testid="board-section-toggle"
          size="small"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${TIER_HEADINGS[tier]}`}
          sx={{ minWidth: 0, px: 0.5, fontSize: 12, lineHeight: 1 }}
        >
          {open ? "▾" : "▸"}
        </Button>
      </Box>

      {!open ? null : rows.length === 0 ? (
        <Typography
          data-testid="board-section-empty"
          sx={{ fontSize: 13, color: "text.secondary", fontStyle: "italic" }}
        >
          {EMPTY_TEXT[tier]}
        </Typography>
      ) : (
        rows.map((tiered) => (
          <Box key={tiered.row.id} data-testid={`board-row-${tiered.row.id}`}>
            {/* The row's own `children` slot — the same one `/archive` uses for
                lineage. `ArchiveButton` renders nothing at all for a status
                whose `→ archived` transition is illegal, so this adds no
                control to a row the server would refuse. */}
            <HypothesisRow row={tiered.row} unclassified={tiered.unclassified}>
              <ArchiveButton
                hypothesisId={tiered.row.id}
                status={tiered.row.status}
                onDone={onChanged}
              />
            </HypothesisRow>
          </Box>
        ))
      )}
    </Box>
  );
}

export default function HypothesisList() {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Reloadable, because a row can now archive itself. The board re-READS
  // rather than dropping the row locally: `attention_tier` and every count on
  // every other row are computed server-side, and a local splice would leave
  // the rest of the board describing a state that no longer exists.
  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await fetchBoard());
      setFailure(null);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "could not read the board");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failure !== null) {
    return <Severity level="degraded" cause={`the board could not be read — ${failure}`} />;
  }
  if (rows === null) {
    return <Skeleton data-testid="board-loading" variant="rectangular" height={200} />;
  }

  // Terminal hypotheses leave the board (§ 3). This is a STATUS filter only —
  // it does not touch, and does not second-guess, `attention_tier`.
  const { active } = partitionBoard(rows);
  const groups = groupByTier(active);

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 2 }}>
        <Button
          data-testid="new-hypothesis-link"
          component={RouterLink}
          to="/new"
          variant="contained"
          size="small"
        >
          + New hypothesis
        </Button>
      </Box>

      {ATTENTION_TIERS.map((tier) => (
        <Section key={tier} tier={tier} rows={groups[tier]} onChanged={() => void load()} />
      ))}
    </Box>
  );
}
