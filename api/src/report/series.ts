/**
 * Series selection and injection payload for the report frame.
 *
 * design/2026-08-20-agent-wolf.md § W18 ("Series selection and injection
 * payload") is the ticket; § "Shared shapes" pins `Point = { tMs, v }` and
 * names the report frame as one of its importers, so `Point` is imported
 * from `../hypothesis/evaluate.js` (W4's home for it, which every downstream
 * ticket is told to import from rather than redeclare) instead of being
 * declared a second time here.
 *
 * `buildSeriesPayload` is PURE: no I/O, no dataset fetch, no HTTP, no clock
 * read. W21's report route is the one that walks the spec's metrics, fetches
 * each one's dataset through the dataset read path, parses the canonical CSV
 * into `Point[]`, and hands the result in here keyed by metric slug — this
 * module only chooses, downsamples and shapes what it is given.
 *
 * Two invariants the frame's locked template depends on, and cannot be
 * amended to defend against on its own:
 *
 *  - **Only metrics the LOCKED SPEC names are ever injected.** A dataset
 *    present in the project but absent from the spec (an old metric, a typo,
 *    an abandoned experiment) must never reach the frame.
 *  - **Every spec metric appears in the output**, even when its dataset has
 *    never been written — `{ unit, version: 0, points: [] }` — because an
 *    absent key throws inside the template's chart code, and the template
 *    cannot be fixed without a human amendment cycle just to tolerate day
 *    one.
 */

import { present } from "../hypothesis/spec.js";
import type { Spec } from "../hypothesis/spec.js";
import type { Point } from "../hypothesis/evaluate.js";

/**
 * What the caller already fetched and parsed for one metric, keyed by slug.
 * `points` is trusted to already be ascending by `tMs` — this module never
 * re-sorts, matching W4's `evaluate()` convention for the same reason: a
 * caller-side ordering bug should fail loudly there, not be silently papered
 * over here.
 */
export interface SeriesInput {
  points: Point[];
  /** The dataset's current version, so the frame route can gate a re-render on it (W21). */
  version: number;
}

/**
 * `seriesByMetric[slug]` is `undefined`, or explicit `null`, when the
 * metric's dataset has never been written — matching the spec's own
 * "explicit `null` means absent" convention (§ Vocabulary, R62). That is why
 * presence is decided with W3's `present()` rather than a bare
 * `!== undefined` check: a caller that mirrors the spec-null convention here
 * (say, because it round-tripped a payload through JSON) still resolves to
 * "absent", not to a crash on `input.points`.
 */
export type SeriesByMetric = Record<string, SeriesInput | null | undefined>;

export interface SeriesMetricPayload {
  unit: string;
  version: number;
  points: Point[];
}

/**
 * Keyed by metric slug — the exact shape `window.__WOLF_SERIES__` carries
 * once W19 injects it (§ W25's `report-authoring.md` contract).
 */
export type SeriesPayload = Record<string, SeriesMetricPayload>;

/* ------------------------------------------------------------------ */
/* downsampling — largest-triangle-three-buckets                       */
/* ------------------------------------------------------------------ */

/**
 * Indexes with a thrown error rather than a silent `undefined` on an
 * out-of-bounds access — every call site below computes `i` from the
 * algorithm's own loop bounds, so a throw here means an invariant broke,
 * not that the input was unusual. `noUncheckedIndexedAccess` requires the
 * narrowing either way.
 */
function at(points: readonly Point[], i: number): Point {
  const point = points[i];
  if (point === undefined) {
    throw new Error(`series.ts: downsampleLTTB index ${i} out of bounds (length ${points.length})`);
  }
  return point;
}

/**
 * Largest-triangle-three-buckets. Keeps at most `maxPoints` points and
 * ALWAYS keeps the first and last input point, unconditionally — the
 * classic LTTB shape, and the property this ticket's acceptance criteria
 * pin explicitly: a downsampler that drops the newest point hides the exact
 * move the hypothesis is about.
 *
 * `maxPoints` below 2 cannot both cap the output at `maxPoints` AND keep two
 * distinct anchor points, so keeping both anchors wins: the output is then
 * exactly 2 points (or 1, if the whole series is a single point), over the
 * requested cap. Non-finite or fractional `maxPoints` is floored and clamped
 * to at least 2 for the same reason.
 */
