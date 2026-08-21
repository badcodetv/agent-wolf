import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Condition, Direction, Metric, Spec } from "./spec.js";
import {
  evaluate,
  MS_PER_DAY,
  type ConditionResult,
  type EvaluationResult,
  type Point,
  type UnixMs,
} from "./evaluate.js";

// design/2026-08-20-agent-wolf.md § "Condition semantics" and § "The support
// score", graded by § W4's acceptance criteria.
//
// Every `it` name begins with `evaluate_` so a later `-t evaluate_` filter can
// address the whole file. Every expected number below is HAND-COMPUTED from the
// series printed beside it — never produced by calling the implementation.

/* ------------------------------------------------------------------ */
/* fixture builders                                                    */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;
/** 2026-01-01T00:00:00Z. Nothing here parses a date; this is just a fixed integer. */
const L: UnixMs = 1_767_225_600_000;

/** Point at `day` days after go-live. */
function p(day: number, v: number): Point {
  return { tMs: L + day * DAY, v };
}

/** Series of daily points starting at go-live. */
function daily(values: number[]): Point[] {
  return values.map((v, i) => p(i, v));
}

function metric(slug: string, over: Partial<Metric> = {}): Metric {
  return {
    slug,
    source: "fred",
    series_id: "SERIES",
    direction: "up",
    weight: 1,
    unit: "index",
    ...over,
  };
}

function condition(over: Partial<Condition> & { metric: string }): Condition {
  return {
    id: "inv-1",
    stat: "level",
    op: "gt",
    threshold: 0,
    sustained_days: 0,
    meaning: "the thesis is not working",
    ...over,
  };
}

function spec(metrics: Metric[], invalidation: Condition[], over: Partial<Spec> = {}): Spec {
  return {
    thesis: "a thesis",
    horizon_days: 180,
    flat_band_pct: 2.0,
    staleness_days: 5,
    metrics,
    invalidation,
    ...over,
  };
}

/**
 * The statistic AT each observation, exposed through the public API: with
 * `sustained_days: 1` and `nowMs` set to observation i's timestamp, the window
 * `(t_i - 1d, t_i]` holds exactly that one observation (the start is
 * exclusive), the coverage floor is `ceil(1 * 0.6) = 1`, and `value` is
 * therefore the statistic at observation i — or `null` if it was skipped.
 */
function perObservation(s: Spec, series: Record<string, Point[]>, days: number[]): ConditionResult[] {
  return days.map((day) => {
    const single: Spec = { ...s, invalidation: [{ ...s.invalidation[0]!, sustained_days: 1 }] };
    return evaluate(single, series, L, L + day * DAY).conditions[0]!;
  });
}

function values(results: ConditionResult[]): (number | null)[] {
  return results.map((r) => r.value);
}

function states(results: ConditionResult[]): string[] {
  return results.map((r) => r.state);
}

/* ------------------------------------------------------------------ */
/* the three series the statistic x reference grid is computed from    */
/* ------------------------------------------------------------------ */

// A — for `level` and `change_abs` against value_at_live / peak_since_live.
//   day:      0    1    2    3    4
//   v:      100  110   90  120   60
//   peak:   100  110  110  120  120
const A = daily([100, 110, 90, 120, 60]);
const A_DAYS = [0, 1, 2, 3, 4];

// B — for the percentage statistics against value_at_live / peak_since_live.
//   day:      0    1    2    3    4
//   v:       50   60   45   75   30
//   peak:    50   60   60   75   75
const B = daily([50, 60, 45, 75, 30]);

// C — for the trailing_n_days reference with reference_days = 2, whose mean
// over the HALF-OPEN [t - 2d, t) is:
//   day:      0    1    2    3    4
//   v:      100  100   90  114   51
//   mean:  none  100  100   95  102      (day 0's window holds no observation)
const C = daily([100, 100, 90, 114, 51]);

/* ------------------------------------------------------------------ */
/* the eleven grid fixtures                                            */
/* ------------------------------------------------------------------ */

