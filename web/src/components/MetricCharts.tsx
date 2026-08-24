/**
 * The CHARTS section: one `GET /api/hypotheses/:id/series/:metric` per metric
 * in the locked spec, each rendered by `MetricChart`.
 *
 * The split is the same one `ChatRail`/`OrangeChatFrame` and
 * `ReportFrameHost`/`ReportPanel` make: this component knows how to ask, and
 * `MetricChart` knows how to draw. Only the drawing has interesting rules, and
 * keeping it free of fetching is what lets its whole suite run over fixtures.
 *
 * 🔴 **Only a LOCKED spec has series.** `GET …/series/:metric` reads the newest
 * trusted `kind=hypothesis-spec` memory itself and 404s every metric of a
 * hypothesis that has not gone live (`api/src/routes/series.ts`). Firing those
 * requests would produce a row of identical "not found" markers on every
 * draft, which says nothing true — a draft has no observations because it has
 * never run, not because something is missing. So the section says that
 * instead, and asks for nothing.
 *
 * `nowMs` is captured ONCE, when the section mounts, and handed to every
 * chart. A chart that read `Date.now()` itself would have a clock in it, and
 * ruling B is that the chart has no clock.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import MetricChart from "./MetricChart.js";
import Severity from "./trust/Severity.js";
import { ApiError, fetchSeries } from "../api/client.js";
import {
  DEFAULT_STALENESS_DAYS,
  type HypothesisDetail,
  type HypothesisSpec,
  type SeriesResponse,
  type SpecMetric,
} from "../api/types.js";

/** Shown for a hypothesis whose spec is still a candidate. */
export const NO_LOCKED_SPEC =
  "no charts yet — a hypothesis has series only once its spec is locked at go-live";

/** Shown when the locked spec somehow names no metric. */
export const NO_METRICS = "the locked spec names no metrics";

/** The spec's metrics, or `[]` for anything malformed. The wire types `spec` as `unknown`. */
export function metricsOf(spec: HypothesisSpec | null | undefined): SpecMetric[] {
  if (spec === null || spec === undefined) return [];
  return Array.isArray(spec.metrics) ? spec.metrics.filter((m) => typeof m?.slug === "string") : [];
}

export function stalenessDaysOf(spec: HypothesisSpec | null | undefined): number {
  const days = spec?.staleness_days;
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_STALENESS_DAYS;
}

interface Loaded {
  series?: SeriesResponse;
  failure?: string;
}

export interface MetricChartsProps {
  hypothesisId: string;
  spec?: HypothesisSpec | null;
  specSource: HypothesisDetail["spec_source"];
}

export default function MetricCharts({ hypothesisId, spec, specSource }: MetricChartsProps) {
  const locked = specSource === "hypothesis-spec";
  const metrics = useMemo(() => (locked ? metricsOf(spec) : []), [locked, spec]);
  // A primitive dependency for the loader below: `metrics` is a fresh array on
  // every render, so depending on it directly would refetch every series on
  // every keystroke anywhere on the page. A comma is safe as the separator —
  // a metric slug is a Kubernetes label value and cannot contain one.
  const slugs = useMemo(() => metrics.map((m) => m.slug).join(","), [metrics]);
  const stalenessDays = stalenessDaysOf(spec);

  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [nowMs, setNowMs] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const wanted = slugs === "" ? [] : slugs.split(",");
    if (wanted.length === 0) {
      setLoaded({});
      setNowMs(Date.now());
      return;
    }
    const entries = await Promise.all(
      wanted.map(async (slug): Promise<[string, Loaded]> => {
        try {
          return [slug, { series: await fetchSeries(hypothesisId, slug) }];
        } catch (err) {
          return [
            slug,
            { failure: err instanceof ApiError ? err.message : "the series could not be read" },
          ];
        }
      }),
    );
    setLoaded(Object.fromEntries(entries));
    // Captured after the reads settle, so every chart's hatched region ends at
    // the same instant rather than at whenever its own request came back.
    setNowMs(Date.now());
  }, [hypothesisId, slugs]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!locked) {
    return (
      <Typography data-testid="charts-no-spec" sx={{ fontSize: 13, color: "text.secondary" }}>
        {NO_LOCKED_SPEC}
      </Typography>
    );
  }

  if (metrics.length === 0) {
    return (
      <Typography data-testid="charts-no-metrics" sx={{ fontSize: 13, color: "text.secondary" }}>
        {NO_METRICS}
      </Typography>
    );
  }

  if (nowMs === null) {
    return <Skeleton data-testid="charts-loading" variant="rectangular" height={160} />;
  }

  return (
    <Box data-testid="metric-charts" sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {metrics.map((metric) => {
        const entry = loaded[metric.slug];
        if (entry?.failure !== undefined) {
          return (
            <Box key={metric.slug} data-testid="metric-chart-failure" data-metric={metric.slug}>
              <Severity
                level="degraded"
                cause={`${metric.slug} could not be read — ${entry.failure}`}
              />
            </Box>
          );
        }
        const series = entry?.series;
        if (series === undefined) return null;
        return (
          <MetricChart
            key={metric.slug}
            slug={metric.slug}
            // The series route re-serves the spec's own unit; the spec's is
            // used only if the response somehow carries none.
            unit={series.unit === "" ? (metric.unit ?? "") : series.unit}
            points={Array.isArray(series.points) ? series.points : []}
            state={series.state}
            nowMs={nowMs}
            stalenessDays={stalenessDays}
          />
        );
      })}
    </Box>
  );
}