export function downsampleLTTB(points: readonly Point[], maxPoints: number): Point[] {
  const n = points.length;
  if (n === 0) return [];

  const threshold = Math.max(2, Math.floor(maxPoints));
  if (n <= 2 || n <= threshold) return points.slice();

  const sampled: Point[] = [at(points, 0)];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0; // index of the previously-selected point

  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgRangeLength = avgRangeEnd - avgRangeStart;

    let avgX = 0;
    let avgY = 0;
    if (avgRangeLength > 0) {
      for (let j = avgRangeStart; j < avgRangeEnd; j++) {
        const point = at(points, j);
        avgX += point.tMs;
        avgY += point.v;
      }
      avgX /= avgRangeLength;
      avgY /= avgRangeLength;
    } else {
      // The trailing average bucket can run off the end of the series for
      // the last iteration; fall back to the last point rather than divide
      // by zero into NaN.
      const last = at(points, n - 1);
      avgX = last.tMs;
      avgY = last.v;
    }

    const pointA = at(points, a);

    let maxArea = -1;
    let maxAreaIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const point = at(points, j);
      const area =
        Math.abs(
          (pointA.tMs - avgX) * (point.v - pointA.v) - (pointA.tMs - point.tMs) * (avgY - pointA.v),
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled.push(at(points, maxAreaIndex));
    a = maxAreaIndex;
  }

  sampled.push(at(points, n - 1));
  return sampled;
}

/* ------------------------------------------------------------------ */
/* payload shaping                                                     */
/* ------------------------------------------------------------------ */

/**
 * Chooses metrics — from the locked spec, and ONLY the locked spec —
 * downsamples each present series to at most `maxPoints`, and shapes the
 * per-metric payload the frame injects. A metric named by the spec but
 * missing from `seriesByMetric` (dataset never written) still appears, with
 * `version: 0` and empty `points`, never absent.
 */
export function buildSeriesPayload(
  spec: Spec,
  seriesByMetric: SeriesByMetric,
  maxPoints: number,
): SeriesPayload {
  const payload: SeriesPayload = {};

  for (const metric of spec.metrics) {
    if (present(seriesByMetric, metric.slug)) {
      // `present()` has proven the slug is an OWN key of `seriesByMetric`
      // whose value is neither `undefined` nor an explicit `null`; the cast
      // reflects that runtime fact rather than re-deriving it under
      // `noUncheckedIndexedAccess`.
      //
      // ⚠️ **The own-key half is not decoration, and this comment used to
      // omit it — which made it false for exactly the keys that broke.**
      // Until 2026-08-26 `present()` read the property straight off the
      // record, so it walked the prototype chain: a metric slug of
      // `constructor`, `hasOwnProperty`, `isPrototypeOf`,
      // `propertyIsEnumerable`, `toString`, `valueOf` or `toLocaleString`
      // (all seven are legal under `LABEL_VALUE_PATTERN`) took THIS branch
      // with no dataset written, and this cast — which typecheck cannot
      // question — carried an inherited function into `input.points`, where
      // `downsampleLTTB` threw. The metric slug is chosen by a model and
      // frozen by the locked spec, so it would have thrown on every request
      // for that hypothesis, permanently. Fixed in `present()` itself.
      const input = seriesByMetric[metric.slug] as SeriesInput;
      payload[metric.slug] = {
        unit: metric.unit,
        version: input.version,
        points: downsampleLTTB(input.points, maxPoints),
      };
    } else {
      payload[metric.slug] = { unit: metric.unit, version: 0, points: [] };
    }
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* injection-safe serialisation                                        */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` alone is NOT injection-safe: it does not escape `/`, so a
 * series `unit` containing the literal string `</script` survives into the
 * JSON text unchanged — `JSON.stringify("</script>")` really does return the
 * eight characters `"</script>"` verbatim — and once that text is embedded
 * inside an actual `<script>` element (W19's job), the HTML tokenizer ends
 * the element right there, before the rest of the JSON (or the document)
 * parses as intended.
 *
 * This escapes every case-insensitive occurrence of `</script` to `<\/script`.
 * Inside a JSON string's value, `\/` is a legal, meaning-preserving escape
 * (it decodes back to `/`), so the payload round-trips through `JSON.parse`
 * unchanged; but the three characters `</s` an HTML tokenizer looks for to
 * end the element are no longer adjacent in the source text, so the element
 * cannot be closed early.
 */
export function serialiseSeriesPayload(payload: SeriesPayload): string {
  return JSON.stringify(payload).replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`);
}
