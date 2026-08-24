/**
 * `/archive` — the terminal states (`confirmed`, `invalidated`, `archived`).
 * They leave the board (§ 3) and live here, with their LINEAGE.
 *
 * ## Why this page makes N+1 requests, and the board does not
 *
 * "A hypothesis that needs to run again is a new one, carrying
 * `restated_from`" (`api/src/hypothesis/lifecycle.ts`). Without that link an
 * archive-and-relaunch reads as a fresh thesis, which is exactly the
 * self-deception this product exists to prevent — so the criterion is that the
 * lineage is SHOWN when the label is present.
 *
 * 🔴 **`restated_from` is not on the board payload.** `BoardRow`
 * (`api/src/routes/hypotheses.ts`) carries `id, title, title_truncated, owner,
 * status, support_score, conditions_summary, updated_at_ms, tamper?`; the
 * label reaches the browser only on `HypothesisDetailRow`. So this page reads
 * the board once and then reads the detail of each TERMINAL row — a small,
 * bounded set that grows by roughly one hypothesis per conclusion, not per
 * day.
 *
 * The board's own "exactly one fetch" criterion is untouched: it is about
 * `HypothesisList`, and nothing here runs on that page. If a later ticket adds
 * `restated_from` to `BoardRow` — a one-line change on a record the API
 * already holds — this whole second pass collapses into reading a field. It is
 * logged as a discovered issue rather than fixed here, because W13 does not
 * own `api/`.
 */

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import { Link as RouterLink } from "react-router";
import Link from "@mui/material/Link";
import Severity from "../components/trust/Severity.js";
import HypothesisRow from "../components/HypothesisRow.js";
import { ApiError, fetchBoard, fetchHypothesis } from "../api/client.js";
import type { BoardRow } from "../api/types.js";
import { partitionBoard } from "../board/tiers.js";

/** `id -> restated_from`, or `null` when this one was not a restatement. */
type Lineage = Record<string, string | null>;

export default function Archive() {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [lineage, setLineage] = useState<Lineage>({});
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      let terminal: BoardRow[];
      try {
        const board = await fetchBoard();
        if (!mounted) return;
        terminal = partitionBoard(board).terminal;
        setRows(terminal);
      } catch (err) {
        if (mounted) setFailure(err instanceof ApiError ? err.message : "could not read the archive");
        return;
      }

      // One detail read per terminal row, purely for `restated_from`. A row
      // whose read fails is rendered WITHOUT lineage rather than not rendered:
      // losing the row would be a worse lie than losing the link.
      const entries = await Promise.all(
        terminal.map(async (row): Promise<[string, string | null]> => {
          try {
            const detail = await fetchHypothesis(row.id);
            return [row.id, detail.hypothesis.restated_from];
          } catch {
            return [row.id, null];
          }
        }),
      );
      if (mounted) setLineage(Object.fromEntries(entries));
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (failure !== null) {
    return <Severity level="degraded" cause={`the archive could not be read — ${failure}`} />;
  }
  if (rows === null) {
    return <Skeleton data-testid="archive-loading" variant="rectangular" height={200} />;
  }

  return (
    <Box>
      <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary", mb: 1 }}>
        {`ARCHIVE  (${rows.length})`}
      </Typography>

      {rows.length === 0 ? (
        <Typography data-testid="archive-empty" sx={{ fontSize: 13, color: "text.secondary", fontStyle: "italic" }}>
          Nothing has concluded yet.
        </Typography>
      ) : (
        rows.map((row) => {
          const from = lineage[row.id] ?? null;
          return (
            <Box key={row.id} data-testid={`archive-row-${row.id}`}>
              <HypothesisRow row={row}>
                {from !== null && from !== "" ? (
                  <Typography data-testid="restated-from" sx={{ fontSize: 12, color: "text.secondary" }}>
                    {"restated from "}
                    <Link component={RouterLink} to={`/hypotheses/${from}`} underline="hover">
                      {from}
                    </Link>
                  </Typography>
                ) : null}
              </HypothesisRow>
            </Box>
          );
        })
      )}
    </Box>
  );
}
