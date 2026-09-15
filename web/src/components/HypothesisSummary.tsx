/**
 * The top of the detail page: how this hypothesis is doing, at a glance.
 *
 * ```
 * ┌─────────────────────────────────────────────┬────────────────────┐
 * │ HOW IT'S DOING                              │ SUPPORT SCORE      │
 * │ ● Holding                                   │ +0.34              │
 * │ gold-futures is up 6.2% since go-live …     │ Day 42 of 365 ▬▬── │
 * └─────────────────────────────────────────────┴────────────────────┘
 *  PROVED WRONG IF…
 *  ┌ rule ─────────┐ ┌ rule ─────────┐ ┌ rule ─────────┐
 *  │ ● safe  now … │ │ ● safe  now … │ │ △ can't score │
 *  └───────────────┘ └───────────────┘ └───────────────┘
 * ```
 *
 * Everything shown is computed in `standing.ts` from the payload the page
 * already holds. The full condition table, with windows and reasons, is one
 * tab away; this is the summary of it, not a replacement.
 */

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme, type Theme } from "@mui/material/styles";
import { formatScore } from "./HypothesisRow.js";
import { SUPPORT_SCORE_NOTE, awaitingFirstObservation } from "./Scoreboard.js";
import { CONDITION_GLYPHS, CONDITION_ROW_RULE_STYLE, conditionColor } from "../theme.js";
import { indeterminateCause } from "../reasons.js";
import { isConditionState, type EvaluationResult, type HypothesisSpec, type StateChangeRow } from "../api/types.js";
import {
  goLiveAtMs,
  horizonProgress,
  ruleLinesFor,
  standingFor,
  type StandingTone,
} from "../standing.js";

export interface HypothesisSummaryProps {
  status: string | null | undefined;
  evaluation: EvaluationResult | null;
  spec: HypothesisSpec | null;
  stateHistory?: StateChangeRow[];
  /** When the state history hit its cap, go-live may be older than anything in it: no day count then. */
  stateHistoryTruncated?: boolean;
  nowMs?: number;
}

function toneColor(theme: Theme, tone: StandingTone): string {
  switch (tone) {
    case "accent":
      return theme.palette.primary.main;
    case "warning":
      return theme.palette.warning.main;
    case "positive":
      return theme.palette.success.main;
    default:
      return theme.palette.text.secondary;
  }
}

const LABEL_SX = { fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary" } as const;

/** The short label under a rule card. */
function ruleStateLabel(state: string): string {
  if (state === "holding") return "safe";
  if (state === "tripped") return "tripped";
  return "can't be scored yet";
}

export default function HypothesisSummary({
  status,
  evaluation,
  spec,
  stateHistory,
  stateHistoryTruncated,
  nowMs = Date.now(),
}: HypothesisSummaryProps) {
  const theme = useTheme();
  const standing = standingFor(status, evaluation, spec);
  if (standing === null) return null;

  // Day one's `0` is not a reading (`AWAITING_FIRST_OBSERVATION`): a dash, not a confident zero.
  const score =
    typeof evaluation?.support_score === "number" && !awaitingFirstObservation(evaluation)
      ? evaluation.support_score
      : null;
  const progress =
    status === "live" && stateHistoryTruncated !== true
      ? horizonProgress(goLiveAtMs(stateHistory), spec?.horizon_days, nowMs)
      : null;
  const rules = ruleLinesFor(evaluation, spec);
  const conditionsById = new Map(
    (Array.isArray(evaluation?.conditions) ? evaluation.conditions : []).map((c) => [c.id, c]),
  );

  return (
    <Box data-testid="hypothesis-summary" sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "2fr 1fr" },
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
          backgroundColor: "background.paper",
        }}
      >
        <Box sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Typography sx={LABEL_SX}>HOW IT&apos;S DOING</Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Typography
              aria-hidden
              sx={{ fontSize: 26, lineHeight: 1, color: toneColor(theme, standing.tone) }}
            >
              {standing.glyph}
            </Typography>
            <Typography
              data-testid="standing-word"
              data-tone={standing.tone}
              sx={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-0.02em" }}
            >
              {standing.word}
            </Typography>
          </Box>
          <Typography data-testid="standing-sentence" sx={{ fontSize: 16, lineHeight: 1.5, maxWidth: 640 }}>
            {standing.sentence}
          </Typography>
        </Box>

        <Box
          sx={{
            p: 3,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            borderLeft: { sm: `1px solid ${theme.palette.divider}` },
            borderTop: { xs: `1px solid ${theme.palette.divider}`, sm: "none" },
          }}
        >
          <Box>
            <Typography sx={LABEL_SX}>SUPPORT SCORE</Typography>
            <Tooltip title={`support score — ${SUPPORT_SCORE_NOTE}`}>
              <Typography
                data-testid="summary-score"
                variant="mono"
                component="div"
                sx={{ fontSize: 36, fontWeight: 600, lineHeight: 1.2 }}
              >
                {formatScore(score)}
              </Typography>
            </Tooltip>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              Ranks it on the board. Only the rules decide a verdict.
            </Typography>
          </Box>
          {progress !== null ? (
            <Box data-testid="summary-horizon" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, fontSize: 13 }}>
                <span>
                  Day <b>{progress.day}</b> of {progress.horizonDays}
                </span>
                <Box component="span" sx={{ color: "text.secondary" }}>
                  ends {progress.endsLabel}
                </Box>
              </Box>
              <Box sx={{ height: 6, borderRadius: 3, backgroundColor: theme.palette.action.hover }}>
                <Box
                  sx={{
                    height: 6,
                    borderRadius: 3,
                    width: `${Math.round(progress.fraction * 1000) / 10}%`,
                    backgroundColor: "text.primary",
                  }}
                />
              </Box>
            </Box>
          ) : null}
        </Box>
      </Box>

      {rules.length > 0 ? (
        <Box data-testid="summary-rules" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography sx={LABEL_SX}>PROVED WRONG IF…</Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 1.5,
            }}
          >
            {rules.map((rule) => {
              const known = isConditionState(rule.state) ? rule.state : "indeterminate";
              const color = conditionColor(theme, known);
              const reason = conditionsById.get(rule.id)?.reason;
              const card = (
                <Box
                  data-testid={`rule-card-${rule.id}`}
                  data-state={rule.state}
                  sx={{
                    p: 2,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    backgroundColor: "background.paper",
                    borderRadius: 1,
                    border: `1px ${CONDITION_ROW_RULE_STYLE[known]} ${
                      known === "holding" ? theme.palette.divider : color
                    }`,
                  }}
                >
                  <Typography sx={{ fontSize: 14, lineHeight: 1.4 }}>{rule.meaning}</Typography>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 1,
                      fontSize: 12,
                    }}
                  >
                    <Box component="span" sx={{ color }}>
                      {CONDITION_GLYPHS[known]} {ruleStateLabel(rule.state)}
                    </Box>
                    {rule.distance !== null ? (
                      <Box component="span" sx={{ fontFamily: theme.typography.mono.fontFamily }}>
                        {rule.distance}
                      </Box>
                    ) : null}
                  </Box>
                  {rule.now !== null || rule.trips !== null ? (
                    <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                      {[rule.now, rule.trips].filter(Boolean).join(" · ")}
                    </Typography>
                  ) : null}
                </Box>
              );
              return known === "indeterminate" ? (
                <Tooltip key={rule.id} title={indeterminateCause(reason)}>
                  {card}
                </Tooltip>
              ) : (
                <Box key={rule.id}>{card}</Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