describe("the statistic x reference grid", () => {
  it("evaluate_grid_1 level: the statistic is v itself, and op gte trips on the boundary", () => {
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gte", threshold: 100 })],
    );
    const r = perObservation(s, { alpha: A }, A_DAYS);
    expect(values(r)).toEqual([100, 110, 90, 120, 60]);
    expect(states(r)).toEqual(["tripped", "tripped", "holding", "tripped", "holding"]);
  });

  it("evaluate_grid_2 change_abs x value_at_live: v - 100", () => {
    const s = spec(
      [metric("alpha")],
      [
        condition({
          metric: "alpha",
          stat: "change_abs",
          reference: "value_at_live",
          op: "gt",
          threshold: 5,
        }),
      ],
    );
    const r = perObservation(s, { alpha: A }, A_DAYS);
    expect(values(r)).toEqual([0, 10, -10, 20, -40]);
    expect(states(r)).toEqual(["holding", "tripped", "holding", "tripped", "holding"]);
  });

  it("evaluate_grid_3 change_abs x peak_since_live: v - running peak over [L, t]", () => {
    const s = spec(
      [metric("alpha")],
      [
        condition({
          metric: "alpha",
          stat: "change_abs",
          reference: "peak_since_live",
          op: "lt",
          threshold: -5,
        }),
      ],
    );
    const r = perObservation(s, { alpha: A }, A_DAYS);
    expect(values(r)).toEqual([0, 0, -20, 0, -60]);
    expect(states(r)).toEqual(["holding", "holding", "tripped", "holding", "tripped"]);
  });

  it("evaluate_grid_4 change_abs x trailing_n_days: v - mean over the half-open [t - 2d, t)", () => {
    const s = spec(
      [metric("gamma")],
      [
        condition({
          metric: "gamma",
          stat: "change_abs",
          reference: "trailing_n_days",
          reference_days: 2,
          op: "lte",
          threshold: 0,
        }),
      ],
    );
    const r = perObservation(s, { gamma: C }, A_DAYS);
    // day 0's trailing window is empty, so that observation is skipped.
    expect(values(r)).toEqual([null, 0, -10, 19, -51]);
    expect(states(r)).toEqual(["indeterminate", "tripped", "tripped", "holding", "tripped"]);
  });

  it("evaluate_grid_5 change_pct x value_at_live: 100 * (v - 50) / 50", () => {
    const s = spec(
      [metric("beta")],
      [
        condition({
          metric: "beta",
          stat: "change_pct",
          reference: "value_at_live",
          op: "gt",
          threshold: 10,
        }),
      ],
    );
    const r = perObservation(s, { beta: B }, A_DAYS);
    expect(values(r)).toEqual([0, 20, -10, 50, -40]);
    expect(states(r)).toEqual(["holding", "tripped", "holding", "tripped", "holding"]);
  });

  it("evaluate_grid_6 change_pct x peak_since_live: 100 * (v - peak) / peak", () => {
    const s = spec(
      [metric("beta")],
      [
        condition({
          metric: "beta",
          stat: "change_pct",
          reference: "peak_since_live",
          op: "lt",
          threshold: -20,
        }),
      ],
    );
    const r = perObservation(s, { beta: B }, A_DAYS);
    expect(values(r)).toEqual([0, 0, -25, 0, -60]);
    expect(states(r)).toEqual(["holding", "holding", "tripped", "holding", "tripped"]);
  });

  it("evaluate_grid_7 change_pct x trailing_n_days: 100 * (v - mean) / mean", () => {
    const s = spec(
      [metric("gamma")],
      [
        condition({
          metric: "gamma",
          stat: "change_pct",
          reference: "trailing_n_days",
          reference_days: 2,
          op: "gte",
          threshold: 0,
        }),
      ],
    );
    const r = perObservation(s, { gamma: C }, A_DAYS);
    expect(values(r)).toEqual([null, 0, -10, 20, -50]);
    expect(states(r)).toEqual(["indeterminate", "tripped", "holding", "tripped", "holding"]);
  });

  it("evaluate_grid_8 drawdown_pct x value_at_live: 100 * (50 - v) / 50", () => {
    const s = spec(
      [metric("beta")],
      [
        condition({
          metric: "beta",
          stat: "drawdown_pct",
          reference: "value_at_live",
          op: "lte",
          threshold: 0,
        }),
      ],
    );
    const r = perObservation(s, { beta: B }, A_DAYS);
    expect(values(r)).toEqual([0, -20, 10, -50, 40]);
    expect(states(r)).toEqual(["tripped", "tripped", "holding", "tripped", "holding"]);
  });

  it("evaluate_grid_9 drawdown_pct x peak_since_live: 100 * (peak - v) / peak", () => {
    const s = spec(
      [metric("beta")],
      [
        condition({
          metric: "beta",
          stat: "drawdown_pct",
          reference: "peak_since_live",
          op: "gt",
          threshold: 20,
        }),
      ],
    );
    const r = perObservation(s, { beta: B }, A_DAYS);
    expect(values(r)).toEqual([0, 0, 25, 0, 60]);
    expect(states(r)).toEqual(["holding", "holding", "tripped", "holding", "tripped"]);
  });

  it("evaluate_grid_10 drawdown_pct x trailing_n_days: 100 * (mean - v) / mean", () => {
    const s = spec(
      [metric("gamma")],
      [
        condition({
          metric: "gamma",
          stat: "drawdown_pct",
          reference: "trailing_n_days",
          reference_days: 2,
          op: "gte",
          threshold: 10,
        }),
      ],
    );
    const r = perObservation(s, { gamma: C }, A_DAYS);
    expect(values(r)).toEqual([null, 0, 10, -20, 50]);
    expect(states(r)).toEqual(["indeterminate", "holding", "tripped", "holding", "tripped"]);
  });

  it("evaluate_grid_11 ratio_to mixed-frequency: daily over monthly at ratio_lookback_days 62, partner pinned per observation", () => {
    // daily metric D:  day    0    10    20    30    40    87   100
    //                  v     10    12    14    20    24     8     6
    // monthly metric M: day  -5 (v 2)   and   25 (v 4)
    // partner AT OR BEFORE t, within 62 days:
    //   day 0  -> M(-5) age  5  -> 10 / 2 = 5
    //   day 10 -> M(-5) age 15  -> 12 / 2 = 6
    //   day 20 -> M(-5) age 25  -> 14 / 2 = 7
    //   day 30 -> M(25) age  5  -> 20 / 4 = 5      (nearest, not oldest)
    //   day 40 -> M(25) age 15  -> 24 / 4 = 6
    //   day 87 -> M(25) age 62  ->  8 / 4 = 2      (the lookback bound, inclusive)
    //   day 100-> M(25) age 75  -> no partner within the lookback -> skipped
    const D: Point[] = [p(0, 10), p(10, 12), p(20, 14), p(30, 20), p(40, 24), p(87, 8), p(100, 6)];
    const M: Point[] = [p(-5, 2), p(25, 4)];
    const s = spec(
      [metric("daily-basket", { weight: 0.5 }), metric("monthly-macro", { weight: 0.5 })],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 62,
          op: "lt",
          threshold: 3,
        }),
      ],
    );
    const r = perObservation(s, { "daily-basket": D, "monthly-macro": M }, [
      0, 10, 20, 30, 40, 87, 100,
    ]);
    expect(values(r)).toEqual([5, 6, 7, 5, 6, 2, null]);
    expect(states(r)).toEqual([
      "holding",
      "holding",
      "holding",
      "holding",
      "holding",
      "tripped",
      "indeterminate",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* the sustained window, anchored on nowMs                             */
/* ------------------------------------------------------------------ */

describe("the sustained window", () => {
  it("evaluate_dead feed: a series that held continuously and then stopped 60 days ago is indeterminate, not tripped", () => {
    // 40 daily observations, every one of them above the threshold, the last
    // 60 days before nowMs. Anchored on t_last this would trip forever.
    const series = daily(new Array(40).fill(200));
    const nowMs = L + 99 * DAY; // last observation is at day 39
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 100, sustained_days: 30 })],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("insufficient_coverage");
    expect(r.observations_in_window).toBe(0);
    expect(r.value).toBeNull();
    expect(r.window_start_ms).toBe(nowMs - 30 * DAY);
    expect(r.window_end_ms).toBe(nowMs);
  });

  it("evaluate_coverage floor: 4 holding observations in a 30-day window are indeterminate, never tripped", () => {
    const series = [p(0, 200), p(7, 200), p(14, 200), p(21, 200)];
    const nowMs = L + 21 * DAY;
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 100, sustained_days: 30 })],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("insufficient_coverage"); // floor is ceil(30 * 0.6) = 18
    expect(r.observations_in_window).toBe(4);
    expect(r.value).toBe(200); // still the statistic at the newest counted observation
  });

  it("evaluate_coverage floor is met exactly at ceil(sustained_days * 0.6) and then trips", () => {
    // sustained_days 5 -> floor ceil(3) = 3. Three daily observations inside
    // (nowMs - 5d, nowMs], all holding.
    const nowMs = L + 10 * DAY;
    const series = [p(6, 200), p(7, 200), p(8, 200)];
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 100, sustained_days: 5 })],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.observations_in_window).toBe(3);
    expect(r.state).toBe("tripped");
    expect(r.reason).toBe("condition_tripped");
  });

  it("evaluate_one contrary observation inside the window is enough to hold", () => {
    const nowMs = L + 10 * DAY;
    const series = [p(6, 200), p(7, 50), p(8, 200)];
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 100, sustained_days: 5 })],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.state).toBe("holding");
    expect(r.reason).toBeNull();
  });

  it("evaluate_window bounds are exclusive at the start and inclusive at the end", () => {
    const nowMs = L + 10 * DAY;
    // day 5 is exactly nowMs - 5d (excluded); day 10 is exactly nowMs (included).
    const series = [p(5, 999), p(6, 200), p(7, 200), p(10, 200)];
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 100, sustained_days: 5 })],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.observations_in_window).toBe(3);
    expect(r.state).toBe("tripped");
  });

  it("evaluate_value, window bounds and observations_in_window for a window holding one skipped and three counted observations", () => {
    // change_pct x peak_since_live over a zero-crossing series:
    //   day:      0    1    2    3
    //   v:      -10   20   30   24
    //   peak:   -10   20   30   30
    //   stat:  skip    0    0  -20      (day 0's reference is <= 0)
    const series = daily([-10, 20, 30, 24]);
    const nowMs = L + 3 * DAY;
    const s = spec(
      [metric("alpha")],
      [
        condition({
          metric: "alpha",
          stat: "change_pct",
          reference: "peak_since_live",
          op: "lte",
          threshold: 0,
          sustained_days: 4, // floor is ceil(2.4) = 3, met by the three counted
        }),
      ],
    );
    const r = evaluate(s, { alpha: series }, L, nowMs).conditions[0]!;
    expect(r.value).toBe(-20);
    expect(r.observations_in_window).toBe(3); // the skipped observation is not counted
    expect(r.window_start_ms).toBe(nowMs - 4 * DAY);
    expect(r.window_end_ms).toBe(nowMs);
    expect(r.state).toBe("tripped");
    expect(r.reason).toBe("condition_tripped");
  });
});

