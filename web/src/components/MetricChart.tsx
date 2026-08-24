/**
 * One metric's series — the chart that must never lie about time.
 *
 * `design/2026-08-24-agent-wolf-ui.md` § 5, "The data went stale":
 *
 * > The chart shows the last known points, then a **hatched trailing region**
 * > to today and a caption reading exactly `never fetched` or
 * > `no update since <date>`. **Never a flat line to today; never a silent
 * > gap.**
 *
 * Both halves of that are structural here, not stylistic:
 *
 *  - **No flat line to today.** The line stops at the last real observation.
 *    The distance from there to now is drawn as a hatched region, which reads
 *    as "we do not know", where a line would read as "it did not move".
 *  - **No silent gap.** A jump longer than the spec's `staleness_days` gets a
 *    `null` row inserted into the data, and `connectNulls` is off, so recharts
 *    breaks the path instead of drawing a straight line across a fortnight of
 *    missing observations. `MetricChart.test.tsx` asserts the SVG path
 *    actually contains two subpaths.
 *
 * ## 🔴 The staleness authority is the server's, one layer down
 *
 * `SeriesResponse.state` — computed by `seriesState()` in
 * `api/src/routes/series.ts` from the LOCKED spec's `staleness_days` — decides
 * whether this chart hatches. W14's ticket told the browser to compute
 * `Date.now() - lastPoint.tMs > staleness_days * 86_400_000` itself; that
 * criterion predates W11, and the orchestrator withdrew it. There is no clock
 * in this component, and the test suite has a case that goes red if one
 * appears: an `ok` series whose last point is ten years old must NOT hatch.
 *
 * (`metrics[].stale` from the evaluation remains the authority for the
 * condition table and the scoreboard. Two authorities, one layer apart, each
 * owning one question — see the UI design's § 5 note.)
 *
 * ## The jsdom seam
 *
 * `ResponsiveContainer` measures its parent, and in jsdom every element is
 * 0×0 — so under test it renders nothing at all and every assertion below
 * would be vacuous. An explicit `width` therefore renders a fixed-size chart
 * instead. Only the WRAPPER differs: the axes, the line, the pattern and the
 * reference area are the same elements in both branches.
 */

import { useId } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import Severity from "./trust/Severity.js";
import { formatNumber, formatUtcAxisTick, formatUtcDate } from "../format.js";
import { DEFAULT_STALENESS_DAYS, type Point, type SeriesState } from "../api/types.js";

export const MS_PER_DAY = 86_400_000;

/** § 2b principle 4, density: a chart is a reading, not a poster. */
export const CHART_HEIGHT_PX = 180;

/** The caption for a dataset nothing has ever written. Exactly this string (§ 5). */
export const NEVER_FETCHED_CAPTION = "never fetched";

/**
 * The caption for a stale series whose dataset exists but holds no
 * observations at all.
 *
 * § 5 pins "exactly one of `never fetched` / `no update since <date>`" — and
 * there is no date to name in this case, because the file was written empty.
 * `never fetched` would be a lie (something DID write it, which is why the
 * server said `stale` rather than `never_fetched`), so the "no update since"
 * caption is kept and the missing date is replaced by what actually happened.
 */
export const STALE_WITH_NO_OBSERVATIONS =
  "no update since it was written — the dataset carries no observations";

/** One row of chart data. `v: null` is a deliberate hole the line must not cross. */
export interface ChartRow {
  t: number;
  v: number | null;
}

/**
 * The points, with an explicit hole inserted wherever the series skipped
 * longer than `gapMs`.
 *
 * The hole is placed at the midpoint of the jump so it cannot collide with a
 * real observation's timestamp, and it carries `v: null` — which, with
 * `connectNulls={false}`, is what makes recharts lift the pen.
 */
export function toChartRows(points: readonly Point[], gapMs: number): ChartRow[] {
  const rows: ChartRow[] = [];
  let previous: Point | undefined;
  for (const point of points) {
    if (previous !== undefined && gapMs > 0 && point.tMs - previous.tMs > gapMs) {
      rows.push({ t: Math.round((previous.tMs + point.tMs) / 2), v: null });
    }
    rows.push({ t: point.tMs, v: point.v });
    previous = point;
  }
  return rows;
}

/** The newest observation, or `undefined` for an empty series. */
export function lastPointOf(points: readonly Point[]): Point | undefined {
  return points.length === 0 ? undefined : points[points.length - 1];
}

/**
 * The caption, driven ENTIRELY by the server's `state`.
 *
 * `null` for `ok` — a healthy series says nothing, because § 2b spends its
 * quiet on the states that matter.
 */
