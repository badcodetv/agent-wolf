import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WolfError } from "../errors.js";
import {
  LABEL_VALUE_PATTERN,
  present,
  specValidationError,
  validateSpec,
  type Spec,
  type SpecError,
} from "./spec.js";

// design/2026-08-20-agent-wolf.md § W3, "The graded rule set". Every rule in
// the numbered list gets one accepting case and one rejecting case, and each
// case's name begins with its rule number so a verifier can count them.
//
// Two greps in W3's Validation block read this file directly:
//   grep -coE 'V[0-9]+ (accepts|rejects)'  ->  54
//   grep -oE '\bV[0-9]+\b' | sort -V -u    ->  V1 .. V27, no gaps
// so nothing outside the 54 `it(...)` title lines may match the first regex,
// and no rule token outside 1..27 may appear anywhere in the file.

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const WORKED_SPEC_JSON = readFileSync(
  new URL("./__fixtures__/worked-spec.json", import.meta.url),
  "utf8",
);

/** A minimal spec that satisfies every rule; each case mutates a clone. */
function base(): any {
  return {
    thesis: "drone supply chains reprice as the conflict widens",
    horizon_days: 180,
    flat_band_pct: 2.0,
    staleness_days: 5,
    metrics: [
      {
        slug: "alpha-metric",
        source: "stooq",
        series_id: "avav.us",
        direction: "up",
        weight: 0.6,
        unit: "USD",
      },
      {
        slug: "beta-metric",
        source: "fred",
        series_id: "DGS10",
        direction: "down",
        weight: 0.4,
        unit: "pct",
      },
    ],
    invalidation: [
      {
        id: "inv-1",
        metric: "alpha-metric",
        stat: "drawdown_pct",
        reference: "peak_since_live",
        op: "gt",
        threshold: 25,
        sustained_days: 30,
        meaning: "the basket is not responding to the thesis",
      },
      {
        id: "inv-2",
        metric: "beta-metric",
        stat: "level",
        op: "lt",
        threshold: 1,
        sustained_days: 0,
        meaning: "the yield collapsed",
      },
    ],
  };
}

/** `base()` with its second metric turned into a pinned `derived` metric. */
function derived(): any {
  const s = base();
  s.metrics[1] = {
    slug: "beta-metric",
    source: "derived",
    direction: "down",
    weight: 0.4,
    unit: "pct",
    method: {
      description: "share of oil trade settled in USD",
      formula: "usd_settled / total_settled * 100",
    },
  };
  return s;
}

/** One metric carrying the whole weight, with one condition naming it. */
function single(): any {
  const s = base();
  s.metrics = [s.metrics[0]];
  s.metrics[0].weight = 1.0;
  s.invalidation = [s.invalidation[0]];
  return s;
}

/** A `ratio_to` condition on `beta-metric`, so it can replace `inv-2`. */
function ratioCondition(): any {
  return {
    id: "inv-3",
    metric: "beta-metric",
    stat: "ratio_to",
    ratio_metric: "alpha-metric",
    ratio_lookback_days: 30,
    op: "gt",
    threshold: 1,
    sustained_days: 0,
    meaning: "the ratio between the two legs inverted",
  };
}

/** Every statistic once, and every operator at least once. */
function allStats(): any {
  const s = base();
  s.invalidation = [
    { id: "c-level", metric: "alpha-metric", stat: "level", op: "gt", threshold: 1, sustained_days: 0, meaning: "level" },
    { id: "c-change-abs", metric: "alpha-metric", stat: "change_abs", reference: "value_at_live", op: "gte", threshold: 1, sustained_days: 0, meaning: "abs" },
    { id: "c-change-pct", metric: "beta-metric", stat: "change_pct", reference: "peak_since_live", op: "lt", threshold: -5, sustained_days: 0, meaning: "pct" },
    { id: "c-drawdown", metric: "beta-metric", stat: "drawdown_pct", reference: "trailing_n_days", reference_days: 30, op: "lte", threshold: 10, sustained_days: 0, meaning: "dd" },
    { id: "c-ratio", metric: "alpha-metric", stat: "ratio_to", ratio_metric: "beta-metric", ratio_lookback_days: 30, op: "gt", threshold: 1, sustained_days: 0, meaning: "ratio" },
  ];
  return s;
}