/* ------------------------------------------------------------------ */
/* sustained_days == 0                                                 */
/* ------------------------------------------------------------------ */

describe("sustained_days == 0", () => {
  it("evaluate_single observation trips when it holds and is fresh, with the degenerate window [nowMs, nowMs]", () => {
    const nowMs = L + 12 * DAY;
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 50, sustained_days: 0 })],
    );
    const r = evaluate(s, { alpha: [p(8, 40), p(10, 60)] }, L, nowMs).conditions[0]!;
    expect(r.state).toBe("tripped");
    expect(r.reason).toBe("condition_tripped");
    expect(r.value).toBe(60);
    expect(r.observations_in_window).toBe(1);
    expect(r.window_start_ms).toBe(nowMs);
    expect(r.window_end_ms).toBe(nowMs);
  });

  it("evaluate_single observation older than staleness_days is indeterminate with reason stale_data", () => {
    const nowMs = L + 20 * DAY; // last observation is 10 days old, staleness_days is 5
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 50, sustained_days: 0 })],
    );
    const r = evaluate(s, { alpha: [p(8, 40), p(10, 60)] }, L, nowMs).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("stale_data");
    expect(r.value).toBe(60);
  });

  it("evaluate_staleness_days is spec-level and settable, and an observation exactly staleness_days old is still fresh", () => {
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 50, sustained_days: 0 })],
      { staleness_days: 3 },
    );
    const exactly = evaluate(s, { alpha: [p(10, 60)] }, L, L + 13 * DAY).conditions[0]!;
    expect(exactly.state).toBe("tripped");
    const past = evaluate(s, { alpha: [p(10, 60)] }, L, L + 13 * DAY + 1).conditions[0]!;
    expect(past.state).toBe("indeterminate");
    expect(past.reason).toBe("stale_data");
  });

  it("evaluate_a skipped most-recent observation is indeterminate, never a fallback to an earlier one", () => {
    // ratio_to: the day-50 observation has no partner within the 5-day
    // lookback, while day 0 and day 1 both resolve to a partner of 2.
    const D: Point[] = [p(0, 10), p(1, 12), p(50, 999)];
    const M: Point[] = [p(0, 2), p(1, 2)];
    const s = spec(
      [metric("daily-basket"), metric("monthly-macro")],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 5,
          op: "gt",
          threshold: 1,
          sustained_days: 0,
        }),
      ],
    );
    const r = evaluate(s, { "daily-basket": D, "monthly-macro": M }, L, L + 50 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("no_ratio_pair");
    expect(r.value).toBe(6); // the statistic at the newest NON-skipped observation
    expect(r.observations_in_window).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* skips, skip exhaustion and the indeterminate branches               */
/* ------------------------------------------------------------------ */

describe("skips and indeterminate branches", () => {
  it("evaluate_no observations at all is indeterminate with reason no_observations", () => {
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 1, sustained_days: 10 })],
    );
    const r = evaluate(s, {}, L, L + DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("no_observations");
    expect(r.value).toBeNull();
    expect(r.observations_in_window).toBe(0);
  });

  it("evaluate_observations before go-live do not count as observations", () => {
    const s = spec(
      [metric("alpha")],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 1, sustained_days: 10 })],
    );
    const r = evaluate(s, { alpha: [p(-5, 500), p(-1, 500)] }, L, L + DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("no_observations");
  });

  it("evaluate_zero-crossing series: every observation skipped for R <= 0 is indeterminate with reason non_positive_reference", () => {
    // value_at_live is -5, so 100 * (v - R) / R would invert the comparison.
    const series = daily([-5, -2, 3, 8]);
    const s = spec(
      [metric("alpha")],
      [
        condition({
          metric: "alpha",
          stat: "change_pct",
          reference: "value_at_live",
          op: "gt",
          threshold: 10,
          sustained_days: 3,
        }),
      ],
    );
    const r = evaluate(s, { alpha: series }, L, L + 3 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("non_positive_reference");
    expect(r.value).toBeNull();
    expect(r.observations_in_window).toBe(0);
  });

  it("evaluate_change_abs is defined on the same zero-crossing series, which is why it exists", () => {
    const series = daily([-5, -2, 3, 8]);
    const s = spec(
      [metric("alpha")],
      [
        condition({
          metric: "alpha",
          stat: "change_abs",
          reference: "value_at_live",
          op: "gt",
          threshold: 5,
          sustained_days: 3,
        }),
      ],
    );
    const r = evaluate(s, { alpha: series }, L, L + 3 * DAY).conditions[0]!;
    // stats are 0, 3, 8, 13 — none skipped, and not all of them hold. The
    // window (day 0, day 3] excludes day 0 itself, so three are counted.
    expect(r.state).toBe("holding");
    expect(r.value).toBe(13);
    expect(r.observations_in_window).toBe(3);
  });

  it("evaluate_mixed-frequency ratio_to with no partner anywhere is indeterminate with reason no_ratio_pair", () => {
    const D: Point[] = [p(0, 10), p(1, 12), p(2, 14)];
    const M: Point[] = [p(-100, 2)]; // 100+ days before every observation
    const s = spec(
      [metric("daily-basket"), metric("monthly-macro")],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 7,
          op: "gt",
          threshold: 1,
          sustained_days: 2,
        }),
      ],
    );
    const r = evaluate(s, { "daily-basket": D, "monthly-macro": M }, L, L + 2 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("no_ratio_pair");
    expect(r.value).toBeNull();
  });

  it("evaluate_skip exhaustion takes the reason with the higher count: non_positive_reference wins 3 to 1", () => {
    // partner value 0 -> non_positive_reference; beyond the lookback -> no_ratio_pair
    const D: Point[] = [p(0, 10), p(1, 12), p(2, 14), p(50, 16)];
    const M: Point[] = [p(-1, 0)];
    const s = spec(
      [metric("daily-basket"), metric("monthly-macro")],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 5,
          op: "gt",
          threshold: 1,
          sustained_days: 60,
        }),
      ],
    );
    const r = evaluate(s, { "daily-basket": D, "monthly-macro": M }, L, L + 50 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("non_positive_reference");
  });

  it("evaluate_skip exhaustion takes the reason with the higher count: no_ratio_pair wins 3 to 1", () => {
    const D: Point[] = [p(0, 10), p(50, 12), p(51, 14), p(52, 16)];
    const M: Point[] = [p(-1, 0)];
    const s = spec(
      [metric("daily-basket"), metric("monthly-macro")],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 5,
          op: "gt",
          threshold: 1,
          sustained_days: 60,
        }),
      ],
    );
    const r = evaluate(s, { "daily-basket": D, "monthly-macro": M }, L, L + 52 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("no_ratio_pair");
  });

  it("evaluate_skip exhaustion tie of 2 and 2 resolves to non_positive_reference", () => {
    const D: Point[] = [p(0, 10), p(1, 12), p(50, 14), p(51, 16)];
    const M: Point[] = [p(-1, 0)];
    const s = spec(
      [metric("daily-basket"), metric("monthly-macro")],
      [
        condition({
          metric: "daily-basket",
          stat: "ratio_to",
          ratio_metric: "monthly-macro",
          ratio_lookback_days: 5,
          op: "gt",
          threshold: 1,
          sustained_days: 60,
        }),
      ],
    );
    const r = evaluate(s, { "daily-basket": D, "monthly-macro": M }, L, L + 51 * DAY).conditions[0]!;
    expect(r.state).toBe("indeterminate");
    expect(r.reason).toBe("non_positive_reference");
  });
});

