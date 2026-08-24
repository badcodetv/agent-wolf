/**
 * W14 — the charts section.
 *
 * What matters here is what it ASKS for: one request per metric of the locked
 * spec, and no request at all when the spec is still a candidate. The second
 * is not an optimisation — `GET …/series/:metric` 404s every metric of a
 * hypothesis that has not gone live, so firing those requests would paint a
 * row of "not found" markers on every draft.
 *
 * `stubFetchRoutes` throws on any unrouted path, so "asks for nothing" is
 * proved by the absence of a route rather than by counting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import MetricCharts, { NO_LOCKED_SPEC, NO_METRICS, metricsOf, stalenessDaysOf } from "./MetricCharts.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";
import type { HypothesisSpec, Point, SeriesResponse } from "../api/types.js";

const ID = "1a2b3c4d";
const seriesKey = (slug: string): string => `GET /api/hypotheses/${ID}/series/${slug}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const SPEC: HypothesisSpec = {
  thesis: "the petrodollar unwinds",
  horizon_days: 180,
  flat_band_pct: 2,
  staleness_days: 7,
  metrics: [
    { slug: "brent_crude", source: "stooq", direction: "down", weight: 0.6, unit: "USD" },
    { slug: "dxy", source: "fred", direction: "up", weight: 0.4, unit: "index" },
  ],
  invalidation: [],
};

function points(count: number): Point[] {
  const end = Date.UTC(2026, 7, 20);
  return Array.from({ length: count }, (_unused, i) => ({
    tMs: end - (count - 1 - i) * 86_400_000,
    v: 70 + i,
  }));
}

function series(over: Partial<SeriesResponse> = {}): SeriesResponse {
  return {
    points: points(4),
    unit: "USD",
    version: 3,
    fetched_at_ms: Date.UTC(2026, 7, 24),
    state: "ok",
    ...over,
  };
}

function renderCharts(spec: HypothesisSpec | null, source: "hypothesis-spec" | "hypothesis-spec-candidate" | null) {
  return renderWithProviders(<MetricCharts hypothesisId={ID} spec={spec} specSource={source} />);
}

describe("it asks only for the metrics of a LOCKED spec", () => {
  it("fetches one series per metric", async () => {
    const stub = stubFetchRoutes({
      [seriesKey("brent_crude")]: { json: series() },
      [seriesKey("dxy")]: { json: series({ unit: "index" }) },
    });
    renderCharts(SPEC, "hypothesis-spec");
    await waitFor(() => expect(screen.getAllByTestId("metric-chart").length).toBe(2));
    expect(stub.countFor(seriesKey("brent_crude"))).toBe(1);
    expect(stub.countFor(seriesKey("dxy"))).toBe(1);
    expect(stub.calls.length).toBe(2);
  });

  it("🔴 asks for NOTHING when the spec is still a candidate", async () => {
    // No routes are stubbed at all: `stubFetchRoutes` throws on any request,
    // so a single fetch here fails the test loudly.
    const stub = stubFetchRoutes({});
    renderCharts(SPEC, "hypothesis-spec-candidate");
    expect(await screen.findByTestId("charts-no-spec")).toHaveTextContent(NO_LOCKED_SPEC);
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it("asks for nothing when there is no spec at all", async () => {
    const stub = stubFetchRoutes({});
    renderCharts(null, null);
    expect(await screen.findByTestId("charts-no-spec")).toBeInTheDocument();
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it("says so when a locked spec names no metrics", async () => {
    const stub = stubFetchRoutes({});
    renderCharts({ ...SPEC, metrics: [] }, "hypothesis-spec");
    expect(await screen.findByTestId("charts-no-metrics")).toHaveTextContent(NO_METRICS);
    expect(stub.mock).not.toHaveBeenCalled();
  });
});

describe("it passes the server's state through to the chart", () => {
  it("renders each metric with the state its own response carried", async () => {
    stubFetchRoutes({
      [seriesKey("brent_crude")]: { json: series({ state: "stale" }) },
      [seriesKey("dxy")]: { json: series({ state: "never_fetched", points: [] }) },
    });
    renderCharts(SPEC, "hypothesis-spec");
    await waitFor(() => expect(screen.getAllByTestId("metric-chart").length).toBe(2));
    const charts = screen.getAllByTestId("metric-chart");
    expect(charts[0]).toHaveAttribute("data-series-state", "stale");
    expect(charts[1]).toHaveAttribute("data-series-state", "never_fetched");
  });

  it("surfaces a per-metric failure as degraded, with the server's own sentence, without losing the others", async () => {
    stubFetchRoutes({
      [seriesKey("brent_crude")]: { json: series() },
      [seriesKey("dxy")]: { status: 400, json: { kind: "invalid", message: "line 3 is not a number" } },
    });
    renderCharts(SPEC, "hypothesis-spec");
    await waitFor(() => expect(screen.getByTestId("metric-chart-failure")).toBeInTheDocument());
    expect(screen.getByTestId("severity")).toHaveTextContent("line 3 is not a number");
    expect(screen.getAllByTestId("metric-chart").length).toBe(1);
  });
});

describe("the pure helpers", () => {
  it("reads the metrics of a well-formed spec and tolerates a malformed one", () => {
    expect(metricsOf(SPEC).map((m) => m.slug)).toEqual(["brent_crude", "dxy"]);
    expect(metricsOf(null)).toEqual([]);
    expect(metricsOf({ metrics: "nope" } as unknown as HypothesisSpec)).toEqual([]);
  });

  it("takes staleness_days from the spec, and the documented default when it is missing", () => {
    expect(stalenessDaysOf(SPEC)).toBe(7);
    expect(stalenessDaysOf(null)).toBe(5);
    expect(stalenessDaysOf({ staleness_days: 0 } as unknown as HypothesisSpec)).toBe(5);
  });
});

describe("🔴 one clock, read once", () => {
  it("hands every chart the SAME nowMs", async () => {
    // `Date.now` is replaced with a counter that moves on every call. Under
    // the shipped code there is exactly one call — in this section, after all
    // the series settle — so both charts carry the same value. A chart (or a
    // per-chart prop) that read the clock itself would give them different
    // ones, which is the mutation this exists to catch: the component header
    // claims "captured ONCE", and a header claiming a property nothing checks
    // is how the property stops being true.
    let tick = 1_780_000_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      tick += 1_000;
      return tick;
    });
    try {
      stubFetchRoutes({
        [seriesKey("brent_crude")]: { json: series({ state: "stale" }) },
        [seriesKey("dxy")]: { json: series({ state: "stale", unit: "index" }) },
      });
      renderCharts(SPEC, "hypothesis-spec");
      await waitFor(() => expect(screen.getAllByTestId("metric-chart").length).toBe(2));

      const stamps = screen
        .getAllByTestId("metric-chart")
        .map((node) => node.getAttribute("data-now-ms"));
      expect(stamps[0]).toBe(stamps[1]);
      // …and the counter really is moving, so the equality above is a result
      // rather than an accident of a frozen clock.
      expect(Date.now()).not.toBe(Date.now());
    } finally {
      spy.mockRestore();
    }
  });
});
