/**
 * The band that leads the detail page's left column — § 5's first block.
 *
 * It says four things and decides none of them: the lifecycle state, the
 * support score, how the conditions currently stand, and — in words — that the
 * score is a summary rather than a verdict.
 *
 * 🔴 **It is NOT `VerdictActions`.** W14's Confirm/Invalidate buttons are a
 * separate component that exists only in `challenged`, and this band composes
 * *above* them. Folding the buttons in here would put the "buttons only in
 * `challenged`" rule in two places, and W14's test targets the other one.
 *
 * 🔴 **`indeterminate` is never `holding`.** Three affordances, the same three
 * the condition table uses and read from the same theme tables: the **warning**
 * colour where `holding` is neutral and `tripped` is the accent, the `△` glyph,
 * and a **dashed** rule so the state survives greyscale and colour-blindness.
 * The word is `indeterminate` throughout — never "unknown", which invites a
 * reader to assume it is fine when what it means is that Wolf's own arithmetic
 * could not tell.
 *
 * 🔴 **No colour by movement, and no error red at all.** A negative score is
 * not "bad" — a thesis predicting a fall is *succeeding* when the line drops —
 * so the figure takes the ordinary text colour whatever its sign, stated
 * rather than left off so a later edit has to argue with the line. And red
 * means exactly one thing in this product: something wrote what it had no
 * right to write. A tripped condition is the system working correctly, so it
 * takes the accent.
 *
 * ## Counting
 *
 * The counts are a tally of rows W4 already decided, not a second evaluation:
 * the band computes no state, it groups them. A state outside the closed set
 * is counted as `indeterminate` rather than dropped — the same treatment the
 * condition table gives it, and the alternative is three figures that add up
 * to fewer conditions than the table below shows.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import {
  CONDITION_GLYPHS,
  CONDITION_ROW_RULE_STYLE,
  conditionColor,
  type ConditionState as ThemeConditionState,
} from "../theme.js";
import { NEVER_EVALUATED, SUPPORT_SCORE_NOTE } from "./Scoreboard.js";
import { NO_STATE_LABEL } from "./StatusChip.js";
import { ABSENT } from "../format.js";
import { isConditionState, type ConditionResult, type EvaluationResult } from "../api/types.js";

/** The three, in the order § 5 reads them: what tripped, what holds, what we could not tell. */
export const BAND_STATES: readonly ThemeConditionState[] = ["tripped", "holding", "indeterminate"];

export interface ConditionCounts {
  tripped: number;
  holding: number;
  indeterminate: number;
}

/**
 * Tally the rows by state.
 *
 * A state the closed set does not contain lands in `indeterminate`: "we could
 * not tell" is what an unrecognised state means, and a silently dropped row
 * makes the figures disagree with the table.
 */
export function countConditions(conditions: unknown): ConditionCounts {
  const counts: ConditionCounts = { tripped: 0, holding: 0, indeterminate: 0 };
  if (!Array.isArray(conditions)) return counts;
  for (const row of conditions as ConditionResult[]) {
    const state = isConditionState(row?.state) ? row.state : "indeterminate";
    counts[state] += 1;
  }
  return counts;
}

export interface VerdictBandProps {
  /** The lifecycle state from the trusted `hypothesis` memory. */
  status: string | null | undefined;
  /** W4's snapshot. `null` = never evaluated, which is day one for every hypothesis. */
  evaluation?: EvaluationResult | null;
}

export default function VerdictBand({ status, evaluation }: VerdictBandProps) {
  const theme = useTheme();
  const counts = countConditions(evaluation?.conditions);
  const score =
    evaluation != null && typeof evaluation.support_score === "number"
      ? evaluation.support_score
      : null;
  const label = typeof status === "string" && status !== "" ? status : NO_STATE_LABEL;

  return (
    <Box data-testid="verdict-band" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1.5, flexWrap: "wrap" }}>
        <Typography
          data-testid="verdict-band-status"
          variant="mono"
          sx={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </Typography>

        <Typography
          data-testid="verdict-band-score"
          variant="mono"
          // The ordinary text colour, whatever the sign. See the file header.
          sx={{ fontSize: 20, fontWeight: 700, color: "text.primary" }}
        >
          {score === null ? ABSENT : score.toFixed(2)}
        </Typography>
        <Typography data-testid="verdict-band-note" sx={{ fontSize: 13, color: "text.secondary" }}>
          {SUPPORT_SCORE_NOTE}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", alignItems: "baseline", gap: 2, flexWrap: "wrap" }}>
        {BAND_STATES.map((state) => (
          <Typography
            key={state}
            data-testid={`verdict-band-count-${state}`}
            data-rule-style={CONDITION_ROW_RULE_STYLE[state]}
            variant="mono"
            sx={{
              fontSize: 13,
              color: conditionColor(theme, state),
              // The third affordance: `indeterminate` is dashed, the other two
              // solid, so the distinction survives a greyscale screenshot.
              borderBottom: `1px ${CONDITION_ROW_RULE_STYLE[state]} currentColor`,
              pb: 0.25,
            }}
          >
            {`${CONDITION_GLYPHS[state]} ${counts[state]} ${state}`}
          </Typography>
        ))}
      </Box>

      {evaluation === null || evaluation === undefined ? (
        // Without this sentence, "◉ 0 tripped · ● 0 holding" reads as "nothing
        // has tripped" — a claim about the world, where the truth is that our
        // own arithmetic has never run.
        <Typography data-testid="verdict-band-unevaluated" sx={{ fontSize: 13, color: "text.secondary" }}>
          {NEVER_EVALUATED}
        </Typography>
      ) : null}
    </Box>
  );
}
