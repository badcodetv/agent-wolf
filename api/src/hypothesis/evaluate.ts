/**
 * The condition evaluator — design/2026-08-20-agent-wolf.md § "Condition
 * semantics" and § "The support score", implemented exactly.
 *
 * This module is PURE. No I/O, no HTTP, no CSV parsing, no RFC3339 parsing and
 * no clock read: `nowMs` is an argument precisely so the module is
 * deterministic and so the sustained window is anchored on evaluation time
 * rather than on the newest observation. Anchoring on the newest observation
 * would let a feed that died sixty days ago mid-trip keep tripping forever on
 * ancient data; anchoring on `nowMs` makes a dead feed's recent window empty,
 * so it reports `indeterminate` and surfaces as a problem for a human.
 *
 * Turning an RFC3339 CSV into `Point[]` is the caller's job (W10 and W11 both
 * do it); this module never sees a date string. `Point` carries its unit in the
 * field name — `tMs`, unix MILLISECONDS — because a `{t, v}` shape from
 * somewhere else is a silent `NaN` in the window arithmetic rather than a type
 * error. `Point`, `EvaluationResult`, `ConditionResult`, `MetricResult` and
 * `Reason` are exported from here and every downstream ticket imports them
 * rather than redeclaring.
 *
 * Contract on the inputs, which this module trusts rather than re-derives:
 * every series is ascending by `tMs` (`peak_since_live` is a running maximum
 * over `[L, t]` and `value_at_live` is the first observation at or after `L`,
 * so both read the order directly). Observations with a non-finite `tMs` or
 * `v` are treated as absent — a `NaN` reaching `value` would be serialised as
 * `null` by `JSON.stringify` and silently break the deep-equal round trip that
 * makes an evaluation a permanent record.
 */

import type { Condition, Direction, Metric, Op, Spec } from "./spec.js";

/* ------------------------------------------------------------------ */
/* the shapes every downstream ticket imports                          */
/* ------------------------------------------------------------------ */

/** Unix milliseconds. The unit lives in the name; see § "Shared shapes". */
export type UnixMs = number;

export const MS_PER_DAY = 86_400_000;

/**
 * W3 already defaults these on every validated spec; they are repeated here
 * only so a hand-built spec cannot produce a `NaN` window. They must stay
 * equal to `DEFAULT_FLAT_BAND_PCT` / `DEFAULT_STALENESS_DAYS` in `spec.ts`,
 * which this module may not import from because it imports types only.
 */
const DEFAULT_FLAT_BAND_PCT = 2.0;
const DEFAULT_STALENESS_DAYS = 5;

/** One observation. Unix MILLISECONDS, matching `liveAtMs` and `nowMs`. */
export interface Point {
  tMs: UnixMs;
  v: number;
}

export type ConditionState = "tripped" | "holding" | "indeterminate";

/**
 * The closed vocabulary of § "Every condition result carries a reason", plus
 * `no_observations`, which W4's own criteria require for a metric with no
 * observations at all and for a metric-level `stale_reason`. W14 imports this
 * type rather than matching on strings.
 */
export type Reason =
  | "condition_tripped"
  | "insufficient_coverage"
  | "non_positive_reference"
  | "stale_data"
  | "no_observations"
  | "no_ratio_pair";

export interface ConditionResult {
  id: string;
  metric: string;
  state: ConditionState;
  reason: Reason | null;
  /** The statistic at the most recent non-skipped observation in the window. */
  value: number | null;
  threshold: number;
  op: Op;
  window_start_ms: UnixMs;
  window_end_ms: UnixMs;
  /** Non-skipped observations only — the same count the coverage floor tests. */
  observations_in_window: number;
}

export interface MetricResult {
  slug: string;
  /** The EXPECTED direction, from the spec. `flat` is legal (R65). */
  direction: Direction;
  realised_change_pct: number | null;
  last_observation_ms: UnixMs | null;
  stale: boolean;
  stale_reason: Reason | null;
}

