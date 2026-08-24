// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BoardRow } from "../api/types.js";
import { groupByTier, partitionBoard, TIER_HEADINGS } from "./tiers.js";

function row(over: Partial<BoardRow> & { id: string }): BoardRow {
  return {
    title: `hypothesis ${over.id}`,
    title_truncated: false,
    owner: "kai",
    status: "live",
    support_score: null,
    conditions_summary: null,
    updated_at_ms: null,
    ...over,
  };
}

describe("groupByTier", () => {
  it("puts each row in the tier the SERVER named, without recomputing it", () => {
    // Deliberately contradictory: a `challenged` row the server tiered as
    // `holding`. UI design § 4's membership rules are W27's to apply; a client
    // that second-guessed them would put the attention model in two places.
    const groups = groupByTier([
      row({ id: "aaaaaaa1", status: "challenged", attention_tier: "holding" }),
      row({ id: "aaaaaaa2", status: "draft", attention_tier: "in_interview" }),
      row({ id: "aaaaaaa3", attention_tier: "watch" }),
      row({ id: "aaaaaaa4", attention_tier: "needs_human" }),
    ]);
    expect(groups.holding.map((t) => t.row.id)).toEqual(["aaaaaaa1"]);
    expect(groups.in_interview.map((t) => t.row.id)).toEqual(["aaaaaaa2"]);
    expect(groups.watch.map((t) => t.row.id)).toEqual(["aaaaaaa3"]);
    expect(groups.needs_human.map((t) => t.row.id)).toEqual(["aaaaaaa4"]);
  });

  it("renders a row whose attention_tier is ABSENT in NEEDS A HUMAN, marked unclassified", () => {
    const groups = groupByTier([row({ id: "bbbbbbb1" })]);
    expect(groups.needs_human.map((t) => t.row.id)).toEqual(["bbbbbbb1"]);
    expect(groups.needs_human[0]?.unclassified).toBe(true);
    expect(groups.holding).toEqual([]);
  });

  it("renders a row whose attention_tier is UNRECOGNISED in NEEDS A HUMAN, marked unclassified", () => {
    const groups = groupByTier([
      row({ id: "bbbbbbb2", attention_tier: "urgent" }),
      row({ id: "bbbbbbb3", attention_tier: null }),
    ]);
    expect(groups.needs_human.map((t) => t.row.id)).toEqual(["bbbbbbb2", "bbbbbbb3"]);
    expect(groups.needs_human.every((t) => t.unclassified)).toBe(true);
  });

  it("marks a row the server DID tier as classified", () => {
    const groups = groupByTier([row({ id: "bbbbbbb4", attention_tier: "needs_human" })]);
    expect(groups.needs_human[0]?.unclassified).toBe(false);
  });

  it("sorts NEEDS A HUMAN and IN INTERVIEW by updated_at_ms descending, nulls last", () => {
    const groups = groupByTier([
      row({ id: "ccccccc1", attention_tier: "needs_human", updated_at_ms: 1_000 }),
      row({ id: "ccccccc2", attention_tier: "needs_human", updated_at_ms: null }),
      row({ id: "ccccccc3", attention_tier: "needs_human", updated_at_ms: 3_000 }),
      row({ id: "ddddddd1", attention_tier: "in_interview", updated_at_ms: 5 }),
      row({ id: "ddddddd2", attention_tier: "in_interview", updated_at_ms: 9 }),
    ]);
    expect(groups.needs_human.map((t) => t.row.id)).toEqual(["ccccccc3", "ccccccc1", "ccccccc2"]);
    expect(groups.in_interview.map((t) => t.row.id)).toEqual(["ddddddd2", "ddddddd1"]);
  });

  it("sorts WATCH by support_score ASCENDING — worst first — and HOLDING descending", () => {
    const rows = [
      row({ id: "eeeeeee1", attention_tier: "watch", support_score: 0.05 }),
      row({ id: "eeeeeee2", attention_tier: "watch", support_score: -0.4 }),
      row({ id: "eeeeeee3", attention_tier: "watch", support_score: -0.1 }),
      row({ id: "eeeeeee4", attention_tier: "watch", support_score: null }),
      row({ id: "fffffff1", attention_tier: "holding", support_score: 0.1 }),
      row({ id: "fffffff2", attention_tier: "holding", support_score: 0.9 }),
      row({ id: "fffffff3", attention_tier: "holding", support_score: null }),
    ];
    const groups = groupByTier(rows);
    expect(groups.watch.map((t) => t.row.id)).toEqual([
      "eeeeeee2",
      "eeeeeee3",
      "eeeeeee1",
      "eeeeeee4",
    ]);
    expect(groups.holding.map((t) => t.row.id)).toEqual(["fffffff2", "fffffff1", "fffffff3"]);
  });

  it("breaks ties by id so the order does not wobble between renders", () => {
    const groups = groupByTier([
      row({ id: "ggggggg2", attention_tier: "holding", support_score: 0.5 }),
      row({ id: "ggggggg1", attention_tier: "holding", support_score: 0.5 }),
    ]);
    expect(groups.holding.map((t) => t.row.id)).toEqual(["ggggggg1", "ggggggg2"]);
  });

  it("names the four headings as UI design § 4 does — 'a human', never 'you'", () => {
    expect(TIER_HEADINGS.needs_human).toBe("NEEDS A HUMAN");
    expect(TIER_HEADINGS.watch).toBe("WATCH");
    expect(TIER_HEADINGS.in_interview).toBe("IN INTERVIEW");
    expect(TIER_HEADINGS.holding).toBe("HOLDING");
    expect(TIER_HEADINGS.needs_human).not.toMatch(/you/i);
  });
});

describe("partitionBoard", () => {
  it("keeps the three terminal states off the board and puts them in the archive", () => {
    const rows = [
      row({ id: "1111111a", status: "draft" }),
      row({ id: "1111111b", status: "live" }),
      row({ id: "1111111c", status: "challenged" }),
      row({ id: "1111111d", status: "confirmed" }),
      row({ id: "1111111e", status: "invalidated" }),
      row({ id: "1111111f", status: "archived" }),
    ];
    const { active, terminal } = partitionBoard(rows);
    expect(active.map((r) => r.id)).toEqual(["1111111a", "1111111b", "1111111c"]);
    expect(terminal.map((r) => r.id)).toEqual(["1111111d", "1111111e", "1111111f"]);
  });

  it("keeps an anomaly (null status) and an unknown status ON the board — an anomaly is rendered, never dropped", () => {
    const { active, terminal } = partitionBoard([
      row({ id: "2222222a", status: null }),
      row({ id: "2222222b", status: "banana" }),
    ]);
    expect(active.map((r) => r.id)).toEqual(["2222222a", "2222222b"]);
    expect(terminal).toEqual([]);
  });
});