/* ------------------------------------------------------------------ */
/* per-metric results and the support score                            */
/* ------------------------------------------------------------------ */

describe("metrics and the support score", () => {
  function threeMetricSpec(): Spec {
    return spec(
      [
        metric("up-metric", { direction: "up", weight: 0.5 }),
        metric("down-metric", { direction: "down", weight: 0.25 }),
        metric("flat-metric", { direction: "flat", weight: 0.25 }),
      ],
      [condition({ metric: "up-metric", stat: "level", op: "gt", threshold: 0 })],
    );
  }

  it("evaluate_metrics carry expected direction, realised change and the newest observation", () => {
    const r = evaluate(
      threeMetricSpec(),
      {
        "up-metric": [p(0, 100), p(1, 110)],
        "down-metric": [p(0, 50), p(1, 60)],
        "flat-metric": [p(0, 200), p(1, 202)],
      },
      L,
      L + DAY,
    );
    expect(r.metrics).toEqual([
      {
        slug: "up-metric",
        direction: "up" as Direction,
        realised_change_pct: 10,
        last_observation_ms: L + DAY,
        stale: false,
        stale_reason: null,
      },
      {
        slug: "down-metric",
        direction: "down" as Direction,
        realised_change_pct: 20,
        last_observation_ms: L + DAY,
        stale: false,
        stale_reason: null,
      },
      {
        slug: "flat-metric",
        direction: "flat" as Direction,
        realised_change_pct: 1,
        last_observation_ms: L + DAY,
        stale: false,
        stale_reason: null,
      },
    ]);
  });

  it("evaluate_support score scores up, down and flat and sums weight * s", () => {
    // up   +10% > band  -> s = +1  -> +0.5
    // down +20% > band  -> s = -1  -> -0.25
    // flat  +1% <= band -> s = +1  -> +0.25
    const r = evaluate(
      threeMetricSpec(),
      {
        "up-metric": [p(0, 100), p(1, 110)],
        "down-metric": [p(0, 50), p(1, 60)],
        "flat-metric": [p(0, 200), p(1, 202)],
      },
      L,
      L + DAY,
    );
    expect(r.support_score).toBe(0.5);
  });

  it("evaluate_support score: a flat metric outside the band scores -1, and the band is spec-level", () => {
    const s = spec(
      [metric("flat-metric", { direction: "flat", weight: 1 })],
      [condition({ metric: "flat-metric", stat: "level", op: "gt", threshold: 0 })],
      { flat_band_pct: 2.0 },
    );
    const outside = evaluate(s, { "flat-metric": [p(0, 100), p(1, 105)] }, L, L + DAY);
    expect(outside.support_score).toBe(-1);
    const widened = evaluate(
      { ...s, flat_band_pct: 10 },
      { "flat-metric": [p(0, 100), p(1, 105)] },
      L,
      L + DAY,
    );
    expect(widened.support_score).toBe(1);
  });

  it("evaluate_support score: a metric inside the band scores 0 for up and for down", () => {
    const s = spec(
      [
        metric("up-metric", { direction: "up", weight: 0.5 }),
        metric("down-metric", { direction: "down", weight: 0.5 }),
      ],
      [condition({ metric: "up-metric", stat: "level", op: "gt", threshold: 0 })],
    );
    const r = evaluate(
      s,
      { "up-metric": [p(0, 100), p(1, 101)], "down-metric": [p(0, 100), p(1, 101)] },
      L,
      L + DAY,
    );
    expect(r.metrics.map((m) => m.realised_change_pct)).toEqual([1, 1]);
    expect(r.support_score).toBe(0);
  });

  it("evaluate_support score: a metric with a null realised change scores 0", () => {
    const s = spec(
      [
        metric("up-metric", { direction: "up", weight: 0.5 }),
        metric("missing-metric", { direction: "up", weight: 0.5 }),
      ],
      [condition({ metric: "up-metric", stat: "level", op: "gt", threshold: 0 })],
    );
    const r = evaluate(s, { "up-metric": [p(0, 100), p(1, 110)] }, L, L + DAY);
    expect(r.metrics[1]!).toEqual({
      slug: "missing-metric",
      direction: "up",
      realised_change_pct: null,
      last_observation_ms: null,
      stale: true,
      stale_reason: "no_observations",
    });
    expect(r.support_score).toBe(0.5);
  });

  it("evaluate_realised_change_pct is null when the value at go-live is not positive", () => {
    const s = spec(
      [metric("alpha", { direction: "up", weight: 1 })],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 0 })],
    );
    const r = evaluate(s, { alpha: [p(0, -5), p(1, 5)] }, L, L + DAY);
    expect(r.metrics[0]!.realised_change_pct).toBeNull();
    expect(r.support_score).toBe(0);
  });

  it("evaluate_a metric whose newest observation is older than staleness_days is stale with reason stale_data", () => {
    const s = spec(
      [metric("alpha", { direction: "up", weight: 1 })],
      [condition({ metric: "alpha", stat: "level", op: "gt", threshold: 0 })],
    );
    const r = evaluate(s, { alpha: [p(0, 100), p(1, 110)] }, L, L + 30 * DAY);
    expect(r.metrics[0]!.stale).toBe(true);
    expect(r.metrics[0]!.stale_reason).toBe("stale_data");
    expect(r.metrics[0]!.last_observation_ms).toBe(L + DAY);
    expect(r.metrics[0]!.realised_change_pct).toBe(10); // staleness does not blank it
  });

  it("evaluate_support score stays within [-1, 1] when every metric scores -1", () => {
    const s = spec(
      [
        metric("m1", { direction: "up", weight: 0.1 }),
        metric("m2", { direction: "up", weight: 0.2 }),
        metric("m3", { direction: "up", weight: 0.3 }),
        metric("m4", { direction: "up", weight: 0.4 }),
      ],
      [condition({ metric: "m1", stat: "level", op: "gt", threshold: 0 })],
    );
    const falling = { "m1": daily([100, 50]), "m2": daily([100, 50]), "m3": daily([100, 50]), "m4": daily([100, 50]) };
    const r = evaluate(s, falling, L, L + DAY);
    expect(r.metrics.every((m) => m.realised_change_pct === -50)).toBe(true);
    expect(r.support_score).toBeGreaterThanOrEqual(-1);
    expect(r.support_score).toBeLessThanOrEqual(1);
    expect(r.support_score).toBeCloseTo(-1, 12);
  });
});