/* ------------------------------------------------------------------ */
/* assertion helpers                                                   */
/* ------------------------------------------------------------------ */

function accept(input: unknown): Spec {
  const r = validateSpec(input);
  expect(r.valid ? [] : r.errors).toEqual([]);
  if (!r.valid) throw new Error("unreachable");
  return r.spec;
}

function errorsOf(input: unknown): SpecError[] {
  const r = validateSpec(input);
  expect(r.valid).toBe(false);
  return r.valid ? [] : r.errors;
}

/** Asserts the spec is rejected and that at least one error names `path`. */
function reject(input: unknown, path: string): SpecError {
  const errors = errorsOf(input);
  expect(errors.map((e) => e.path)).toContain(path);
  const hit = errors.find((e) => e.path === path)!;
  expect(hit.message.length).toBeGreaterThan(0);
  return hit;
}

/* ------------------------------------------------------------------ */
/* spec level                                                          */
/* ------------------------------------------------------------------ */

describe("validateSpec — spec level", () => {
  it("V1 accepts a non-empty thesis", () => {
    const spec = accept(base());
    expect(spec.thesis).toBe("drone supply chains reprice as the conflict widens");
  });

  it("V1 rejects an empty thesis", () => {
    reject({ ...base(), thesis: "" }, "thesis");
    reject((() => { const s = base(); delete s.thesis; return s; })(), "thesis");
  });

  it("V2 accepts horizon_days at both ends of the range", () => {
    expect(accept({ ...base(), horizon_days: 7 }).horizon_days).toBe(7);
    expect(accept({ ...base(), horizon_days: 3650 }).horizon_days).toBe(3650);
  });

  it("V2 rejects a horizon_days below the floor or not an integer", () => {
    reject({ ...base(), horizon_days: 6 }, "horizon_days");
    reject({ ...base(), horizon_days: 3651 }, "horizon_days");
    reject({ ...base(), horizon_days: 180.5 }, "horizon_days");
  });

  it("V3 accepts an absent flat_band_pct and defaults it to 2.0", () => {
    const s = base();
    delete s.flat_band_pct;
    expect(accept(s).flat_band_pct).toBe(2.0);
    expect(accept({ ...base(), flat_band_pct: 0 }).flat_band_pct).toBe(0);
    expect(accept({ ...base(), flat_band_pct: 50 }).flat_band_pct).toBe(50);
  });

  it("V3 rejects a flat_band_pct outside [0, 50]", () => {
    reject({ ...base(), flat_band_pct: -0.1 }, "flat_band_pct");
    reject({ ...base(), flat_band_pct: 50.1 }, "flat_band_pct");
  });

  it("V4 accepts an absent staleness_days and defaults it to 5", () => {
    const s = base();
    delete s.staleness_days;
    expect(accept(s).staleness_days).toBe(5);
    expect(accept({ ...base(), staleness_days: 1 }).staleness_days).toBe(1);
    expect(accept({ ...base(), staleness_days: 90 }).staleness_days).toBe(90);
  });

  it("V4 rejects a staleness_days outside [1, 90]", () => {
    reject({ ...base(), staleness_days: 0.5 }, "staleness_days");
    reject({ ...base(), staleness_days: 91 }, "staleness_days");
  });

  it("V5 accepts a spec carrying exactly one metric", () => {
    expect(accept(single()).metrics).toHaveLength(1);
  });

  it("V5 rejects a spec with no metrics", () => {
    reject({ ...base(), metrics: [] }, "metrics");
  });

  it("V6 accepts a spec carrying exactly one invalidation condition", () => {
    expect(accept(single()).invalidation).toHaveLength(1);
  });

  it("V6 rejects a spec with no invalidation conditions", () => {
    reject({ ...base(), invalidation: [] }, "invalidation");
  });

  it("V7 accepts a spec whose every level carries only known keys", () => {
    expect(accept(derived()).metrics[1]!.method!.formula).toBe(
      "usd_settled / total_settled * 100",
    );
  });

  it("V7 rejects unknown keys at spec, metric, method and condition level, each with its own path", () => {
    const s = derived();
    s.surprise = 1;
    s.metrics[0].surprise = 1;
    s.metrics[1].method.surprise = 1;
    s.invalidation[0].surprise = 1;
    const paths = errorsOf(s).map((e) => e.path);
    expect(paths).toContain("surprise");
    expect(paths).toContain("metrics[0].surprise");
    expect(paths).toContain("metrics[1].method.surprise");
    expect(paths).toContain("invalidation[0].surprise");
  });
});

