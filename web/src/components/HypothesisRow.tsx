/**
 * One row of the attention queue (UI design § 4) — also reused by `/archive`.
 *
 * § 2b principle 4 is "density over air": this is a table row at
 * `BOARD_ROW_HEIGHT_PX`, not a card in a gallery. Two lines: the identity line
 * (title, owner byline, chip, score, condition summary, counts) and the
 * evidence line (the report headline, or the fact that there is not one).
 *
 * What this row deliberately does NOT do:
 *
 *   - **It never colours a number by which way it moved** (§ 2b principle 2).
 *     A hypothesis that predicted a fall is *succeeding* when the line goes
 *     down, so green-up/red-down is not merely a style choice here, it is
 *     backwards. The score is neutral, monospaced and tabular, and it is
 *     labelled a SUMMARY that decides nothing — only conditions do.
 *   - **It never renders a count it was not given.** `attention_count` and
 *     `stale_count` are optional, and absent stays absent: defaulting either
 *     to `0` would print a confident "0 stale" for a server that never
 *     computed staleness at all.
 *   - **It never claims a truncated title is complete.** `title_truncated`
 *     means the 500-byte snippet cut line 1, so the row shows an ellipsis
 *     affordance and says so on hover.
 */

import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import Link from "@mui/material/Link";
import StatusChip from "./StatusChip.js";
import TamperWarning from "./TamperWarning.js";
import {
  BOARD_ROW_FONT_SIZE_PX,
  BOARD_ROW_HEIGHT_PX,
  CONDITION_GLYPHS,
  conditionColor,
} from "../theme.js";
import type { BoardRow, ConditionsSummary } from "../api/types.js";
import { UNCLASSIFIED_CAPTION } from "../board/tiers.js";

/** `headline === null`: W22 found no `kind=report` memory at all. */
export const NO_REPORT_YET = "no report yet";

/**
 * `headline === ""`: there IS a report and its first line is empty. A
 * different fact from "no report yet", and § "Shared shapes" keeps the two
 * distinguishable on the wire precisely so the UI does not merge them.
 */
export const EMPTY_HEADLINE = "the newest report's first line is empty";

/** The title of a hypothesis whose trusted state row did not survive. */
export const NO_TITLE = "(no title — no trusted state row)";

/** A signed, fixed-precision score. Neutral: no colour, ever. */
export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  const sign = score > 0 ? "+" : score < 0 ? "−" : "";
  return `${sign}${Math.abs(score).toFixed(2)}`;
}

function ConditionSummary({ summary }: { summary: ConditionsSummary }) {
  const parts: Array<["tripped" | "holding" | "indeterminate", number, string]> = [
    ["tripped", summary.tripped, "tripped"],
    ["holding", summary.holding, "holding"],
    ["indeterminate", summary.indeterminate, "indeterminate"],
  ];
  return (
    <Box
      data-testid="conditions-summary"
      sx={{ display: "flex", gap: 1, alignItems: "baseline" }}
    >
      {parts.map(([state, count, word]) => (
        <Tooltip key={state} title={`${count} ${word}`}>
          <Typography
            variant="mono"
            aria-label={`${count} ${word}`}
            sx={(theme) => ({ fontSize: 12, color: conditionColor(theme, state) })}
          >
            {/* Never colour-alone: the glyph carries the state too (§ 2b). */}
            {CONDITION_GLYPHS[state]}
            {count}
          </Typography>
        </Tooltip>
      ))}
    </Box>
  );
}

export interface HypothesisRowProps {
  row: BoardRow;
  /** True when the SERVER did not tier this row; the caption below says so. */
  unclassified?: boolean;
  /** Extra content under the evidence line — `/archive` puts lineage here. */
  children?: ReactNode;
}

export default function HypothesisRow({ row, unclassified = false, children }: HypothesisRowProps) {
  const title = row.title === null || row.title === "" ? NO_TITLE : row.title;
  const headline =
    row.headline === undefined || row.headline === null
      ? NO_REPORT_YET
      : row.headline === ""
        ? EMPTY_HEADLINE
        : row.headline;
  const headlineMissing = row.headline === undefined || row.headline === null || row.headline === "";

  return (
    <Box
      data-testid="hypothesis-row"
      data-hypothesis-id={row.id}
      sx={(theme) => ({
        py: 0.5,
        borderBottom: `1px solid ${theme.palette.divider}`,
        fontSize: BOARD_ROW_FONT_SIZE_PX,
      })}
    >
      <Box
        sx={{
          minHeight: BOARD_ROW_HEIGHT_PX,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Link
          component={RouterLink}
          to={`/hypotheses/${row.id}`}
          underline="hover"
          sx={{ fontSize: BOARD_ROW_FONT_SIZE_PX, fontWeight: 600, flex: "1 1 240px", minWidth: 0 }}
        >
          {title}
          {row.title_truncated ? (
            <Tooltip title="the stored title is longer than this — the board reads a 500-byte snippet">
              <Box
                component="span"
                data-testid="title-truncated"
                aria-label="title truncated"
                sx={{ color: "text.secondary" }}
              >
                {" …"}
              </Box>
            </Tooltip>
          ) : null}
        </Link>

        {/* `owner` is a BYLINE, not an assignment: anyone allowlisted may act. */}
        <Typography
          data-testid="owner-byline"
          variant="mono"
          sx={{ fontSize: 12, color: "text.secondary" }}
        >
          {row.owner ?? "—"}
        </Typography>

        <StatusChip status={row.status} />

        <Tooltip title="support score — a SUMMARY. It decides nothing; only conditions do.">
          <Typography
            data-testid="support-score"
            variant="mono"
            aria-label={`support score ${formatScore(row.support_score)} — a summary, it decides nothing`}
            sx={{ fontSize: 12, minWidth: 48, textAlign: "right" }}
          >
            {formatScore(row.support_score)}
          </Typography>
        </Tooltip>

        {row.conditions_summary !== null && row.conditions_summary !== undefined ? (
          <ConditionSummary summary={row.conditions_summary} />
        ) : null}

        {/* Absent stays absent. Rendered only when the server sent a count. */}
        {typeof row.attention_count === "number" && row.attention_count > 0 ? (
          <Typography
            data-testid="attention-count"
            variant="mono"
            sx={{ fontSize: 12, color: "warning.main" }}
          >
            {`${row.attention_count} attention`}
          </Typography>
        ) : null}
        {typeof row.stale_count === "number" && row.stale_count > 0 ? (
          <Typography
            data-testid="stale-count"
            variant="mono"
            sx={{ fontSize: 12, color: "warning.main" }}
          >
            {`${row.stale_count} stale`}
          </Typography>
        ) : null}
      </Box>

      <Typography
        data-testid="headline"
        data-headline-state={
          row.headline === undefined || row.headline === null
            ? "absent"
            : row.headline === ""
              ? "empty"
              : "present"
        }
        sx={{
          fontSize: 12,
          color: headlineMissing ? "text.secondary" : "text.primary",
          fontStyle: headlineMissing ? "italic" : "normal",
        }}
      >
        {headline}
      </Typography>

      {unclassified ? (
        <Typography
          data-testid="unclassified-caption"
          sx={{ fontSize: 12, color: "text.secondary" }}
        >
          {UNCLASSIFIED_CAPTION}
        </Typography>
      ) : null}

      {(row.tamper ?? []).map((tamper) => (
        <Box key={`${tamper.reason}:${tamper.memory_id}`} sx={{ mt: 0.5 }}>
          <TamperWarning tamper={tamper} />
        </Box>
      ))}

      {children}
    </Box>
  );
}