/* ------------------------------------------------------------------ */
/* the whole result: shape, serialisation, determinism, imports        */
/* ------------------------------------------------------------------ */

describe("the result as a whole", () => {
  function richResult(): EvaluationResult {
    const s = spec(
      [
        metric("alpha", { direction: "up", weight: 0.5 }),
        metric("beta", { direction: "down", weight: 0.3 }),
        metric("gone", { direction: "flat", weight: 0.2 }),
      ],
      [
        condition({
          id: "inv-1",
          metric: "alpha",
          stat: "drawdown_pct",
          reference: "peak_since_live",
          op: "gt",
          threshold: 25,
          sustained_days: 3,
        }),
        condition({ id: "inv-2", metric: "beta", stat: "level", op: "lt", threshold: 1 }),
        condition({ id: "inv-3", metric: "gone", stat: "level", op: "lt", threshold: 1 }),
      ],
    );
    return evaluate(
      s,
      { alpha: daily([100, 90, 80, 50]), beta: daily([10, 9, 8, 7]) },
      L,
      L + 3 * DAY,
    );
  }

  it("evaluate_the result has exactly the four pinned top-level fields", () => {
    const r = richResult();
    expect(Object.keys(r).sort()).toEqual([
      "conditions",
      "evaluated_at_ms",
      "metrics",
      "support_score",
    ]);
    expect(r.evaluated_at_ms).toBe(L + 3 * DAY);
    expect(Object.keys(r.conditions[0]!).sort()).toEqual([
      "id",
      "metric",
      "observations_in_window",
      "op",
      "reason",
      "state",
      "threshold",
      "value",
      "window_end_ms",
      "window_start_ms",
    ]);
    expect(Object.keys(r.metrics[0]!).sort()).toEqual([
      "direction",
      "last_observation_ms",
      "realised_change_pct",
      "slug",
      "stale",
      "stale_reason",
    ]);
  });

  it("evaluate_one condition result per spec condition, in spec order, carrying id, metric, threshold and op", () => {
    const r = richResult();
    expect(r.conditions.map((c) => c.id)).toEqual(["inv-1", "inv-2", "inv-3"]);
    expect(r.conditions.map((c) => c.metric)).toEqual(["alpha", "beta", "gone"]);
    expect(r.conditions.map((c) => c.threshold)).toEqual([25, 1, 1]);
    expect(r.conditions.map((c) => c.op)).toEqual(["gt", "lt", "lt"]);
  });

  it("evaluate_the whole result survives JSON.parse(JSON.stringify(r)) deep-equal", () => {
    const r = richResult();
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r);
  });

  it("evaluate_is deterministic: it never reads the clock, and two identical calls are deep-equal", () => {
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("evaluate must not read the clock");
    });
    try {
      const first = richResult();
      const second = richResult();
      expect(first).toStrictEqual(second);
    } finally {
      spy.mockRestore();
    }
  });

  it("evaluate_imports only type declarations from ./spec.js and nothing else from the repo", () => {
    const source = readFileSync(new URL("./evaluate.ts", import.meta.url), "utf8");
    const imports = source.match(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toHaveLength(1);
    const only = imports[0]!.trim();
    // Assembled rather than written as one literal: tools/import-boundary
    // scans this file too, and a literal spelling out the whole statement
    // would be read as a real import of a package called ".".
    expect(only.startsWith("import type {")).toBe(true);
    expect(only.match(/["']([^"']+)["']$/)?.[1]).toBe("./spec.js");
    // No side-channel back into the repo, and no I/O.
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bnew Date\b/);
  });

  it("evaluate_the change_abs doc comment names it the statistic for series that can be <= 0", () => {
    const source = readFileSync(new URL("./evaluate.ts", import.meta.url), "utf8");
    const doc = source.slice(0, source.indexOf('case "change_abs"'));
    expect(doc).toMatch(/change_abs[\s\S]{0,600}<= 0/);
  });

  it("evaluate_MS_PER_DAY is exported and is the millisecond day the window arithmetic uses", () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