/* ------------------------------------------------------------------ */
/* metric level                                                        */
/* ------------------------------------------------------------------ */

describe("validateSpec — metrics", () => {
  it("V8 accepts a unique, label-legal slug of exactly 50 characters", () => {
    const s = single();
    const slug = "a".repeat(50);
    s.metrics[0].slug = slug;
    s.invalidation[0].metric = slug;
    expect(accept(s).metrics[0]!.slug).toBe(slug);
    expect(slug).toHaveLength(50);
  });

  it("V8 rejects a 51-character slug, an illegal charset and a duplicate", () => {
    const long = single();
    long.metrics[0].slug = "a".repeat(51);
    long.invalidation[0].metric = long.metrics[0].slug;
    reject(long, "metrics[0].slug");

    const illegal = single();
    illegal.metrics[0].slug = "alpha metric@1";
    illegal.invalidation[0].metric = illegal.metrics[0].slug;
    reject(illegal, "metrics[0].slug");

    const dup = base();
    dup.metrics[1].slug = "alpha-metric";
    dup.invalidation[1].metric = "alpha-metric";
    reject(dup, "metrics[1].slug");
  });

  it("V9 accepts fred, stooq and derived sources", () => {
    const s = base();
    s.metrics[0].weight = 0.4;
    s.metrics.push({
      slug: "gamma-metric",
      source: "derived",
      direction: "flat",
      weight: 0.2,
      unit: "pct",
      method: { description: "a pinned derivation", formula: "a / b" },
    });
    const spec = accept(s);
    expect(spec.metrics.map((m) => m.source)).toEqual(["stooq", "fred", "derived"]);
  });

  it("V9 rejects a source no provider implements", () => {
    const s = base();
    s.metrics[0].source = "yahoo";
    reject(s, "metrics[0].source");
  });

  it("V10 accepts up, down and flat directions", () => {
    const s = base();
    s.metrics[0].direction = "flat";
    expect(accept(s).metrics[0]!.direction).toBe("flat");
    expect(accept(base()).metrics.map((m) => m.direction)).toEqual(["up", "down"]);
  });

  it("V10 rejects a direction outside the enum", () => {
    const s = base();
    s.metrics[0].direction = "sideways";
    reject(s, "metrics[0].direction");
  });

  it("V11 accepts a non-empty unit", () => {
    expect(accept(base()).metrics[0]!.unit).toBe("USD");
  });

  it("V11 rejects an empty or absent unit", () => {
    const empty = base();
    empty.metrics[0].unit = "";
    reject(empty, "metrics[0].unit");

    const missing = base();
    delete missing.metrics[0].unit;
    reject(missing, "metrics[0].unit");
  });

  it("V12 accepts a weight of exactly 1.0", () => {
    expect(accept(single()).metrics[0]!.weight).toBe(1.0);
  });

  it("V12 rejects a weight of zero or above one", () => {
    const zero = single();
    zero.metrics[0].weight = 0;
    reject(zero, "metrics[0].weight");

    const over = single();
    over.metrics[0].weight = 1.5;
    reject(over, "metrics[0].weight");
  });

  it("V13 accepts weights summing to 1.0 within tolerance", () => {
    accept(base());
    const s = base();
    s.metrics[0].weight = 0.5005;
    s.metrics[1].weight = 0.5;
    accept(s);
  });

  it("V13 rejects weights that do not sum to 1.0", () => {
    const s = base();
    s.metrics[1].weight = 0.3;
    const err = reject(s, "metrics");
    expect(err.message).toMatch(/sum/i);
  });

  it("V14 accepts a non-derived metric carrying a series_id", () => {
    expect(accept(base()).metrics[1]!.series_id).toBe("DGS10");
  });

  it("V14 rejects a non-derived metric with an absent or empty series_id", () => {
    const missing = base();
    delete missing.metrics[1].series_id;
    reject(missing, "metrics[1].series_id");

    const empty = base();
    empty.metrics[1].series_id = "";
    reject(empty, "metrics[1].series_id");
  });

  it("V15 accepts a derived metric with a pinned method and no series_id", () => {
    const spec = accept(derived());
    expect(spec.metrics[1]!.method?.description).toBe("share of oil trade settled in USD");
    expect(spec.metrics[1]!.series_id).toBeUndefined();
  });

  it("V15 rejects a derived metric without a method, with an empty formula, or carrying a series_id", () => {
    const noMethod = derived();
    delete noMethod.metrics[1].method;
    reject(noMethod, "metrics[1].method");

    const emptyFormula = derived();
    emptyFormula.metrics[1].method.formula = "";
    reject(emptyFormula, "metrics[1].method.formula");

    const noDescription = derived();
    delete noDescription.metrics[1].method.description;
    reject(noDescription, "metrics[1].method.description");

    const withSeries = derived();
    withSeries.metrics[1].series_id = "DGS10";
    reject(withSeries, "metrics[1].series_id");
  });
});

