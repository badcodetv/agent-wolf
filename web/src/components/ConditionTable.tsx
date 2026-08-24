/**
 * The condition table — the part of the page that decides things.
 *
 * `design/2026-08-24-agent-wolf-ui.md` § 5 and the W14 ticket. Per condition
 * it renders the id, the metric, the state, the computed `value`, the
 * `threshold` (with its comparison), the window and `observations_in_window`.
 * It computes NOTHING: W4 did all of the arithmetic and this file renders it.
 *
 * ## The three states, and why `indeterminate` is the point of the file
 *
 * 🔴 **"We could not tell" must never read as "it is fine".** So
 * `indeterminate` is not merely a different label:
 *
 *   - it takes the **warning** colour from `conditionColor()`, where
 *     `holding` is neutral and `tripped` is the accent;
 *   - its row rule is **dashed** (`CONDITION_ROW_RULE_STYLE`), so the state
 *     survives greyscale and colour-blindness;
 *   - it carries a `Severity level="degraded"` marker whose mandatory cause
 *     sentence names W4's `reason` **verbatim**.
 *
 * The word is `indeterminate` throughout. Never "unknown" — a test asserts
 * that string never appears in this component's output.
 *
 * 🔴 `error` red appears nowhere here. A tripped condition is the system
 * working correctly and consequentially; red means something wrote what it had
 * no right to write, and sharing the colour would blunt both (§ 2b).
 *
 * ## Reasons render verbatim, including ones we do not recognise
 *
 * W4's vocabulary is closed (`EVALUATION_REASONS`), and the gloss table below
 * covers it. Anything else — including `stale_series`, which W14's own ticket
 * enumerates and **which W4 does not emit** (the real value is `stale_data`)
 * — is rendered as the raw token with no gloss, because a silently blank
 * reason is how a spec mistake (a percentage statistic on a zero-crossing
 * series) stays invisible for three weeks.
 */

import Box from "@mui/material/Box";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import Severity from "./trust/Severity.js";
import {
  CONDITION_GLYPHS,
  CONDITION_ROW_RULE_STYLE,
  conditionColor,
  type ConditionState as ThemeConditionState,
} from "../theme.js";
import { formatNumber, formatUtcWindow } from "../format.js";
import { indeterminateCause } from "../reasons.js";
import { isConditionState, type ConditionResult } from "../api/types.js";

/** The comparison, as a symbol. The reader is looking at `value <op> threshold`. */
export const OP_SYMBOLS: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

/** The state as the theme knows it; anything else is rendered verbatim and treated as indeterminate-ish. */
function themeState(state: string): ThemeConditionState | null {
  return isConditionState(state) ? state : null;
}

export interface ConditionTableProps {
  conditions: readonly ConditionResult[];
  /**
   * The condition's STATISTIC, which lives on the spec and not on the
   * evaluation (`api/src/hypothesis/spec.ts`'s `Condition.stat`). Supplied by
   * the page, which holds the spec; absent when there is no readable spec.
   */
  statFor?: (conditionId: string) => string | undefined;
  /** Shown instead of the table when there are no rows. */
  emptyMessage?: string;
  /** Distinguishes the two instances on the detail page (the case, and the full table). */
  testId?: string;
}

export default function ConditionTable({
  conditions,
  statFor,
  emptyMessage = "no conditions have been evaluated yet",
  testId = "condition-table",
}: ConditionTableProps) {
  const theme = useTheme();
  const rows = Array.isArray(conditions) ? conditions : [];

  if (rows.length === 0) {
    return (
      <Typography data-testid={`${testId}-empty`} sx={{ fontSize: 13, color: "text.secondary" }}>
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <Table data-testid={testId} size="small" sx={{ tableLayout: "auto" }}>
      <TableHead>
        <TableRow>
          <TableCell>condition</TableCell>
          <TableCell>metric</TableCell>
          <TableCell>statistic</TableCell>
          <TableCell>state</TableCell>
          <TableCell align="right">value</TableCell>
          <TableCell align="right">threshold</TableCell>
          <TableCell>window</TableCell>
          <TableCell align="right">observations</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((c) => {
          const known = themeState(String(c.state));
          // An unrecognised state gets the warning treatment rather than the
          // neutral one: a state Wolf does not know about is the last thing
          // that should read as `holding`.
          const colour = conditionColor(theme, known ?? "indeterminate");
          const glyph = known === null ? "?" : CONDITION_GLYPHS[known];
          const ruleStyle = known === null ? "dashed" : CONDITION_ROW_RULE_STYLE[known];
          const op = OP_SYMBOLS[String(c.op)] ?? String(c.op);
          const stat = statFor?.(c.id);
          return (
            <TableRow
              key={c.id}
              data-testid={`${testId}-row`}
              data-condition-id={c.id}
              data-condition-state={String(c.state)}
              data-rule-style={ruleStyle}
              sx={{
                "& td": { borderBottomStyle: ruleStyle },
              }}
            >
              <TableCell>
                <Typography variant="mono" sx={{ fontSize: 12 }}>
                  {c.id}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="mono" sx={{ fontSize: 12 }}>
                  {c.metric}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="mono" sx={{ fontSize: 12, color: "text.secondary" }}>
                  {stat ?? "—"}
                </Typography>
              </TableCell>
              <TableCell>
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, color: colour }}>
                  <Box component="span" aria-hidden sx={{ fontSize: 13, lineHeight: 1 }}>
                    {glyph}
                  </Box>
                  <Typography component="span" sx={{ fontSize: 13, color: colour }}>
                    {String(c.state)}
                  </Typography>
                </Box>
                {known === "indeterminate" || known === null ? (
                  <Box sx={{ mt: 0.5 }}>
                    <Severity level="degraded" cause={indeterminateCause(c.reason)} />
                  </Box>
                ) : null}
              </TableCell>
              <TableCell align="right">
                <Typography variant="mono" sx={{ fontSize: 12 }}>
                  {formatNumber(c.value)}
                </Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="mono" sx={{ fontSize: 12 }}>
                  {`${op} ${formatNumber(c.threshold)}`}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="mono" sx={{ fontSize: 12, color: "text.secondary" }}>
                  {formatUtcWindow(c.window_start_ms, c.window_end_ms)}
                </Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="mono" sx={{ fontSize: 12 }}>
                  {formatNumber(c.observations_in_window, 0)}
                </Typography>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
