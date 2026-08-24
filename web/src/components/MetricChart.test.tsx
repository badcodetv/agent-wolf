/**
 * W14 — the metric chart.
 *
 * The two load-bearing tests:
 *
 *  1. 🔴 **the component owns no clock.** An `ok` series whose last point is
 *     ten years old must not hatch and must not caption. If anyone
 *     reintroduces the withdrawn client-side rule
 *     (`Date.now() - lastPoint.tMs > staleness_days * 86_400_000`), that case
 *     goes red — which is the whole reason ruling B exists.
 *  2. 🔴 **no interpolation across a gap.** Asserted on the SVG path's own
 *     `d` attribute: two subpaths, not one. Turning `connectNulls` on, or
 *     dropping the hole insertion, both produce a single `M` and go red.
 *
 * Recharts renders synchronously in jsdom when it is given explicit pixel
 * dimensions, which is what `width` is for (see the component's header).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import MetricChart, {
  MS_PER_DAY,
  NEVER_FETCHED_CAPTION,
  STALE_WITH_NO_OBSERVATIONS,
  captionFor,
  toChartRows,
} from "./MetricChart.js";
import { lightTheme } from "../theme.js";
import type { Point, SeriesState } from "../api/types.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0);
const DAY = MS_PER_DAY;

function daily(count: number, endMs = NOW - DAY): Point[] {
  const points: Point[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    points.push({ tMs: endMs - i * DAY, v: 100 + i });
  }
  return points;
}

function renderChart(over: {
  points?: Point[];
  state?: SeriesState;
  nowMs?: number;
  stalenessDays?: number;
} = {}) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <MetricChart
        slug="brent_crude"
        unit="USD"
        points={over.points ?? daily(5)}
        state={over.state ?? "ok"}
        nowMs={over.nowMs ?? NOW}
        stalenessDays={over.stalenessDays ?? 5}
        width={600}
        height={200}
      />
    </ThemeProvider>,
  );
}

function pathData(container: HTMLElement): string {
  const curve = container.querySelector(".recharts-line-curve");
  expect(curve).not.toBeNull();
  return curve?.getAttribute("d") ?? "";
}

function subpathCount(d: string): number {
  return (d.match(/M/g) ?? []).length;
}

describe("🔴 it does not interpolate across gaps", () => {
  it("breaks the line into two subpaths when the series skips longer than staleness_days", () => {
    const before = daily(3, NOW - 40 * DAY);
    const after = daily(3, NOW - DAY);
    const { container } = renderChart({ points: [...before, ...after] });
    const d = pathData(container);
    expect(d).not.toBe("");
    expect(subpathCount(d)).toBe(2);
  });

  it("draws ONE subpath when the observations are contiguous", () => {
    const { container } = renderChart({ points: daily(6) });
    expect(subpathCount(pathData(container))).toBe(1);
  });

  it("inserts the hole at the midpoint of the jump, so it can never collide with a real observation", () => {
    const rows = toChartRows(
      [
        { tMs: 0, v: 1 },
        { tMs: 100 * DAY, v: 2 },
      ],
      5 * DAY,
    );
    expect(rows).toEqual([
      { t: 0, v: 1 },
      { t: 50 * DAY, v: null },
      { t: 100 * DAY, v: 2 },
    ]);
  });

  it("inserts no hole for a jump inside the tolerance", () => {
    const rows = toChartRows(
      [
        { tMs: 0, v: 1 },
        { tMs: 2 * DAY, v: 2 },
      ],
      5 * DAY,
    );
    expect(rows.every((row) => row.v !== null)).toBe(true);
  });
});

describe("🔴 the hatching and the caption come from SeriesResponse.state", () => {
  it("hatches and captions a `stale` series", () => {
    const { container } = renderChart({
      points: daily(4, NOW - 30 * DAY),
      state: "stale",
    });
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(1);
    expect(container.querySelector('[data-testid="hatch-pattern"]')).not.toBeNull();
    const caption = screen.getByTestId("metric-chart-caption");
    expect(caption).toHaveTextContent("no update since 25 Jul 2026");
    expect(screen.getByTestId("severity")).toHaveAttribute("data-severity", "degraded");
  });

  it("draws neither hatching nor caption for an `ok` series", () => {
    const { container } = renderChart({ state: "ok" });
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(0);
    expect(screen.queryByTestId("metric-chart-caption")).toBeNull();
  });

  it("🔴 does NOT hatch an `ok` series whose newest point is ten years old", () => {
    // The withdrawn client-side rule would call this stale on any clock. The
    // server said `ok`, so the chart says ok. This is the assertion that goes
    // red if the browser starts recomputing staleness (ruling B).
    const ancient: Point[] = [
      { tMs: Date.UTC(2016, 0, 1), v: 1 },
      { tMs: Date.UTC(2016, 0, 2), v: 2 },
    ];
    const { container } = renderChart({ points: ancient, state: "ok", stalenessDays: 5 });
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(0);
    expect(screen.queryByTestId("metric-chart-caption")).toBeNull();
    expect(screen.getByTestId("metric-chart")).toHaveAttribute("data-series-state", "ok");
  });

  it("🔴 DOES hatch a `stale` series whose newest point is an hour old", () => {
    // The mirror image: no clock-based rule would call this stale, and the
    // chart hatches it anyway, because the server's `state` is the authority.
    const fresh: Point[] = [
      { tMs: NOW - 2 * 60 * 60 * 1000, v: 1 },
      { tMs: NOW - 60 * 60 * 1000, v: 2 },
    ];
    const { container } = renderChart({ points: fresh, state: "stale" });
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(1);
    expect(screen.getByTestId("metric-chart-caption")).toHaveTextContent("no update since 24 Aug 2026");
  });

  it("captions a `never_fetched` series with exactly `never fetched`, and plots nothing", () => {
    renderChart({ points: [], state: "never_fetched" });
    expect(screen.getByTestId("metric-chart-caption")).toHaveTextContent(NEVER_FETCHED_CAPTION);
    // Never a flat line to today: with no observations there is nothing to
    // draw, and an empty axis pair would read as "we looked and found zero".
    expect(screen.getByTestId("metric-chart-no-points")).toBeInTheDocument();
  });

  it("captions a `stale` series that carries no observations without inventing a date", () => {
    renderChart({ points: [], state: "stale" });
    expect(screen.getByTestId("metric-chart-caption")).toHaveTextContent(STALE_WITH_NO_OBSERVATIONS);
  });

  it("returns the three captions and nothing else", () => {
    expect(captionFor("ok", daily(2))).toBeNull();
    expect(captionFor("never_fetched", [])).toBe(NEVER_FETCHED_CAPTION);
    expect(captionFor("stale", [{ tMs: Date.UTC(2026, 7, 12), v: 1 }])).toBe(
      "no update since 12 Aug 2026",
    );
    expect(captionFor("stale", [])).toBe(STALE_WITH_NO_OBSERVATIONS);
  });
});

describe("the axis is UTC", () => {
  it("labels an observation at 23:30 UTC with the UTC day", () => {
    // On this machine (Europe/London, UTC+1 in August) a local-time formatter
    // renders "13 Aug" here. `format.test.ts` pins the same rule hermetically
    // by forcing the process into Asia/Tokyo.
    const { container } = renderChart({
      points: [
        { tMs: Date.UTC(2026, 7, 12, 23, 30), v: 1 },
        { tMs: Date.UTC(2026, 7, 13, 23, 30), v: 2 },
      ],
      state: "ok",
    });
    const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value")).map(
      (node) => node.textContent,
    );
    expect(ticks).toContain("12 Aug");
    expect(ticks).not.toContain("11 Aug");
  });
});