export interface EvaluationResult {
  evaluated_at_ms: UnixMs;
  /** −1 … +1. A summary for humans; it never trips anything. */
  support_score: number;
  conditions: ConditionResult[];
  metrics: MetricResult[];
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** The reason an observation was skipped, and the tie-break order for it. */
type SkipReason = "non_positive_reference" | "no_ratio_pair" | "insufficient_coverage";
const SKIP_PRIORITY: readonly SkipReason[] = [
  "non_positive_reference",
  "no_ratio_pair",
  "insufficient_coverage",
];

/** One observation with its statistic, or with the reason it was skipped. */
interface Sample {
  tMs: UnixMs;
  stat: number | null;
  skip: SkipReason | null;
}

function usable(point: Point | undefined): point is Point {
  return (
    point !== undefined &&
    point !== null &&
    Number.isFinite(point.tMs) &&
    Number.isFinite(point.v)
  );
}

/** The observations a condition or metric is computed over: `tMs >= liveAtMs`. */
function liveObservations(series: Point[] | undefined, liveAtMs: UnixMs): Point[] {
  if (!Array.isArray(series)) return [];
  return series.filter((point) => usable(point) && point.tMs >= liveAtMs);
}

function holds(op: Op, stat: number, threshold: number): boolean {
  switch (op) {
    case "gt":
      return stat > threshold;
    case "gte":
      return stat >= threshold;
    case "lt":
      return stat < threshold;
    case "lte":
      return stat <= threshold;
  }
}

/**
 * The reference `R` at one observation, or `undefined` when there is none to
 * compute (an empty trailing window, or a spec field W3 would have required).
 *
 * `valueAtLive` is the value of the first observation at or after go-live and
 * `runningPeak` is the maximum over `[L, t]` INCLUDING this observation — the
 * caller keeps both, so neither is recomputed per observation.
 */
function referenceFor(
  condition: Condition,
  observations: Point[],
  observation: Point,
  valueAtLive: number | undefined,
  runningPeak: number | undefined,
): number | undefined {
  switch (condition.reference) {
    case "value_at_live":
      return valueAtLive;
    case "peak_since_live":
      return runningPeak;
    case "trailing_n_days": {
      const days = condition.reference_days;
      if (days === undefined || !Number.isFinite(days)) return undefined;
      // The HALF-OPEN [t - reference_days, t): `t` itself is excluded, so the
      // first observation after go-live has an empty window and is skipped.
      const from = observation.tMs - days * MS_PER_DAY;
      const to = observation.tMs;
      let sum = 0;
      let n = 0;
      for (const other of observations) {
        if (other.tMs >= from && other.tMs < to) {
          sum += other.v;
          n += 1;
        }
      }
      return n === 0 ? undefined : sum / n;
    }
    default:
      return undefined;
  }
}

/**
 * `ratio_metric`'s value at the nearest timestamp AT OR BEFORE `tMs`, within
 * `ratio_lookback_days`. Not restricted to observations after go-live: the
 * partner is a different series, and a monthly macro series' newest point
 * before go-live is the right partner for the first daily observation after
 * it. `undefined` when there is no such point.
 */
function partnerValue(
  partner: Point[] | undefined,
  tMs: UnixMs,
  lookbackDays: number | undefined,
): number | undefined {
  if (!Array.isArray(partner)) return undefined;
  if (lookbackDays === undefined || !Number.isFinite(lookbackDays)) return undefined;
  const earliest = tMs - lookbackDays * MS_PER_DAY;
  let bestTMs: number | undefined;
  let bestValue: number | undefined;
  for (const point of partner) {
    if (!usable(point)) continue;
    if (point.tMs > tMs || point.tMs < earliest) continue;
    if (bestTMs === undefined || point.tMs >= bestTMs) {
      bestTMs = point.tMs;
      bestValue = point.v;
    }
  }
  return bestValue;
}

/** The statistic at every observation, or the reason each was skipped. */
function samplesFor(
  condition: Condition,
  observations: Point[],
  seriesByMetric: Record<string, Point[]>,
): Sample[] {
  const samples: Sample[] = [];
  const valueAtLive = observations[0]?.v;
  let runningPeak: number | undefined;
  for (const observation of observations) {
    const { tMs, v } = observation;
    // The peak over [L, t], recomputed per observation — kept incrementally.
    if (runningPeak === undefined || v > runningPeak) runningPeak = v;

    if (condition.stat === "level") {
      samples.push({ tMs, stat: v, skip: null });
      continue;
    }

    if (condition.stat === "ratio_to") {
      const other = partnerValue(
        condition.ratio_metric === undefined ? undefined : seriesByMetric[condition.ratio_metric],
        tMs,
        condition.ratio_lookback_days,
      );
      if (other === undefined) {
        samples.push({ tMs, stat: null, skip: "no_ratio_pair" });
        continue;
      }
      if (other === 0) {
        // Same rule as a non-positive reference: skipped, not zero, not
        // infinity, not an error.
        samples.push({ tMs, stat: null, skip: "non_positive_reference" });
        continue;
      }
      samples.push({ tMs, stat: v / other, skip: null });
      continue;
    }

    const reference = referenceFor(condition, observations, observation, valueAtLive, runningPeak);
    if (reference === undefined) {
      // No reference to compare against — an empty trailing window. There is
      // not enough data at this observation, which is what the coverage
      // vocabulary already means.
      samples.push({ tMs, stat: null, skip: "insufficient_coverage" });
      continue;
    }

    switch (condition.stat) {
      /**
       * `change_abs` exists because percentages are undefined on series that
       * cross zero. Real rates, net exports and trade balances all go
       * negative, and this product's premise is FRED macro data: use
       * `change_abs` (or `level`) for ANY series whose values can be <= 0,
       * where `change_pct` and `drawdown_pct` skip every observation instead.
       */
      case "change_abs":
        samples.push({ tMs, stat: v - reference, skip: null });
        break;
      case "change_pct":
        if (reference <= 0) {
          // Dividing by a non-positive reference silently inverts the sign of
          // the comparison, which is how a condition trips backwards.
          samples.push({ tMs, stat: null, skip: "non_positive_reference" });
        } else {
          samples.push({ tMs, stat: (100 * (v - reference)) / reference, skip: null });
        }
        break;
      case "drawdown_pct":
        if (reference <= 0) {
          samples.push({ tMs, stat: null, skip: "non_positive_reference" });
        } else {
          samples.push({ tMs, stat: (100 * (reference - v)) / reference, skip: null });
        }
        break;
      default:
        samples.push({ tMs, stat: null, skip: "insufficient_coverage" });
        break;
    }
  }
  return samples;
}

/**
 * Skip exhaustion is per-reason: the reason with the higher skip count wins,
 * ties resolving in `SKIP_PRIORITY` order (`non_positive_reference` first).
 */
function dominantSkip(samples: Sample[]): Reason {
  const counts = new Map<SkipReason, number>();
  for (const sample of samples) {
    if (sample.skip !== null) counts.set(sample.skip, (counts.get(sample.skip) ?? 0) + 1);
  }
  let best: SkipReason = "non_positive_reference";
  let bestCount = -1;
  for (const reason of SKIP_PRIORITY) {
    const count = counts.get(reason) ?? 0;
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

function evaluateCondition(
  condition: Condition,
  seriesByMetric: Record<string, Point[]>,
  liveAtMs: UnixMs,
  nowMs: UnixMs,
  stalenessDays: number,
): ConditionResult {
  const sustainedDays = condition.sustained_days;
  const windowStartMs = sustainedDays === 0 ? nowMs : nowMs - sustainedDays * MS_PER_DAY;
  const base = {
    id: condition.id,
    metric: condition.metric,
    threshold: condition.threshold,
    op: condition.op,
    window_start_ms: windowStartMs,
    window_end_ms: nowMs,
  };

  const observations = liveObservations(seriesByMetric[condition.metric], liveAtMs);
  if (observations.length === 0) {
    return {
      ...base,
      state: "indeterminate",
      reason: "no_observations",
      value: null,
      observations_in_window: 0,
    };
  }

  const samples = samplesFor(condition, observations, seriesByMetric);
  const counted = samples.filter((sample) => sample.stat !== null);
  const newest = samples[samples.length - 1];
  const newestCounted = counted[counted.length - 1];

  // Every observation skipped: the outcome is the reason for the skips.
  // (`newest`/`newestCounted` are undefined only if the arrays are empty,
  // which for `newest` cannot happen — `samples` mirrors `observations` one
  // for one — but the guard keeps the indexing honest.)
  if (newest === undefined) {
    return {
      ...base,
      state: "indeterminate",
      reason: "no_observations",
      value: null,
      observations_in_window: 0,
    };
  }
  if (counted.length === 0 || newestCounted === undefined) {
    return {
      ...base,
      state: "indeterminate",
      reason: dominantSkip(samples),
      value: null,
      observations_in_window: 0,
    };
  }

  if (sustainedDays === 0) {
    // A single observation is enough — but only the MOST RECENT one, and only
    // if it is fresh. There is no fallback to an earlier observation.
    const value = newestCounted.stat;
    if (newest.stat === null) {
      return {
        ...base,
        state: "indeterminate",
        reason: newest.skip,
        value,
        observations_in_window: 0,
      };
    }
    if (nowMs - newest.tMs > stalenessDays * MS_PER_DAY) {
      return {
        ...base,
        state: "indeterminate",
        reason: "stale_data",
        value,
        observations_in_window: 1,
      };
    }
    const tripped = holds(condition.op, newest.stat, condition.threshold);
    return {
      ...base,
      state: tripped ? "tripped" : "holding",
      reason: tripped ? "condition_tripped" : null,
      value,
      observations_in_window: 1,
    };
  }

  // The window is anchored on nowMs: (nowMs - sustained_days, nowMs].
  const inWindow = counted.filter(
    (sample) => sample.tMs > windowStartMs && sample.tMs <= nowMs,
  );
  const value = inWindow.length === 0 ? null : (inWindow[inWindow.length - 1]?.stat ?? null);

  // The coverage floor is checked BEFORE `holds`: weekends, holidays and
  // provider outages must not be able to trip a condition by absence of
  // contrary evidence.
  const floor = Math.ceil(sustainedDays * 0.6);
  if (inWindow.length < floor) {
    return {
      ...base,
      state: "indeterminate",
      reason: "insufficient_coverage",
      value,
      observations_in_window: inWindow.length,
    };
  }

  const tripped = inWindow.every(
    (sample) => sample.stat !== null && holds(condition.op, sample.stat, condition.threshold),
  );
  return {
    ...base,
    state: tripped ? "tripped" : "holding",
    reason: tripped ? "condition_tripped" : null,
    value,
    observations_in_window: inWindow.length,
  };
}

function evaluateMetric(
  metric: Metric,
  seriesByMetric: Record<string, Point[]>,
  liveAtMs: UnixMs,
  nowMs: UnixMs,
  stalenessDays: number,
): MetricResult {
  const observations = liveObservations(seriesByMetric[metric.slug], liveAtMs);
  if (observations.length === 0) {
    return {
      slug: metric.slug,
      direction: metric.direction,
      realised_change_pct: null,
      last_observation_ms: null,
      stale: true,
      stale_reason: "no_observations",
    };
  }
  const reference = observations[0]?.v;
  const newest = observations[observations.length - 1];
  if (reference === undefined || newest === undefined) {
    return {
      slug: metric.slug,
      direction: metric.direction,
      realised_change_pct: null,
      last_observation_ms: null,
      stale: true,
      stale_reason: "no_observations",
    };
  }
  const realised = reference > 0 ? (100 * (newest.v - reference)) / reference : null;
  const stale = nowMs - newest.tMs > stalenessDays * MS_PER_DAY;
  return {
    slug: metric.slug,
    direction: metric.direction,
    realised_change_pct: realised,
    last_observation_ms: newest.tMs,
    stale,
    stale_reason: stale ? "stale_data" : null,
  };
}

/** § "The support score": +1 / 0 / −1 per metric, against the flat band. */
function directionScore(
  direction: Direction,
  realisedChangePct: number | null,
  flatBandPct: number,
): number {
  if (realisedChangePct === null) return 0;
  const c = realisedChangePct;
  switch (direction) {
    case "up":
      return c > flatBandPct ? 1 : c < -flatBandPct ? -1 : 0;
    case "down":
      return c > flatBandPct ? -1 : c < -flatBandPct ? 1 : 0;
    case "flat":
      return Math.abs(c) <= flatBandPct ? 1 : -1;
  }
}

/* ------------------------------------------------------------------ */
/* the entry point                                                     */
/* ------------------------------------------------------------------ */

/**
 * Evaluate every condition and every metric of a spec against the series
 * fetched for it.
 *
 * @param spec           a spec already parsed by `validateSpec`.
 * @param seriesByMetric one ascending `Point[]` per metric slug; a missing key
 *                       is an empty series, which is `no_observations`.
 * @param liveAtMs       go-live, unix ms. Only observations at or after it count.
 * @param nowMs          evaluation time, unix ms. The sustained window and every
 *                       staleness test are anchored here — never on the newest
 *                       observation.
 */
export function evaluate(
  spec: Spec,
  seriesByMetric: Record<string, Point[]>,
  liveAtMs: UnixMs,
  nowMs: UnixMs,
): EvaluationResult {
  const series = seriesByMetric ?? {};
  const stalenessDays = Number.isFinite(spec.staleness_days)
    ? spec.staleness_days
    : DEFAULT_STALENESS_DAYS;
  const flatBandPct = Number.isFinite(spec.flat_band_pct)
    ? spec.flat_band_pct
    : DEFAULT_FLAT_BAND_PCT;

  const conditions = spec.invalidation.map((condition) =>
    evaluateCondition(condition, series, liveAtMs, nowMs, stalenessDays),
  );
  const metrics = spec.metrics.map((metric) =>
    evaluateMetric(metric, series, liveAtMs, nowMs, stalenessDays),
  );

  // The score is computed FROM `metrics[].realised_change_pct`, so the number
  // the UI shows and the number the score uses cannot disagree.
  let sum = 0;
  for (const [i, metric] of spec.metrics.entries()) {
    const result = metrics[i];
    if (result === undefined) continue;
    sum +=
      metric.weight *
      directionScore(result.direction, result.realised_change_pct, flatBandPct);
  }
  // W3 forces the weights to sum to 1, so the score is in [-1, 1] — but
  // floating-point addition of decimal weights can land a whisker outside it,
  // and this number is written into a permanent record.
  const clamped = Math.min(1, Math.max(-1, sum));

  return {
    evaluated_at_ms: nowMs,
    // `=== 0` is true for -0, and `JSON.stringify(-0)` is "0", which would
    // break the round-trip deep-equal that makes this a permanent record.
    support_score: clamped === 0 ? 0 : clamped,
    conditions,
    metrics,
  };
}
