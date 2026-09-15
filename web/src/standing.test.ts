import { describe, expect, it } from "vitest";
import {
  describeCron,
  goLiveAtMs,
  horizonProgress,
  ruleLinesFor,
  standingFor,
  untilText,
} from "./standing.js";
import type { EvaluationResult, HypothesisSpec } from "./api/types.js";

const DAY = 86_400_000;

const SPEC: HypothesisSpec = {
  thesis: "Gold rises with M2",
  horizon_days: 365,
  flat_band_pct: 1,
  staleness_days: 5,
  metrics: [
    { slug: "m2", source: "fred", direction: "up", weight: 0.2, unit: "USD bn" },
    { slug: "gold-futures", source: "yahoo", direction: "up", weight: 0.8, unit: "USD" },
  ],
  invalidation: [
    { id: "inv-1", metric: "gold-futures", stat: "change_pct", op: "lt", threshold: -15, sustained_days: 14, meaning: "Gold sits 15% below its go-live price for two weeks" },
    { id: "inv-2", metric: "gold-futures", stat: "drawdown_pct", op: "gt", threshold: 20, sustained_days: 21, meaning: "Gold gives back 20% from its peak for three weeks" },
    { id: "inv-3", metric: "m2", stat: "change_pct", op: "lt", threshold: -2, sustained_days: 60, meaning: "US M2 contracts 2% for two months" },
  ],
};

function evaluation(states: [string, number | null][], goldPct: number | null = 6.24): EvaluationResult {
  return {
    evaluated_at_ms: 1,
    support_score: 0.34,
    conditions: states.map(([state, value], i) => ({
      id: `inv-${i + 1}`,
      metric: "gold-futures",
      state,
      reason: state === "indeterminate" ? "stale_data" : null,
      value,
      threshold: SPEC.invalidation[i]!.threshold,
      op: SPEC.invalidation[i]!.op,
      window_start_ms: 0,
      window_end_ms: 0,
      observations_in_window: value === null ? 0 : 10,
    })),
    metrics: [
      { slug: "gold-futures", direction: "up", realised_change_pct: goldPct, last_observation_ms: 5, stale: false, stale_reason: null },
    ],
  };
}

describe("standingFor", () => {
  it("a draft has no standing — its page is about the interview", () => {
    expect(standingFor("draft", null, SPEC)).toBeNull();
  });

  it("live and never evaluated is too early to tell, not holding", () => {
    expect(standingFor("live", null, SPEC)?.word).toBe("Too early to tell");
  });

  it("all rules holding says Holding, with the HEAVIEST metric's move in words", () => {
    const s = standingFor("live", evaluation([["holding", 6.2], ["holding", 1.8], ["holding", 0.5]]), SPEC);
    expect(s?.word).toBe("Holding");
    expect(s?.tone).toBe("neutral");
    expect(s?.sentence).toBe("gold-futures is up 6.2% since go-live (expected up). None of the 3 rules has tripped.");
  });

  it("says how many rules cannot be scored, without calling them safe", () => {
    const s = standingFor("live", evaluation([["holding", 6.2], ["holding", 1.8], ["indeterminate", null]]), SPEC);
    expect(s?.word).toBe("Holding");
    expect(s?.sentence).toContain("1 of 3 rules can't be scored yet");
  });

  it("🔴 one trip beats a good price move: only conditions decide the word", () => {
    const s = standingFor("live", evaluation([["tripped", -16], ["holding", 1.8], ["holding", 0.5]], 40), SPEC);
    expect(s?.word).toBe("Rule tripped");
    expect(s?.tone).toBe("accent");
  });

  it("a fall is described as a fall, in words", () => {
    const s = standingFor("live", evaluation([["holding", -3], ["holding", 1], ["holding", 0]], -3.04), SPEC);
    expect(s?.sentence).toContain("gold-futures is down 3% since go-live");
  });

  it("challenged asks for the human's verdict", () => {
    expect(standingFor("challenged", null, SPEC)?.word).toBe("Needs your verdict");
  });
});

describe("ruleLinesFor", () => {
  it("uses the spec's own sentence, the reading, the trip point and the gap", () => {
    const [first, second, third] = ruleLinesFor(
      evaluation([["holding", 6.2], ["holding", 1.8], ["indeterminate", null]]),
      SPEC,
    );
    expect(first).toMatchObject({
      meaning: "Gold sits 15% below its go-live price for two weeks",
      now: "now +6.2%",
      trips: "trips below -15% for 14 days",
      distance: "21.2 pts away",
    });
    expect(second).toMatchObject({ now: "now 1.8%", trips: "trips above 20% for 21 days", distance: "18.2 pts away" });
    // No reading: no "now", and no distance — a gap to nothing is not a gap.
    expect(third).toMatchObject({ state: "indeterminate", now: null, distance: null });
  });

  it("a rule with no evaluation yet still gets a line, unscored", () => {
    const lines = ruleLinesFor(null, SPEC);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.state === "indeterminate" && l.now === null)).toBe(true);
  });
});

describe("time", () => {
  it("go-live is the OLDEST live row, the poller's own rule", () => {
    expect(
      goLiveAtMs([
        { id: "c", status: "live", created_at_ms: 300 },
        { id: "b", status: "challenged", created_at_ms: 200 },
        { id: "a", status: "live", created_at_ms: 100 },
        { id: "0", status: "draft", created_at_ms: 50 },
      ]),
    ).toBe(100);
    expect(goLiveAtMs(undefined)).toBeNull();
  });

  it("counts days from go-live, clamped to the horizon", () => {
    const live = Date.UTC(2026, 8, 15);
    expect(horizonProgress(live, 365, live + 41.5 * DAY)).toMatchObject({ day: 42, horizonDays: 365 });
    expect(horizonProgress(live, 10, live + 99 * DAY)).toMatchObject({ day: 10, fraction: 1 });
    expect(horizonProgress(null, 365, live)).toBeNull();
  });

  it("describes the common crons in words and leaves the rest verbatim", () => {
    expect(describeCron("0 6 * * *")).toBe("every day at 06:00 UTC");
    expect(describeCron("30 4 * * 1")).toBe("every Monday at 04:30 UTC");
    expect(describeCron("0 6 * * 1-5")).toBe("on weekdays at 06:00 UTC");
    expect(describeCron("*/15 * * * *")).toBe('on the schedule "*/15 * * * *" (UTC)');
    expect(describeCron(undefined)).toBeNull();
  });

  it("says how long until the next run", () => {
    const now = 1_000_000_000_000;
    expect(untilText(now + 19 * 3_600_000, now)).toBe("in 19 h");
    expect(untilText(now + 5 * 60_000, now)).toBe("in 5 min");
    expect(untilText(now + 3 * DAY, now)).toBe("in 3 days");
    expect(untilText(now - 1, now)).toBe("any minute now");
  });
});
