/**
 * The hypothesis spec: its types, its zod schemas and `validateSpec` — the
 * SOLE gate on go-live.
 *
 * See design/2026-08-20-agent-wolf.md § W3 ("The graded rule set", rules
 * V1–V27), § Interfaces "Spec JSON (W3)" and § "Condition semantics"
 * ("The condition object").
 *
 * `validateSpec` is pure: no I/O, no clock read, no network. It never throws
 * for invalid input — three tickets need the error list without a 500 — and
 * it returns EVERY error at once, each naming its JSON path.
 *
 * `Spec`, `Metric`, `Method` and `Condition` are exported from here and every
 * later ticket imports them rather than redeclaring.
 */

import { z } from "zod";
import { WolfError, type WolfErrorKind } from "../errors.js";
import { SERIES_SOURCES } from "../marketdata/sources.js";

/* ------------------------------------------------------------------ */
/* enums and constants                                                 */
/* ------------------------------------------------------------------ */

/**
 * V9 — the only providers that exist (§ Out of Scope).
 *
 * DERIVED from `marketdata/sources.ts` — the fetchable providers plus
 * `derived`, which is what this list always meant. It used to be written
 * out by hand, which is how a third hand-written copy of the same list (in
 * `mcp/seriesdownload.ts`) got missed when `yahoo` was added; read that
 * module's header before adding a provider.
 *
 * `yahoo` was added 2026-09-07: `stooq` is dead (it answers every request
 * with a browser-verification page — see marketdata/guard.ts) and FRED has
 * no daily gold series, so without it a hard-asset thesis had no price
 * source. `stooq` is KEPT rather than removed: specs already locked with a
 * stooq metric must stay valid, and the connector now fails loudly instead
 * of inventing data.
 */
