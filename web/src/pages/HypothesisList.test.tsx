import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import HypothesisList from "./HypothesisList.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";
import { EMPTY_HEADLINE, NO_REPORT_YET } from "../components/HypothesisRow.js";
import { UNCLASSIFIED_CAPTION } from "../board/tiers.js";
import type { BoardRow } from "../api/types.js";

const BOARD = "GET /api/hypotheses";

function row(over: Partial<BoardRow> & { id: string }): BoardRow {
  return {
    title: `hypothesis ${over.id}`,
    title_truncated: false,
    owner: "kai",
    status: "live",
    support_score: 0,
    conditions_summary: null,
    updated_at_ms: 1_780_000_000_000,
    attention_tier: "holding",
    headline: "a headline",
    ...over,
  };
}

async function renderBoard(rows: BoardRow[]) {
  const stub = stubFetchRoutes({ [BOARD]: { json: rows } });
  renderWithProviders(<HypothesisList />);
  await act(async () => {
    await Promise.resolve();
  });
  return stub;
}

function section(name: string): HTMLElement {
  return screen.getByTestId(`board-section-${name}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HypothesisList", () => {
  it("renders TWELVE hypotheses from exactly ONE fetch, with no per-card follow-up", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `0000000${i.toString(16)}`, attention_tier: "watch", support_score: i / 10 }),
    );
    const stub = await renderBoard(rows);

    expect(screen.getAllByTestId("hypothesis-row")).toHaveLength(12);
    // ONE request in total — not one plus twelve. `stubFetchRoutes` throws on
    // any unrouted path, so a per-card follow-up could not pass silently
    // either way.
    expect(stub.mock).toHaveBeenCalledTimes(1);
    expect(stub.countFor(BOARD)).toBe(1);
  });

  it("renders an EMPTY 'NEEDS A HUMAN' section with a count of zero rather than hiding it", async () => {
    await renderBoard([row({ id: "aaaaaaa1", attention_tier: "holding" })]);
    const heading = within(section("needs_human")).getByTestId("board-section-heading");
    expect(heading).toHaveTextContent("NEEDS A HUMAN");
    expect(heading).toHaveTextContent("0");
    // "nothing needs you" must be VISIBLE, not inferred from an absence.
    expect(within(section("needs_human")).getByTestId("board-section-empty")).toBeInTheDocument();
  });

  it("says 'a human', never 'you' — anyone allowlisted may act on anything", async () => {
    await renderBoard([]);
    expect(within(section("needs_human")).getByTestId("board-section-heading")).toHaveTextContent(
      "NEEDS A HUMAN",
    );
    expect(section("needs_human").textContent ?? "").not.toMatch(/needs you/i);
  });

  it("collapses HOLDING and shows its count; expanding reveals the rows", async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ id: `1111000${i.toString(16)}`, attention_tier: "holding" }),
    );
    await renderBoard(rows);

    expect(within(section("holding")).getByTestId("board-section-heading")).toHaveTextContent("15");
    expect(screen.queryAllByTestId("hypothesis-row")).toHaveLength(0);

    await act(async () => {
      within(section("holding")).getByTestId("board-section-toggle").click();
    });
    expect(screen.getAllByTestId("hypothesis-row")).toHaveLength(15);
  });

  it("puts a row with NO attention_tier in NEEDS A HUMAN and captions it — never a chronological fallback", async () => {
    await renderBoard([{ ...row({ id: "bbbbbbb1" }), attention_tier: undefined }]);
    const needs = section("needs_human");
    expect(within(needs).getByTestId("hypothesis-row")).toHaveAttribute(
      "data-hypothesis-id",
      "bbbbbbb1",
    );
    expect(within(needs).getByTestId("unclassified-caption")).toHaveTextContent(
      UNCLASSIFIED_CAPTION,
    );
  });

  it("puts a row with an UNRECOGNISED attention_tier in NEEDS A HUMAN and captions it", async () => {
    await renderBoard([row({ id: "bbbbbbb2", attention_tier: "urgent" })]);
    const needs = section("needs_human");
    expect(within(needs).getByTestId("hypothesis-row")).toHaveAttribute(
      "data-hypothesis-id",
      "bbbbbbb2",
    );
    expect(within(needs).getByTestId("unclassified-caption")).toBeInTheDocument();
  });

  it("keeps the four sections in the order UI design § 4 pins", async () => {
    await renderBoard([]);
    const order = screen
      .getAllByTestId(/^board-section-(needs_human|watch|in_interview|holding)$/)
      .map((el) => el.getAttribute("data-tier"));
    expect(order).toEqual(["needs_human", "watch", "in_interview", "holding"]);
  });

  it("keeps terminal hypotheses OFF the board — they live on /archive", async () => {
    await renderBoard([
      row({ id: "ccccccc1", status: "confirmed", attention_tier: "holding" }),
      row({ id: "ccccccc2", status: "live", attention_tier: "watch" }),
    ]);
    expect(screen.getAllByTestId("hypothesis-row")).toHaveLength(1);
    expect(screen.getByTestId("hypothesis-row")).toHaveAttribute(
      "data-hypothesis-id",
      "ccccccc2",
    );
  });

  it("distinguishes 'no report yet' (null) from 'the report said nothing' (empty string)", async () => {
    await renderBoard([
      row({ id: "ddddddd1", attention_tier: "watch", headline: null }),
      row({ id: "ddddddd2", attention_tier: "watch", headline: "" }),
    ]);
    const first = screen.getByTestId("board-row-ddddddd1");
    const second = screen.getByTestId("board-row-ddddddd2");
    expect(within(first).getByTestId("headline")).toHaveTextContent(NO_REPORT_YET);
    expect(within(first).getByTestId("headline")).toHaveAttribute("data-headline-state", "absent");
    expect(within(second).getByTestId("headline")).toHaveTextContent(EMPTY_HEADLINE);
    expect(within(second).getByTestId("headline")).toHaveAttribute("data-headline-state", "empty");
    expect(NO_REPORT_YET).not.toBe(EMPTY_HEADLINE);
  });

  it("never invents a zero count: an ABSENT attention_count or stale_count renders nothing at all", async () => {
    await renderBoard([row({ id: "eeeeeee1", attention_tier: "watch" })]);
    expect(screen.queryByTestId("attention-count")).toBeNull();
    expect(screen.queryByTestId("stale-count")).toBeNull();
  });

  it("renders the counts the server DID send", async () => {
    await renderBoard([
      row({ id: "eeeeeee2", attention_tier: "watch", attention_count: 1, stale_count: 2 }),
    ]);
    expect(screen.getByTestId("attention-count")).toHaveTextContent("1 attention");
    expect(screen.getByTestId("stale-count")).toHaveTextContent("2 stale");
  });

  it("renders a tampered row as an unmissable attacked alert, in words", async () => {
    await renderBoard([
      row({
        id: "fffffff1",
        attention_tier: "needs_human",
        tamper: [
          {
            reason: "forged_row",
            written_by_worker: "researcher-9c1b",
            written_by_session: "",
            memory_id: "mem_7f3a",
          },
        ],
      }),
    ]);
    const alert = screen.getByTestId("severity");
    expect(alert).toHaveAttribute("data-severity", "attacked");
    expect(alert).toHaveTextContent(/forged row/i);
    expect(alert).toHaveTextContent("mem_7f3a");
  });

  it("surfaces a board read failure with the server's own sentence", async () => {
    stubFetchRoutes({
      [BOARD]: { status: 503, json: { kind: "unavailable", message: "host port pool is exhausted" } },
    });
    renderWithProviders(<HypothesisList />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("severity")).toHaveTextContent("host port pool is exhausted");
  });

  it("offers the new-hypothesis action", async () => {
    await renderBoard([]);
    expect(screen.getByTestId("new-hypothesis-link")).toHaveAttribute("href", "/new");
  });
});