/* ------------------------------------------------------------------ */
/* condition level                                                     */
/* ------------------------------------------------------------------ */

describe("validateSpec — conditions", () => {
  it("V16 accepts unique kebab-case condition ids", () => {
    expect(accept(base()).invalidation.map((c) => c.id)).toEqual(["inv-1", "inv-2"]);
  });

  it("V16 rejects a duplicate id and a non-kebab id", () => {
    const dup = base();
    dup.invalidation[1].id = "inv-1";
    reject(dup, "invalidation[1].id");

    const shouty = base();
    shouty.invalidation[0].id = "Inv_1";
    reject(shouty, "invalidation[0].id");
  });

  it("V17 accepts a condition naming a metric slug in this spec", () => {
    expect(accept(base()).invalidation[0]!.metric).toBe("alpha-metric");
  });

  it("V17 rejects a condition naming a metric that does not exist", () => {
    const s = base();
    s.invalidation[0].metric = "gamma-metric";
    const err = reject(s, "invalidation[0].metric");
    expect(err.message).toContain("gamma-metric");
  });

  it("V18 accepts every statistic in the enum", () => {
    const spec = accept(allStats());
    expect(spec.invalidation.map((c) => c.stat)).toEqual([
      "level",
      "change_abs",
      "change_pct",
      "drawdown_pct",
      "ratio_to",
    ]);
  });

  it("V18 rejects a statistic outside the enum", () => {
    const s = base();
    s.invalidation[0].stat = "median";
    reject(s, "invalidation[0].stat");
  });

  it("V19 accepts every operator in the enum", () => {
    const spec = accept(allStats());
    expect(new Set(spec.invalidation.map((c) => c.op))).toEqual(
      new Set(["gt", "gte", "lt", "lte"]),
    );
  });

  it("V19 rejects an operator outside the enum", () => {
    const s = base();
    s.invalidation[0].op = "eq";
    reject(s, "invalidation[0].op");
  });

  it("V20 accepts a finite negative threshold", () => {
    const s = base();
    s.invalidation[0].threshold = -3.5;
    expect(accept(s).invalidation[0]!.threshold).toBe(-3.5);
  });

  it("V20 rejects a non-finite or non-numeric threshold", () => {
    const nan = base();
    nan.invalidation[0].threshold = Number.NaN;
    reject(nan, "invalidation[0].threshold");

    const inf = base();
    inf.invalidation[0].threshold = Number.POSITIVE_INFINITY;
    reject(inf, "invalidation[0].threshold");

    const str = base();
    str.invalidation[0].threshold = "25";
    reject(str, "invalidation[0].threshold");
  });

  it("V21 accepts a reference on a statistic that needs one and none on level or ratio_to", () => {
    const s = base();
    s.invalidation[1] = ratioCondition();
    const spec = accept(s);
    expect(spec.invalidation[0]!.reference).toBe("peak_since_live");
    expect(spec.invalidation[1]!.reference).toBeUndefined();
    expect(accept(base()).invalidation[1]!.reference).toBeUndefined();
  });

  it("V21 rejects a reference on level and a missing reference on drawdown_pct", () => {
    const onLevel = base();
    onLevel.invalidation[1].reference = "value_at_live";
    reject(onLevel, "invalidation[1].reference");

    const onRatio = base();
    onRatio.invalidation[1] = { ...ratioCondition(), reference: "value_at_live" };
    reject(onRatio, "invalidation[1].reference");

    const missing = base();
    delete missing.invalidation[0].reference;
    reject(missing, "invalidation[0].reference");

    const bogus = base();
    bogus.invalidation[0].reference = "since_forever";
    reject(bogus, "invalidation[0].reference");
  });

  it("V22 accepts reference_days exactly when the reference is trailing_n_days", () => {
    const s = base();
    s.invalidation[0].reference = "trailing_n_days";
    s.invalidation[0].reference_days = 30;
    expect(accept(s).invalidation[0]!.reference_days).toBe(30);
    expect(accept(base()).invalidation[0]!.reference_days).toBeUndefined();
  });

  it("V22 rejects a missing, surplus or out-of-range reference_days", () => {
    const missing = base();
    missing.invalidation[0].reference = "trailing_n_days";
    reject(missing, "invalidation[0].reference_days");

    const surplus = base();
    surplus.invalidation[0].reference_days = 30;
    reject(surplus, "invalidation[0].reference_days");

    const tooSmall = base();
    tooSmall.invalidation[0].reference = "trailing_n_days";
    tooSmall.invalidation[0].reference_days = 1;
    reject(tooSmall, "invalidation[0].reference_days");

    const tooBig = base();
    tooBig.invalidation[0].reference = "trailing_n_days";
    tooBig.invalidation[0].reference_days = 366;
    reject(tooBig, "invalidation[0].reference_days");
  });

  it("V23 accepts a ratio_metric exactly when the statistic is ratio_to", () => {
    const s = base();
    s.invalidation[1] = ratioCondition();
    expect(accept(s).invalidation[1]!.ratio_metric).toBe("alpha-metric");
    expect(accept(base()).invalidation[0]!.ratio_metric).toBeUndefined();
  });

  it("V23 rejects a missing, surplus or unknown ratio_metric", () => {
    const missing = base();
    missing.invalidation[1] = ratioCondition();
    delete missing.invalidation[1].ratio_metric;
    reject(missing, "invalidation[1].ratio_metric");

    const surplus = base();
    surplus.invalidation[0].ratio_metric = "beta-metric";
    reject(surplus, "invalidation[0].ratio_metric");

    const unknown = base();
    unknown.invalidation[1] = { ...ratioCondition(), ratio_metric: "gamma-metric" };
    reject(unknown, "invalidation[1].ratio_metric");
  });

  it("V24 accepts a ratio_lookback_days exactly when the statistic is ratio_to", () => {
    const s = base();
    s.invalidation[1] = ratioCondition();
    expect(accept(s).invalidation[1]!.ratio_lookback_days).toBe(30);
    expect(accept(base()).invalidation[0]!.ratio_lookback_days).toBeUndefined();
  });

  it("V24 rejects a missing, surplus or out-of-range ratio_lookback_days", () => {
    const missing = base();
    missing.invalidation[1] = ratioCondition();
    delete missing.invalidation[1].ratio_lookback_days;
    reject(missing, "invalidation[1].ratio_lookback_days");

    const surplus = base();
    surplus.invalidation[0].ratio_lookback_days = 30;
    reject(surplus, "invalidation[0].ratio_lookback_days");

    const tooBig = base();
    tooBig.invalidation[1] = { ...ratioCondition(), ratio_lookback_days: 401 };
    reject(tooBig, "invalidation[1].ratio_lookback_days");

    const tooSmall = base();
    tooSmall.invalidation[1] = { ...ratioCondition(), ratio_lookback_days: 0 };
    reject(tooSmall, "invalidation[1].ratio_lookback_days");
  });

  it("V25 accepts sustained_days at both ends of the range", () => {
    expect(accept(base()).invalidation[1]!.sustained_days).toBe(0);
    const s = base();
    s.invalidation[0].sustained_days = 365;
    expect(accept(s).invalidation[0]!.sustained_days).toBe(365);
  });

  it("V25 rejects a negative, oversized or fractional sustained_days", () => {
    const negative = base();
    negative.invalidation[0].sustained_days = -1;
    reject(negative, "invalidation[0].sustained_days");

    const tooBig = base();
    tooBig.invalidation[0].sustained_days = 366;
    reject(tooBig, "invalidation[0].sustained_days");

    const fractional = base();
    fractional.invalidation[0].sustained_days = 1.5;
    reject(fractional, "invalidation[0].sustained_days");
  });

  it("V26 accepts a non-empty meaning", () => {
    expect(accept(base()).invalidation[0]!.meaning).toBe(
      "the basket is not responding to the thesis",
    );
  });

  it("V26 rejects an empty or absent meaning", () => {
    const empty = base();
    empty.invalidation[0].meaning = "";
    reject(empty, "invalidation[0].meaning");

    const missing = base();
    delete missing.invalidation[1].meaning;
    reject(missing, "invalidation[1].meaning");
  });
});