export const METRIC_SOURCES = [...SERIES_SOURCES, "derived"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** V10 — the enum § "The support score" reads. */
export const DIRECTIONS = ["up", "down", "flat"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** V18 — the five statistics of § "Condition semantics". */
export const STATS = ["level", "change_abs", "change_pct", "drawdown_pct", "ratio_to"] as const;
export type Stat = (typeof STATS)[number];

/** V19 */
export const OPS = ["gt", "gte", "lt", "lte"] as const;
export type Op = (typeof OPS)[number];

/** V21 */
export const REFERENCES = ["peak_since_live", "value_at_live", "trailing_n_days"] as const;
export type Reference = (typeof REFERENCES)[number];

/** V21 — the statistics for which `reference` is FORBIDDEN rather than required. */
export const REFERENCE_FREE_STATS: readonly Stat[] = ["level", "ratio_to"];

/**
 * V8 — the dataset name is `<hyp-id>-<slug>` and label values are capped at
 * 63 characters, so 63 − len("hyp-") − 8 − 1 = 50 is the real ceiling. A
 * 63-character slug would validate here and then fail `dataset_put` on every
 * tick forever.
 */
export const MAX_SLUG_LENGTH = 50;

/** V8 — the Kubernetes label-value charset (go/agentdb/labels.go:22-33). */
export const LABEL_VALUE_PATTERN = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

/** V16 — kebab, lowercase alphanumeric segments. */
export const CONDITION_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** V13 */
export const WEIGHT_SUM = 1.0;
export const WEIGHT_SUM_TOLERANCE = 0.001;

/** V27 — at or above this weight a metric must be named by a condition. */
export const HEAVY_METRIC_WEIGHT = 0.25;

/** V3 / V4 — the spec-level defaults. */
export const DEFAULT_FLAT_BAND_PCT = 2.0;
export const DEFAULT_STALENESS_DAYS = 5;

/* ------------------------------------------------------------------ */
/* the types every later ticket imports                                */
/* ------------------------------------------------------------------ */

/** V15 — how a `derived` metric is pinned, so the critic cannot silently redefine it. */
export interface Method {
  description: string;
  formula: string;
  constituents?: string[];
  source_series?: string[];
}

export interface Metric {
  slug: string;
  source: MetricSource;
  /** Required for `fred`/`stooq` (V14); forbidden for `derived` (V15). */
  series_id?: string;
  direction: Direction;
  weight: number;
  unit: string;
  /** Required for `derived` (V15). */
  method?: Method;
}

export interface Condition {
  id: string;
  metric: string;
  stat: Stat;
  /** Present iff `stat === "ratio_to"` (V23). */
  ratio_metric?: string;
  /** Present iff `stat === "ratio_to"` (V24). */
  ratio_lookback_days?: number;
  /** Forbidden for `level`/`ratio_to`, required otherwise (V21). */
  reference?: Reference;
  /** Present iff `reference === "trailing_n_days"` (V22). */
  reference_days?: number;
  op: Op;
  threshold: number;
  sustained_days: number;
  meaning: string;
}

export interface Spec {
  thesis: string;
  horizon_days: number;
  flat_band_pct: number;
  staleness_days: number;
  metrics: Metric[];
  invalidation: Condition[];
}

/**
 * W4's `evaluate` names its first argument `HypothesisSpec`. Same type; this
 * alias exists so the two tickets cannot diverge into two shapes.
 */
export type HypothesisSpec = Spec;

/** The `{path, message}` shape W9 returns in its 422 and W8 embeds as `spec_validation`. */
export interface SpecError {
  path: string;
  message: string;
}

export type ValidateSpecResult =
  | { valid: true; spec: Spec }
  | { valid: false; errors: SpecError[] };

/* ------------------------------------------------------------------ */
/* the strict zod schemas                                              */
/* ------------------------------------------------------------------ */

/**
 * `null` is treated as "absent" throughout. § "The condition object" prints
 * its optional fields as explicit `null` placeholders (`"ratio_metric": null`),
 * and W3's fixture transcribes that block verbatim, so the "present iff"
 * rules must read an explicit `null` as absence or the plan's own worked
 * example would not validate.
 */
function absentOr<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish();
}

/** Optional with a spec-level default; `null` and absent both take the default. */
function defaulting<T extends z.ZodTypeAny>(schema: T, fallback: number) {
  return schema.nullish().transform((v) => (v === undefined || v === null ? fallback : v));
}

const MethodSchema = z.strictObject({
  description: z.string().min(1),
  formula: z.string().min(1),
  constituents: absentOr(z.array(z.string())),
  source_series: absentOr(z.array(z.string())),
});

const MetricSchema = z.strictObject({
  slug: z.string().min(1).max(MAX_SLUG_LENGTH).regex(LABEL_VALUE_PATTERN),
  source: z.enum(METRIC_SOURCES),
  series_id: absentOr(z.string()),
  direction: z.enum(DIRECTIONS),
  weight: z.number().gt(0).lte(1),
  unit: z.string().min(1),
  method: absentOr(MethodSchema),
});

const ConditionSchema = z.strictObject({
  id: z.string().min(1).regex(CONDITION_ID_PATTERN),
  metric: z.string().min(1),
  stat: z.enum(STATS),
  ratio_metric: absentOr(z.string().min(1)),
  ratio_lookback_days: absentOr(z.number().int().gte(1).lte(400)),
  reference: absentOr(z.enum(REFERENCES)),
  reference_days: absentOr(z.number().int().gte(2).lte(365)),
  op: z.enum(OPS),
  // z.number() already rejects NaN and Infinity, which is V20's "finite".
  threshold: z.number(),
  sustained_days: z.number().int().gte(0).lte(365),
  meaning: z.string().min(1),
});

const SpecSchema = z.strictObject({
  thesis: z.string().min(1),
  horizon_days: z.number().int().gte(7).lte(3650),
  flat_band_pct: defaulting(z.number().gte(0).lte(50), DEFAULT_FLAT_BAND_PCT),
  staleness_days: defaulting(z.number().gte(1).lte(90), DEFAULT_STALENESS_DAYS),
  metrics: z.array(MetricSchema).min(1),
  invalidation: z.array(ConditionSchema).min(1),
});

/* ------------------------------------------------------------------ */
/* paths and issue mapping                                             */
/* ------------------------------------------------------------------ */

/** `["metrics", 1, "weight"]` -> `"metrics[1].weight"`; the root is `""`. */
export function formatSpecPath(segments: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function issuesToErrors(issues: readonly z.core.$ZodIssue[]): SpecError[] {
  const errors: SpecError[] = [];
  for (const issue of issues) {
    const path = issue.path ?? [];
    if (issue.code === "unrecognized_keys") {
      // zod folds every surplus key of one object into a single issue whose
      // path is the CONTAINER. V7 requires each error to name its own JSON
      // path, so fan it back out one error per key.
      for (const key of issue.keys) {
        errors.push({
          path: formatSpecPath([...path, key]),
          message: `unrecognized key "${key}"; the spec is strict at every level (V7)`,
        });
      }
      continue;
    }
    errors.push({ path: formatSpecPath(path), message: issue.message });
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* the semantic pass                                                   */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * "This key is present and not explicitly null" — the § Vocabulary rule (R62)
 * that an explicit `null` and an omitted key are the same thing.
 *
 * ⚠️ **`Object.hasOwn` first, and it is load-bearing.** A bare `record[key]`
 * walks the prototype chain, and `LABEL_VALUE_PATTERN` — which is what
 * constrains a metric slug — accepts `[A-Za-z0-9]`, so it is not only
 * `constructor` that gets through. Measured, 2026-08-26: **seven**
 * `Object.prototype` keys are slug-legal AND made this function return `true`
 * for the empty record — `constructor`, `hasOwnProperty`, `isPrototypeOf`,
 * `propertyIsEnumerable`, `toString`, `valueOf` and `toLocaleString`.
 *
 * The live consequence was at W18's `buildSeriesPayload`, the one call site
 * whose key is chosen by a model: a spec metric with any of those slugs and
 * NO dataset written took the present branch instead of the missing-dataset
 * branch and threw `TypeError: Cannot read properties of undefined (reading
 * 'length')` — falsifying W18's own criterion that a metric whose dataset is
 * missing "appears with empty arrays and `version: 0`, never absent". Once
 * the spec is locked, the frame route then 500s on every request for that
 * hypothesis until a human amendment renames the metric.
 *
 * Fixed HERE rather than at the call site: the other call sites all pass
 * fixed string literals today and are unaffected, but "the key is a literal"
 * is a property of each caller, not of this function, and the next caller to
 * pass a model-chosen key would re-open it.
 */
export function present(record: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(record, key)) return false;
  const v = record[key];
  return v !== undefined && v !== null;
}

/**
 * The cross-field and cross-object rules — V8 (uniqueness), V13, V14, V15,
 * V16 (uniqueness), V17, V21, V22, V23, V24 and V27.
 *
 * These run against the RAW input rather than against zod's output, because
 * zod skips a `superRefine` whenever the base parse produced any issue at all
 * (verified against zod 4.4.3), and the acceptance criteria require every
 * error at once. Each check guards its own types, so a structurally broken
 * field is simply skipped here and reported by the zod pass instead.
 */
function semanticErrors(input: unknown): SpecError[] {
  const errors: SpecError[] = [];
  const spec = asRecord(input);
  if (!spec) return errors;

  const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
  const conditions = Array.isArray(spec.invalidation) ? spec.invalidation : [];

  const knownSlugs = new Set<string>();
  for (const raw of metrics) {
    const metric = asRecord(raw);
    if (metric && typeof metric.slug === "string") knownSlugs.add(metric.slug);
  }

  // --- metrics -----------------------------------------------------
  const seenSlugs = new Set<string>();
  metrics.forEach((raw, i) => {
    const metric = asRecord(raw);
    if (!metric) return;
    const at = `metrics[${i}]`;

    if (typeof metric.slug === "string") {
      if (seenSlugs.has(metric.slug)) {
        errors.push({
          path: `${at}.slug`,
          message: `duplicate metric slug "${metric.slug}"; slugs must be unique within the spec (V8)`,
        });
      }
      seenSlugs.add(metric.slug);
    }

    const source = metric.source;
    const seriesId = metric.series_id;
    if (source === "derived") {
      if (present(metric, "series_id")) {
        errors.push({
          path: `${at}.series_id`,
          message: 'a "derived" metric must not carry series_id (V15)',
        });
      }
      if (!asRecord(metric.method)) {
        errors.push({
          path: `${at}.method`,
          message:
            'a "derived" metric requires method, with a non-empty description and a non-empty formula (V15)',
        });
      }
    } else if ((SERIES_SOURCES as readonly string[]).includes(source as string)) {
      // Was `source === "fred" || source === "stooq"` — a FOURTH hand-written
      // copy of the provider list, and it silently excluded `yahoo`: a yahoo
      // metric with no series_id validated, went live, and left the daily
      // researcher with nothing to fetch. Derived from SERIES_SOURCES now, so
      // "a fetchable source needs a series id" is the rule rather than a list
      // of names. See marketdata/sources.ts and R266.
      if (typeof seriesId !== "string" || seriesId.length === 0) {
        errors.push({
          path: `${at}.series_id`,
          message: `a "${source}" metric requires a non-empty series_id (V14)`,
        });
      }
    }
  });

  // V13 — weights sum to 1.0 ± 0.001. Only checked once every weight is a
  // number, so a non-numeric weight is reported once (by zod) and not twice.
  const weights = metrics
    .map((raw) => asRecord(raw)?.weight)
    .filter((w): w is number => typeof w === "number" && Number.isFinite(w));
  if (metrics.length > 0 && weights.length === metrics.length) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - WEIGHT_SUM) > WEIGHT_SUM_TOLERANCE) {
      errors.push({
        path: "metrics",
        message: `metric weights must sum to ${WEIGHT_SUM.toFixed(1)} ± ${WEIGHT_SUM_TOLERANCE}; they sum to ${Number(sum.toFixed(6))} (V13)`,
      });
    }
  }

  // --- conditions --------------------------------------------------
  const seenIds = new Set<string>();
  conditions.forEach((raw, i) => {
    const condition = asRecord(raw);
    if (!condition) return;
    const at = `invalidation[${i}]`;

    if (typeof condition.id === "string") {
      if (seenIds.has(condition.id)) {
        errors.push({
          path: `${at}.id`,
          message: `duplicate condition id "${condition.id}"; ids must be unique within the spec (V16)`,
        });
      }
      seenIds.add(condition.id);
    }

    if (typeof condition.metric === "string" && !knownSlugs.has(condition.metric)) {
      errors.push({
        path: `${at}.metric`,
        message: `no metric in this spec has slug "${condition.metric}" (V17)`,
      });
    }

    const stat = condition.stat;
    if (typeof stat === "string" && (STATS as readonly string[]).includes(stat)) {
      const referenceFree = (REFERENCE_FREE_STATS as readonly string[]).includes(stat);
      // V21
      if (referenceFree && present(condition, "reference")) {
        errors.push({
          path: `${at}.reference`,
          message: `a "${stat}" condition must not carry reference (V21)`,
        });
      }
      if (!referenceFree && !present(condition, "reference")) {
        errors.push({
          path: `${at}.reference`,
          message: `a "${stat}" condition requires reference (V21)`,
        });
      }
      // V23 / V24
      if (stat === "ratio_to") {
        if (!present(condition, "ratio_metric")) {
          errors.push({
            path: `${at}.ratio_metric`,
            message: 'a "ratio_to" condition requires ratio_metric (V23)',
          });
        }
        if (!present(condition, "ratio_lookback_days")) {
          errors.push({
            path: `${at}.ratio_lookback_days`,
            message:
              'a "ratio_to" condition requires ratio_lookback_days; set it to at least twice the coarser series’ period (V24)',
          });
        }
      } else {
        if (present(condition, "ratio_metric")) {
          errors.push({
            path: `${at}.ratio_metric`,
            message: `ratio_metric is only allowed on a "ratio_to" condition, not on "${stat}" (V23)`,
          });
        }
        if (present(condition, "ratio_lookback_days")) {
          errors.push({
            path: `${at}.ratio_lookback_days`,
            message: `ratio_lookback_days is only allowed on a "ratio_to" condition, not on "${stat}" (V24)`,
          });
        }
      }
    }

    // V23 — and it must name a metric in this spec.
    if (typeof condition.ratio_metric === "string" && !knownSlugs.has(condition.ratio_metric)) {
      errors.push({
        path: `${at}.ratio_metric`,
        message: `no metric in this spec has slug "${condition.ratio_metric}" (V23)`,
      });
    }

    // V22
    const trailing = condition.reference === "trailing_n_days";
    if (trailing && !present(condition, "reference_days")) {
      errors.push({
        path: `${at}.reference_days`,
        message: 'reference_days is required when reference is "trailing_n_days" (V22)',
      });
    }
    if (!trailing && present(condition, "reference_days")) {
      errors.push({
        path: `${at}.reference_days`,
        message:
          'reference_days is only allowed when reference is "trailing_n_days" (V22)',
      });
    }
  });

  // V27 — a heavy metric that no condition names is a scoreboard with a blind
  // spot. Skipped entirely when there are no conditions, where V6 is the
  // error worth reading.
  if (conditions.length > 0) {
    const namedByCondition = new Set<string>();
    for (const raw of conditions) {
      const condition = asRecord(raw);
      if (condition && typeof condition.metric === "string") {
        namedByCondition.add(condition.metric);
      }
    }
    metrics.forEach((raw, i) => {
      const metric = asRecord(raw);
      if (!metric) return;
      const { slug, weight } = metric;
      if (typeof slug !== "string" || typeof weight !== "number") return;
      if (weight >= HEAVY_METRIC_WEIGHT && !namedByCondition.has(slug)) {
        errors.push({
          path: `metrics[${i}]`,
          message: `metric "${slug}" carries weight ${weight} (>= ${HEAVY_METRIC_WEIGHT}) but no invalidation condition names it (V27)`,
        });
      }
    });
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

type ParsedSpec = z.infer<typeof SpecSchema>;

/**
 * Drops every absent optional rather than keeping it as `null`/`undefined`,
 * so `JSON.parse(JSON.stringify(spec))` is deep-equal to `spec` — W9 writes
 * this object to a memory and W10/W14 read it back.
 */
function normalise(parsed: ParsedSpec): Spec {
  const metrics: Metric[] = parsed.metrics.map((m) => {
    const metric: Metric = {
      slug: m.slug,
      source: m.source,
      direction: m.direction,
      weight: m.weight,
      unit: m.unit,
    };
    if (m.series_id !== undefined && m.series_id !== null) metric.series_id = m.series_id;
    if (m.method !== undefined && m.method !== null) {
      const method: Method = { description: m.method.description, formula: m.method.formula };
      if (m.method.constituents !== undefined && m.method.constituents !== null) {
        method.constituents = m.method.constituents;
      }
      if (m.method.source_series !== undefined && m.method.source_series !== null) {
        method.source_series = m.method.source_series;
      }
      metric.method = method;
    }
    return metric;
  });

  const invalidation: Condition[] = parsed.invalidation.map((c) => {
    const condition: Condition = {
      id: c.id,
      metric: c.metric,
      stat: c.stat,
      op: c.op,
      threshold: c.threshold,
      sustained_days: c.sustained_days,
      meaning: c.meaning,
    };
    if (c.ratio_metric !== undefined && c.ratio_metric !== null) {
      condition.ratio_metric = c.ratio_metric;
    }
    if (c.ratio_lookback_days !== undefined && c.ratio_lookback_days !== null) {
      condition.ratio_lookback_days = c.ratio_lookback_days;
    }
    if (c.reference !== undefined && c.reference !== null) condition.reference = c.reference;
    if (c.reference_days !== undefined && c.reference_days !== null) {
      condition.reference_days = c.reference_days;
    }
    return condition;
  });

  return {
    thesis: parsed.thesis,
    horizon_days: parsed.horizon_days,
    flat_band_pct: parsed.flat_band_pct,
    staleness_days: parsed.staleness_days,
    metrics,
    invalidation,
  };
}

/* ------------------------------------------------------------------ */
/* the entry point                                                     */
/* ------------------------------------------------------------------ */

/** A spec-validation failure is always this kind; W3 adds none. */
const SPEC_ERROR_KIND: WolfErrorKind = "invalid";

/**
 * The sole gate on go-live. Non-throwing: W8 embeds the result as
 * `spec_validation`, W9 returns the errors as a 422 body and W13 renders the
 * blocking reasons before the Go Live click, and none of the three wants a
 * 500 for a caller mistake.
 */
export function validateSpec(input: unknown): ValidateSpecResult {
  const parsed = SpecSchema.safeParse(input);
  const errors: SpecError[] = [
    ...(parsed.success ? [] : issuesToErrors(parsed.error.issues)),
    ...semanticErrors(input),
  ];
  if (!parsed.success || errors.length > 0) return { valid: false, errors };
  return { valid: true, spec: normalise(parsed.data) };
}

/**
 * Wraps a `validateSpec` error list as the shared taxonomy's `invalid` kind,
 * for the routes that would rather throw than branch. No new kind is added.
 */
export function specValidationError(
  errors: SpecError[],
  message = "hypothesis spec is not valid",
): WolfError {
  return new WolfError(SPEC_ERROR_KIND, message, { details: { errors } });
}