export function captionFor(state: SeriesState, points: readonly Point[]): string | null {
  if (state === "never_fetched") return NEVER_FETCHED_CAPTION;
  if (state !== "stale") return null;
  const last = lastPointOf(points);
  return last === undefined
    ? STALE_WITH_NO_OBSERVATIONS
    : `no update since ${formatUtcDate(last.tMs)}`;
}

export interface MetricChartProps {
  slug: string;
  unit: string;
  points: readonly Point[];
  /** 🔴 The server's verdict. This component owns no clock. */
  state: SeriesState;
  /** The right edge of the hatched trailing region. Supplied so the chart is deterministic under test. */
  nowMs: number;
  /** The spec's `staleness_days`; also the width of jump that counts as a gap. */
  stalenessDays?: number;
  /** jsdom seam — see the file header. Absent in the browser. */
  width?: number;
  height?: number;
}

export default function MetricChart({
  slug,
  unit,
  points,
  state,
  nowMs,
  stalenessDays = DEFAULT_STALENESS_DAYS,
  width,
  height = CHART_HEIGHT_PX,
}: MetricChartProps) {
  const theme = useTheme();
  // `useId` rather than the slug: two charts for the same metric on one page
  // (the case and the charts section) would otherwise share a pattern id, and
  // the second `<defs>` would silently win.
  const patternId = `wolf-hatch-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const safePoints = Array.isArray(points) ? points : [];
  const rows = toChartRows(safePoints, stalenessDays * MS_PER_DAY);
  const last = lastPointOf(safePoints);
  const caption = captionFor(state, safePoints);
  // The trailing region exists only when there is something to trail FROM and
  // the server said the series is not current.
  const hatch = state === "stale" && last !== undefined && nowMs > last.tMs;
  const domainMax = hatch ? Math.max(nowMs, last.tMs) : "dataMax";

  const body = (
    <LineChart
      data={rows}
      {...(width === undefined ? {} : { width, height })}
      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
    >
      <defs>
        <pattern
          id={patternId}
          data-testid="hatch-pattern"
          width={6}
          height={6}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
        >
          <line x1={0} y1={0} x2={0} y2={6} stroke={theme.palette.warning.main} strokeWidth={1.5} />
        </pattern>
      </defs>
      <CartesianGrid stroke={theme.palette.divider} strokeDasharray="2 4" vertical={false} />
      <XAxis
        dataKey="t"
        type="number"
        scale="time"
        domain={["dataMin", domainMax]}
        // 🔴 UTC. See `format.ts` — an observation rendered in the reader's
        // own zone silently moves across a day boundary.
        tickFormatter={formatUtcAxisTick}
        tick={{ fontSize: 10, fill: theme.palette.text.secondary }}
        stroke={theme.palette.divider}
      />
      <YAxis
        tickFormatter={(value: number) => formatNumber(value, 2)}
        tick={{ fontSize: 10, fill: theme.palette.text.secondary }}
        stroke={theme.palette.divider}
        width={56}
      />
      {hatch && last !== undefined ? (
        <ReferenceArea
          x1={last.tMs}
          x2={nowMs}
          fill={`url(#${patternId})`}
          fillOpacity={0.5}
          ifOverflow="extendDomain"
        />
      ) : null}
      <Line
        type="linear"
        dataKey="v"
        // 🔴 Both of these are the "never a silent gap" rule. `connectNulls`
        // defaults to false, but it is stated because turning it on is a
        // one-word change that would silently draw a line across a month of
        // missing data.
        connectNulls={false}
        isAnimationActive={false}
        stroke={theme.palette.text.primary}
        strokeWidth={1.5}
        dot={false}
      />
    </LineChart>
  );

  return (
    <Box data-testid="metric-chart" data-metric={slug} data-series-state={state}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography variant="mono" sx={{ fontSize: 13 }}>
          {slug}
        </Typography>
        <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
          {unit}
        </Typography>
      </Box>

      {safePoints.length === 0 ? (
        // Nothing to draw. An empty axis pair would read as "we looked and
        // found zero", which is a different claim from "nothing has run".
        <Typography data-testid="metric-chart-no-points" sx={{ fontSize: 13, color: "text.secondary" }}>
          no observations to plot
        </Typography>
      ) : width === undefined ? (
        <ResponsiveContainer width="100%" height={height}>
          {body}
        </ResponsiveContainer>
      ) : (
        body
      )}

      {caption === null ? null : (
        <Box data-testid="metric-chart-caption">
          <Severity level="degraded" cause={caption} />
        </Box>
      )}
    </Box>
  );
}