/* ------------------------------------------------------------------ */
/* cross-cutting                                                       */
/* ------------------------------------------------------------------ */

describe("validateSpec — cross-cutting", () => {
  it("V27 accepts a light metric that no condition names", () => {
    const s = base();
    s.metrics[0].weight = 0.4;
    s.metrics.push({
      slug: "gamma-metric",
      source: "fred",
      series_id: "GDP",
      direction: "up",
      weight: 0.2,
      unit: "USD",
    });
    expect(accept(s).metrics).toHaveLength(3);
  });

  it("V27 rejects a heavy metric that no condition names", () => {
    const s = base();
    s.metrics[0].weight = 0.4;
    s.metrics[1].weight = 0.3;
    s.metrics.push({
      slug: "gamma-metric",
      source: "fred",
      series_id: "GDP",
      direction: "up",
      weight: 0.3,
      unit: "USD",
    });
    const err = reject(s, "metrics[2]");
    expect(err.message).toContain("gamma-metric");
  });
});

/* ------------------------------------------------------------------ */
/* behaviour the acceptance criteria pin beyond the rule list          */
/* ------------------------------------------------------------------ */

describe("validateSpec — reporting", () => {
  it("returns every error at once rather than only the first, each with a distinct JSON path", () => {
    const s = base();
    s.thesis = "";
    s.horizon_days = 5;
    s.metrics[0].slug = "alpha metric";
    s.metrics[1].weight = 0;
    s.invalidation[0].threshold = "twenty five";
    s.invalidation[1].meaning = "";

    const errors = errorsOf(s);
    const paths = new Set(errors.map((e) => e.path));
    for (const expected of [
      "thesis",
      "horizon_days",
      "metrics[0].slug",
      "metrics[1].weight",
      "invalidation[0].threshold",
      "invalidation[1].meaning",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths.size).toBeGreaterThanOrEqual(6);
    for (const e of errors) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.message).toBe("string");
      expect(Object.keys(e).sort()).toEqual(["message", "path"]);
    }
  });

  it("rejects a non-object input without throwing", () => {
    for (const input of [null, undefined, 42, "a spec", []]) {
      const r = validateSpec(input);
      expect(r.valid).toBe(false);
    }
  });

  it("wraps its error list in an invalid WolfError without adding a kind", () => {
    const errors = errorsOf({ ...base(), thesis: "" });
    const err = specValidationError(errors);
    expect(err).toBeInstanceOf(WolfError);
    expect(err.kind).toBe("invalid");
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ errors });
  });
});

