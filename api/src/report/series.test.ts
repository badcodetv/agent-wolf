import { describe, expect, it } from "vitest";
import type { Metric, Spec } from "../hypothesis/spec.js";
import type { Point } from "../hypothesis/evaluate.js";
import {
  buildSeriesPayload,
  downsampleLTTB,
  serialiseSeriesPayload,
  type SeriesByMetric,
} from "./series.js";

// design/2026-08-20-agent-wolf.md § W18 ("Series selection and injection
// payload"), graded by its acceptance criteria. Every `it` name begins with
// `series_` so a later `-t series_` filter can address the whole file.

/* ------------------------------------------------------------------ */
/* fixture builders                                                    */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;
/** 2026-01-01T00:00:00Z. Nothing here parses a date; this is just a fixed integer. */
const T0 = 1_767_225_600_000;

function p(day: number, v: number): Point {
  return { tMs: T0 + day * DAY, v };
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

/** Minimal spec: only `metrics` is read by this module, but the full shape
 *  is built anyway so a reader does not have to wonder what was elided. */
function spec(metrics: Metric[]): Spec {
  return {
    thesis: "a thesis",
    horizon_days: 180,
    flat_band_pct: 2,
    staleness_days: 5,
    metrics,
    invalidation: [
      {
        id: "cond",
        metric: metrics[0]?.slug ?? "m",
        stat: "level",
        op: "lt",
        threshold: 0,
        sustained_days: 0,
        meaning: "placeholder",
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* criterion 1 — only metrics named in the locked spec are injected    */
/* ------------------------------------------------------------------ */

describe("buildSeriesPayload — spec is the only source of truth for which metrics appear", () => {
  it("series_extra_project_dataset_is_absent_from_payload", () => {
    const s = spec([metric("included")]);
    const seriesByMetric: SeriesByMetric = {
      included: { points: [p(0, 1), p(1, 2)], version: 3 },
      // Present in the "project" (i.e. the caller's fetched map) but named
      // by no metric in the locked spec — must never reach the payload.
      "not-in-spec": { points: [p(0, 99)], version: 1 },
    };

    const payload = buildSeriesPayload(s, seriesByMetric, 100);

    expect(Object.keys(payload)).toEqual(["included"]);
    expect(payload["not-in-spec"]).toBeUndefined();
    expect(payload.included).toEqual({
      unit: "index",
      version: 3,
      points: [p(0, 1), p(1, 2)],
    });
  });

  it("series_empty_spec_metrics_yields_empty_payload_even_with_datasets_present", () => {
    const s = spec([]);
    const seriesByMetric: SeriesByMetric = {
      orphan: { points: [p(0, 1)], version: 1 },
    };

    expect(buildSeriesPayload(s, seriesByMetric, 100)).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* criterion 2 — the downsampler keeps the first and last points        */
/* ------------------------------------------------------------------ */

describe("downsampleLTTB — first and last points always survive", () => {
  it("series_last_point_outlier_survives_downsampling", () => {
    // 100 gently-rising points, then a sharp spike on the very last one —
    // the exact move a hypothesis's invalidation condition would be about.
    const points: Point[] = [];
    for (let day = 0; day < 99; day++) points.push(p(day, 100 + day * 0.1));
    const lastPoint = p(99, 5000); // the outlier
    points.push(lastPoint);

    const out = downsampleLTTB(points, 10);

    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(lastPoint);
  });

  it("series_first_point_always_survives_too", () => {
    const points: Point[] = [];
    for (let day = 0; day < 500; day++) points.push(p(day, Math.sin(day) * 100));
    const firstPoint = points[0];

    const out = downsampleLTTB(points, 20);

    expect(out[0]).toEqual(firstPoint);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("series_caps_at_maxPoints_when_input_is_larger", () => {
    const points: Point[] = [];
    for (let day = 0; day < 1000; day++) points.push(p(day, day));
    expect(downsampleLTTB(points, 50).length).toBe(50);
  });

  it("series_returns_input_unchanged_when_within_budget", () => {
    const points = [p(0, 1), p(1, 2), p(2, 3)];
    expect(downsampleLTTB(points, 100)).toEqual(points);
  });

  it("series_output_stays_ascending_by_tMs", () => {
    const points: Point[] = [];
    for (let day = 0; day < 300; day++) points.push(p(day, Math.random() * 1000));
    const out = downsampleLTTB(points, 15);
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1];
      const cur = out[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      if (prev && cur) expect(cur.tMs).toBeGreaterThan(prev.tMs);
    }
  });

  it("series_empty_input_yields_empty_output", () => {
    expect(downsampleLTTB([], 10)).toEqual([]);
  });

  it("series_single_point_input_is_returned_as_is", () => {
    const only = p(0, 42);
    expect(downsampleLTTB([only], 10)).toEqual([only]);
  });

  it("series_maxPoints_below_two_still_keeps_both_anchors", () => {
    const points: Point[] = [];
    for (let day = 0; day < 20; day++) points.push(p(day, day));
    const out = downsampleLTTB(points, 1);
    // Cannot satisfy "at most 1" AND "first and last both survive" at once;
    // keeping both anchors wins, so the output is exactly the two anchors.
    expect(out).toEqual([points[0], points[points.length - 1]]);
  });

  it("series_buildSeriesPayload_downsamples_per_metric_using_maxPoints", () => {
    const s = spec([metric("m")]);
    const points: Point[] = [];
    for (let day = 0; day < 200; day++) points.push(p(day, day));
    const seriesByMetric: SeriesByMetric = { m: { points, version: 9 } };

    const payload = buildSeriesPayload(s, seriesByMetric, 25);

    expect(payload.m?.points.length).toBeLessThanOrEqual(25);
    expect(payload.m?.points[0]).toEqual(points[0]);
    expect(payload.m?.points[payload.m.points.length - 1]).toEqual(points[points.length - 1]);
    expect(payload.m?.version).toBe(9);
  });
});

/* ------------------------------------------------------------------ */
/* criterion 3 — a missing dataset appears with empty arrays, version 0 */
/* ------------------------------------------------------------------ */

describe("buildSeriesPayload — a metric with no dataset is present, never absent", () => {
  it("series_missing_dataset_key_yields_empty_points_and_version_zero", () => {
    const s = spec([metric("has-data"), metric("never-written", { unit: "USD" })]);
    const seriesByMetric: SeriesByMetric = {
      "has-data": { points: [p(0, 1)], version: 2 },
      // "never-written" has no key at all.
    };

    const payload = buildSeriesPayload(s, seriesByMetric, 100);

    expect(Object.keys(payload).sort()).toEqual(["has-data", "never-written"]);
    expect(payload["never-written"]).toEqual({ unit: "USD", version: 0, points: [] });
  });

  it("series_explicit_null_dataset_is_treated_as_missing_too", () => {
    // Matches the spec's own "explicit null means absent" convention
    // (§ Vocabulary, R62) — a caller that round-trips through JSON may well
    // produce an explicit null rather than an omitted key.
    const s = spec([metric("m", { unit: "pct" })]);
    const seriesByMetric: SeriesByMetric = { m: null };

    const payload = buildSeriesPayload(s, seriesByMetric, 100);

    expect(payload.m).toEqual({ unit: "pct", version: 0, points: [] });
  });

  it("series_all_spec_metrics_are_keys_regardless_of_dataset_presence", () => {
    const s = spec([metric("a"), metric("b"), metric("c")]);
    const payload = buildSeriesPayload(s, {}, 100);

    expect(Object.prototype.hasOwnProperty.call(payload, "a")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload, "b")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload, "c")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* criterion 4 — JSON-serialisable, no undefined, </script> escaped     */
/* ------------------------------------------------------------------ */

describe("payload safety — JSON-serialisable, no undefined, </script> escaped", () => {
  it("series_payload_round_trips_with_no_undefined_anywhere", () => {
    const s = spec([metric("present-metric"), metric("absent-metric")]);
    const seriesByMetric: SeriesByMetric = {
      "present-metric": { points: [p(0, 1), p(1, 2)], version: 4 },
    };

    const payload = buildSeriesPayload(s, seriesByMetric, 100);
    const json = JSON.stringify(payload);

    expect(json.includes("undefined")).toBe(false);
    expect(JSON.parse(json)).toEqual(payload);
  });

  it("series_plain_JSON_stringify_does_NOT_escape_closing_script_tag", () => {
    // Documents exactly why serialiseSeriesPayload exists: the naive path
    // is unsafe, verified directly rather than assumed.
    expect(JSON.stringify("</script>")).toBe('"</script>"');
  });

  it("series_serialiseSeriesPayload_escapes_closing_script_tag_in_unit", () => {
    const s = spec([metric("hostile", { unit: '</script><script>alert(1)</script>' })]);
    const payload = buildSeriesPayload(s, {}, 100);

    const injectable = serialiseSeriesPayload(payload);

    expect(injectable.toLowerCase().includes("</script")).toBe(false);
    // The escape is meaning-preserving: parsing it back recovers the
    // original hostile string byte-for-byte, proving nothing was corrupted
    // or dropped, only made HTML-tokenizer-safe.
    // `<\/script` is a JS string escape for `/`, so JSON.parse on the raw
    // text (not a <script>-embedded context) already round-trips.
    expect(JSON.parse(injectable)).toEqual(payload);
    expect(payload.hostile?.unit).toBe('</script><script>alert(1)</script>');
  });

  it("series_escapes_mixed_case_and_multiple_occurrences", () => {
    const s = spec([metric("m", { unit: "a</SCRIPT>b</Script>c" })]);
    const payload = buildSeriesPayload(s, {}, 100);

    const injectable = serialiseSeriesPayload(payload);

    expect(injectable.toLowerCase().includes("</script")).toBe(false);
    expect(JSON.parse(injectable)).toEqual(payload);
  });

  it("series_serialiseSeriesPayload_is_valid_JSON_for_clean_input", () => {
    const s = spec([metric("clean")]);
    const seriesByMetric: SeriesByMetric = { clean: { points: [p(0, 1)], version: 1 } };
    const payload = buildSeriesPayload(s, seriesByMetric, 100);

    expect(() => JSON.parse(serialiseSeriesPayload(payload))).not.toThrow();
    expect(JSON.parse(serialiseSeriesPayload(payload))).toEqual(payload);
  });
});

/* ------------------------------------------------------------------ */
/* tMs field name and unit                                             */
/* ------------------------------------------------------------------ */

describe("timestamps are epoch milliseconds in a field named tMs", () => {
  it("series_points_carry_tMs_not_t_or_timestamp", () => {
    const s = spec([metric("m")]);
    const seriesByMetric: SeriesByMetric = { m: { points: [p(0, 1)], version: 1 } };
    const payload = buildSeriesPayload(s, seriesByMetric, 100);

    const point = payload.m?.points[0];
    expect(point).toBeDefined();
    expect(point).toHaveProperty("tMs");
    expect(point).not.toHaveProperty("t");
    expect(point).not.toHaveProperty("timestamp");
    expect(point?.tMs).toBe(T0);
  });
});
