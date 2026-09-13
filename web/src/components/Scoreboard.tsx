/**
 * The scoreboard — a **summary**, and the file goes out of its way to say so.
 *
 * 🔴 `support_score` decides nothing. Only conditions do. That sentence is
 * rendered, not merely commented, and `Scoreboard.test.tsx` asserts it on the
 * rendered text — it is the difference between a scoreboard and a verdict, and
 * a human staring at `+0.10` with no such sentence will read it as one.
 *
 * 🔴 **Nothing here is coloured by which way a metric moved** (§ 2b principle
 * 2). A hypothesis that predicted a fall is *succeeding* when the line goes
 * down, so green-up/red-down is not merely a taste violation here, it is
 * backwards. Movement is carried by the expected-direction glyph beside the
 * realised change, and by nothing else. The same rule binds `support_score`:
 * a negative score is not "bad", it is a summary of a thesis under pressure.
 *
 * 🔴 Staleness comes from `EvaluationResult.metrics[].stale` +
 * `stale_reason` — W4's own numbers — and NOT from the series route and not
 * from a clock in the browser. Two definitions in two places disagree the
 * first time the series route returns points newer than the last evaluation
 * (UI design § 5, "One source of truth for staleness"). The one thing the
 * series route decides is the chart's hatching; see `MetricChart.tsx`.
 *
 * 🔴 Nothing here reads a Bob delivery status. A delivery parked at
 * `awaiting_human` never clears — a known Bob wart — so a page that took
 * "is this current?" from a delivery would show every live hypothesis as
 * permanently mid-flight. `Scoreboard.test.tsx` renders from a payload
 * carrying no delivery information at all, because there is none to carry.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Severity from "./trust/Severity.js";
import { formatPercent, formatUtcDate, formatUtcDateTime } from "../format.js";
import { staleMetricCause } from "../reasons.js";
import type { EvaluationResult, MetricResult } from "../api/types.js";

/**
 * The EXPECTED direction, as a glyph. Deliberately not in `theme.ts`: the
 * theme's glyph maps are the condition and severity states, W28 owns that
 * file, and these three are neither.
 *
 * They are a glyph and a word — never a colour. See the file header.
 */
export const DIRECTION_GLYPHS: Record<string, string> = {
  up: "↑",
  down: "↓",
  flat: "→",
};

/** The sentence that stops a summary being read as a verdict. Asserted by test. */
export const SUPPORT_SCORE_NOTE = "summary only — it decides nothing, only conditions do";

/** Rendered when the poller has never produced an evaluation. Day one for every hypothesis. */
export const NEVER_EVALUATED = "not evaluated yet — the daily researcher has not produced a reading";

/**
 * Rendered in place of the score when an evaluation ran but nothing counted.
 *
 * 🔴 W4 scores only observations dated at or after go-live, so on day one the
 * evaluator runs, finds nothing to score, and writes `support_score: 0`. The
 * page then showed a confident `0.00` over "last observation —" (2026-09-13
 * walk): a number nothing produced. A zero is a real reading; this is not one.
 */
export const AWAITING_FIRST_OBSERVATION = "Waiting for the first observation after go-live";

/**
 * True when the evaluation has metrics and not one of them, nor any
 * condition, has seen an observation — the day-one state. Read defensively:
 * the wire types `unknown`, and a malformed field counts as "no observation".
 */
export function awaitingFirstObservation(evaluation: EvaluationResult | null | undefined): boolean {
  if (evaluation === null || evaluation === undefined) return false;
  const metrics = metricsOf(evaluation);
  if (metrics.length === 0) return false;
  const observed = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms);
  if (metrics.some((m) => observed(m?.last_observation_ms))) return false;
  const conditions = Array.isArray(evaluation.conditions) ? evaluation.conditions : [];
  return !conditions.some(
    (c) => typeof c?.observations_in_window === "number" && c.observations_in_window > 0,
  );
}

export interface ScoreboardProps {
  /** `null`/absent = never evaluated. Must degrade, never throw (R140). */
  evaluation?: EvaluationResult | null;
}

function metricsOf(evaluation: EvaluationResult): MetricResult[] {
  // The wire types this `unknown`; the server re-serves whatever JSON the
  // memory held. An evaluation whose `metrics` is not an array is a malformed
  // memory, and it must render as "no metrics", never throw inside render.
  return Array.isArray(evaluation.metrics) ? evaluation.metrics : [];
}

export default function Scoreboard({ evaluation }: ScoreboardProps) {
  if (evaluation === null || evaluation === undefined) {
    return (
      <Box data-testid="scoreboard" data-evaluated="false">
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{NEVER_EVALUATED}</Typography>
      </Box>
    );
  }

  const metrics = metricsOf(evaluation);
  const score = typeof evaluation.support_score === "number" ? evaluation.support_score : null;
  const awaiting = awaitingFirstObservation(evaluation);

  return (
    <Box data-testid="scoreboard" data-evaluated="true">
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 2, flexWrap: "wrap" }}>
        {awaiting ? (
          <Typography data-testid="support-score-awaiting" sx={{ fontSize: 14, color: "text.secondary" }}>
            {AWAITING_FIRST_OBSERVATION}
          </Typography>
        ) : (
          <>
            <Typography
              data-testid="support-score"
              variant="mono"
              // The ordinary text colour, stated rather than left off so a later
              // edit has to argue with this line instead of quietly adding a sign
              // colour. Not by sign, not by threshold, not at all.
              sx={{ fontSize: 22, fontWeight: 700, color: "text.primary" }}
            >
              {score === null ? "—" : score.toFixed(2)}
            </Typography>
            <Typography data-testid="support-score-note" sx={{ fontSize: 13, color: "text.secondary" }}>
              {SUPPORT_SCORE_NOTE}
            </Typography>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
          {`evaluated ${formatUtcDateTime(evaluation.evaluated_at_ms)}`}
        </Typography>
      </Box>

      {metrics.length === 0 ? (
        <Typography data-testid="scoreboard-no-metrics" sx={{ fontSize: 13, color: "text.secondary", mt: 1 }}>
          this evaluation carries no metric readings
        </Typography>
      ) : (
        <Box sx={{ mt: 1, display: "flex", flexDirection: "column", gap: 1 }}>
          {metrics.map((m) => {
            const direction = String(m.direction);
            const glyph = DIRECTION_GLYPHS[direction] ?? "?";
            return (
              <Box
                key={m.slug}
                data-testid="scoreboard-metric"
                data-metric={m.slug}
                data-stale={m.stale === true ? "true" : "false"}
                sx={{ display: "flex", alignItems: "baseline", gap: 1.5, flexWrap: "wrap" }}
              >
                <Typography variant="mono" sx={{ fontSize: 13, minWidth: 140 }}>
                  {m.slug}
                </Typography>
                {/* Expected, from the spec — beside realised, so "expected
                    down, moved up" is readable at a glance (§ 5). */}
                <Typography
                  data-testid="metric-direction"
                  variant="mono"
                  sx={{ fontSize: 13, color: "text.secondary" }}
                >
                  {`expected ${glyph} ${direction}`}
                </Typography>
                <Typography
                  data-testid="metric-realised"
                  variant="mono"
                  // Again: no colour by movement. See the file header.
                  sx={{ fontSize: 13, color: "text.primary" }}
                >
                  {`realised ${formatPercent(m.realised_change_pct)}`}
                </Typography>
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  {`last observation ${formatUtcDate(m.last_observation_ms)}`}
                </Typography>
                {m.stale === true ? (
                  <Severity level="degraded" cause={staleMetricCause(m.slug, m.stale_reason)} />
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