describe("the worked-spec fixture", () => {
  it("is real JSON rather than jsonc", () => {
    expect(() => JSON.parse(WORKED_SPEC_JSON)).not.toThrow();
  });

  it("validates with zero errors", () => {
    const r = validateSpec(JSON.parse(WORKED_SPEC_JSON));
    expect(r.valid ? [] : r.errors).toEqual([]);
  });

  it("keeps every metric and spec-level value the plan printed", () => {
    const raw = JSON.parse(WORKED_SPEC_JSON);
    expect(raw.thesis).toBe("…restated tightly by the interviewer…");
    expect(raw.horizon_days).toBe(180);
    expect(raw.flat_band_pct).toBe(2.0);
    expect(raw.metrics).toEqual([
      {
        slug: "drone-suppliers-basket",
        source: "stooq",
        series_id: "avav.us",
        direction: "up",
        weight: 0.6,
        unit: "USD",
      },
      {
        slug: "petro-settlement-share",
        source: "derived",
        direction: "down",
        weight: 0.4,
        unit: "pct",
        method: {
          description: "share of oil trade settled in USD",
          formula: "usd_settled / total_settled * 100",
          constituents: ["…"],
          source_series: ["…"],
        },
      },
    ]);
  });

  it("carries the condition object the plan printed verbatim", () => {
    const raw = JSON.parse(WORKED_SPEC_JSON);
    expect(raw.invalidation[0]).toEqual({
      id: "inv-1",
      metric: "drone-suppliers-basket",
      stat: "drawdown_pct",
      ratio_metric: null,
      ratio_lookback_days: null,
      reference: "peak_since_live",
      reference_days: null,
      op: "gt",
      threshold: 25,
      sustained_days: 30,
      meaning: "the basket is not responding to the thesis",
    });
    expect(raw.invalidation[1].metric).toBe("petro-settlement-share");
  });

  it("is stable under parse -> serialise -> parse", () => {
    const first = accept(JSON.parse(WORKED_SPEC_JSON));
    const roundTripped = JSON.parse(JSON.stringify(first));
    expect(roundTripped).toStrictEqual(first);
    const second = accept(roundTripped);
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

/* ------------------------------------------------------------------ */
/* present() — own keys only                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ **Added by W19's fix round, by orchestrator ruling** — the ownership row
 * for this file was suspended for it. The rule is W3's ("explicit `null`
 * means ABSENT"), the defect was in how it was read, and the consequence was
 * in W18's `buildSeriesPayload`, which is the only caller whose key comes
 * from a model rather than from a string literal.
 *
 * MEASURED before the fix, 2026-08-26: `present()` read the property straight
 * off the record, so it walked the prototype chain and answered `true` for
 * SEVEN slug-legal keys against an EMPTY record. The list is not "just
 * `constructor`" — that is true of the slot-id pattern, which is
 * lowercase-only, but a metric slug is constrained by
 * `LABEL_VALUE_PATTERN`, which accepts `[A-Za-z0-9]` and therefore also lets
 * `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toString`,
 * `valueOf` and `toLocaleString` through.
 *
 * The list is DERIVED here rather than hard-coded, so the assertion cannot
 * quietly stop covering a key that a future runtime adds to
 * `Object.prototype`.
 */
describe("present — inherited keys are ABSENT, not present", () => {
  const inheritedSlugLegalKeys = Object.getOwnPropertyNames(Object.prototype).filter((key) =>
    LABEL_VALUE_PATTERN.test(key),
  );

  it("finds seven inherited keys that a metric slug is allowed to be named", () => {
    // Guards the case below against becoming vacuous: if this ever yields an
    // empty list, the loop under it proves nothing at all.
    expect(inheritedSlugLegalKeys).toEqual([
      "constructor",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toString",
      "valueOf",
      "toLocaleString",
    ]);
  });

  it.each(inheritedSlugLegalKeys)("answers false for the inherited key %s", (key) => {
    expect(present({}, key)).toBe(false);
    expect(present({ other: 1 }, key)).toBe(false);
  });

  it("still answers true for an own key holding a real value", () => {
    expect(present({ slug: "gold" }, "slug")).toBe(true);
    expect(present({ constructor: "gold" }, "constructor")).toBe(true);
  });

  it("still answers false for an own key that is undefined or explicitly null", () => {
    // The § Vocabulary convention this function exists for: an explicit
    // `null` and an omitted key are the same thing.
    expect(present({ slug: null }, "slug")).toBe(false);
    expect(present({ slug: undefined }, "slug")).toBe(false);
    expect(present({ constructor: null }, "constructor")).toBe(false);
  });
});
