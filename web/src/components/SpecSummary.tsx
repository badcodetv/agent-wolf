/**
 * The spec, in plain English — what going live will lock.
 *
 * 🔴 The go-live review screen used to show only the report template, while
 * the next step beside it said "check the scoreboard" (2026-09-13, the first
 * real-model walk). The scoreboard is decided by the spec — which series,
 * which direction, over what horizon, and which condition calls the thesis
 * wrong — and a human was being asked to lock it without seeing it.
 *
 * This renders the payload's `spec` and nothing else. It validates nothing
 * (the server's `spec_validation` is the gate, and `GoLiveButton` shows its
 * errors) and it reads every field defensively: `spec` is `unknown` on the
 * wire, and a malformed one costs a sentence, never the page (R140).
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatNumber } from "../format.js";
import type { HypothesisSpec, SpecCondition, SpecMetric } from "../api/types.js";

const OP_WORDS: Record<string, string> = {
  gt: "is above",
  gte: "is at or above",
  lt: "is below",
  lte: "is at or below",
};

const DIRECTION_WORDS: Record<string, string> = {
  up: "expected to go up",
  down: "expected to go down",
  flat: "expected to stay flat",
};

const PERCENT_STATS = new Set(["change_pct", "drawdown_pct"]);

function referencePhrase(condition: SpecCondition): string {
  switch (condition.reference) {
    case "value_at_live":
      return "since go-live";
    case "peak_since_live":
      return "from its peak since go-live";
    case "trailing_n_days":
      return typeof condition.reference_days === "number"
        ? `over the last ${condition.reference_days} days`
        : "over a trailing window";
    default:
      return "";
  }
}

/** One condition as a sentence: "btc-usd's change since go-live is below -15% for 14 days in a row". */
export function describeCondition(condition: SpecCondition): string {
  const metric = String(condition.metric);
  const reference = referencePhrase(condition);
  let subject: string;
  switch (condition.stat) {
    case "level":
      subject = metric;
      break;
    case "change_abs":
      subject = `${metric}'s change ${reference}`;
      break;
    case "change_pct":
      subject = `${metric}'s % change ${reference}`;
      break;
    case "drawdown_pct":
      subject = `${metric}'s fall ${reference}`;
      break;
    case "ratio_to":
      subject =
        typeof condition.ratio_lookback_days === "number"
          ? `${metric} relative to ${String(condition.ratio_metric)}, over ${condition.ratio_lookback_days} days,`
          : `${metric} relative to ${String(condition.ratio_metric)}`;
      break;
    default:
      subject = `${metric} (${String(condition.stat)})`;
  }
  const op = OP_WORDS[String(condition.op)] ?? String(condition.op);
  const unit = PERCENT_STATS.has(String(condition.stat)) ? "%" : "";
  const threshold = `${formatNumber(condition.threshold)}${unit}`;
  const days =
    typeof condition.sustained_days === "number" && condition.sustained_days > 1
      ? ` for ${condition.sustained_days} days in a row`
      : "";
  return `${subject.trim().replace(/\s+/g, " ")} ${op} ${threshold}${days}`;
}

/** One metric as a phrase: "btc-usd — BTC-USD from yahoo, expected to go up". */
export function describeMetric(metric: SpecMetric, onlyOne: boolean): string {
  const series = typeof metric.series_id === "string" && metric.series_id !== "" ? `${metric.series_id} from ` : "";
  const direction = DIRECTION_WORDS[String(metric.direction)] ?? `direction ${String(metric.direction)}`;
  const weight =
    !onlyOne && typeof metric.weight === "number" ? ` (weight ${formatNumber(metric.weight * 100, 0)}%)` : "";
  return `${metric.slug} — ${series}${String(metric.source)}, ${direction}${weight}`;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", mt: 1 }}>{children}</Typography>
  );
}

export interface SpecSummaryProps {
  spec: HypothesisSpec | null | undefined;
}

export default function SpecSummary({ spec }: SpecSummaryProps) {
  if (spec === null || spec === undefined || typeof spec !== "object") {
    return (
      <Typography data-testid="spec-summary-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
        No spec has been proposed yet — the interview writes one.
      </Typography>
    );
  }
  const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
  const conditions = Array.isArray(spec.invalidation) ? spec.invalidation : [];

  return (
    <Box data-testid="spec-summary">
      {typeof spec.thesis === "string" && spec.thesis !== "" ? (
        <Typography data-testid="spec-thesis" sx={{ fontSize: 14 }}>
          {spec.thesis}
        </Typography>
      ) : null}
      {typeof spec.horizon_days === "number" ? (
        <Typography data-testid="spec-horizon" sx={{ fontSize: 13, color: "text.secondary" }}>
          {`Tracked for ${spec.horizon_days} days from go-live.`}
        </Typography>
      ) : null}

      <Label>WHAT IS MEASURED</Label>
      {metrics.length === 0 ? (
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>No metrics.</Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {metrics.map((metric) => (
            <Typography component="li" key={metric.slug} data-testid="spec-metric" sx={{ fontSize: 13 }}>
              {describeMetric(metric, metrics.length === 1)}
            </Typography>
          ))}
        </Box>
      )}

      <Label>CALLED WRONG IF</Label>
      {conditions.length === 0 ? (
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>No invalidation conditions.</Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {conditions.map((condition) => (
            <Typography component="li" key={condition.id} data-testid="spec-condition" sx={{ fontSize: 13 }}>
              {describeCondition(condition)}
              {typeof condition.meaning === "string" && condition.meaning !== "" ? (
                <Box component="span" sx={{ color: "text.secondary" }}>{` — ${condition.meaning}`}</Box>
              ) : null}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}
