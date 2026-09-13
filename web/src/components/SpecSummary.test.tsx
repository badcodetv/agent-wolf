import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import SpecSummary, { describeCondition, describeMetric } from "./SpecSummary.js";
import { renderWithProviders } from "../testUtils.js";

const base = { id: "c", metric: "basket", sustained_days: 1, meaning: "" };

describe("describeCondition", () => {
  it("reads each statistic and reference as words", () => {
    expect(describeCondition({ ...base, stat: "drawdown_pct", reference: "peak_since_live", op: "gt", threshold: 25, sustained_days: 30 })).toBe(
      "basket's fall from its peak since go-live is above 25% for 30 days in a row",
    );
    expect(describeCondition({ ...base, stat: "level", op: "lte", threshold: 4.5 })).toBe("basket is at or below 4.5");
    expect(describeCondition({ ...base, stat: "change_abs", reference: "trailing_n_days", reference_days: 20, op: "gte", threshold: 3 })).toBe(
      "basket's change over the last 20 days is at or above 3",
    );
    expect(describeCondition({ ...base, stat: "ratio_to", ratio_metric: "brent", ratio_lookback_days: 60, op: "lt", threshold: 0.8 })).toBe(
      "basket relative to brent, over 60 days, is below 0.8",
    );
  });

  it("keeps an unknown statistic or operator visible rather than guessing", () => {
    expect(describeCondition({ ...base, stat: "wobble", op: "near", threshold: 1 })).toBe("basket (wobble) near 1");
  });
});

describe("describeMetric", () => {
  it("names the series and direction, and the weight only when there are several", () => {
    const metric = { slug: "gold", source: "stooq", series_id: "gc.f", direction: "down", weight: 0.4, unit: "USD" };
    expect(describeMetric(metric, false)).toBe("gold — gc.f from stooq, expected to go down (weight 40%)");
    expect(describeMetric(metric, true)).toBe("gold — gc.f from stooq, expected to go down");
    expect(describeMetric({ ...metric, source: "derived", series_id: undefined }, true)).toBe("gold — derived, expected to go down");
  });
});

describe("SpecSummary", () => {
  it("degrades on a malformed spec instead of throwing", () => {
    renderWithProviders(<SpecSummary spec={{ thesis: "x" } as never} />);
    expect(screen.getByTestId("spec-summary")).toHaveTextContent("No metrics.");
    expect(screen.getByTestId("spec-summary")).toHaveTextContent("No invalidation conditions.");
  });
});
