import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import HypothesisRow, { NO_TITLE, formatScore } from "./HypothesisRow.js";
import { renderWithProviders } from "../testUtils.js";
import { lightTheme } from "../theme.js";
import type { BoardRow } from "../api/types.js";

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    id: "1a2b3c4d",
    title: "Petrodollar / drone parts",
    title_truncated: false,
    owner: "kai",
    status: "live",
    support_score: -0.4,
    conditions_summary: null,
    updated_at_ms: 1_780_000_000_000,
    headline: "Brent held above $78 through July",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatScore", () => {
  it("is signed and fixed-width, so a column of scores aligns", () => {
    expect(formatScore(-0.4)).toBe("−0.40");
    expect(formatScore(0.05)).toBe("+0.05");
    expect(formatScore(0)).toBe("0.00");
    expect(formatScore(null)).toBe("—");
  });
});

describe("HypothesisRow", () => {
  it("renders the title, the owner BYLINE, the chip, the score and the headline", () => {
    renderWithProviders(<HypothesisRow row={row()} />);
    expect(screen.getByText("Petrodollar / drone parts")).toBeInTheDocument();
    expect(screen.getByTestId("owner-byline")).toHaveTextContent("kai");
    expect(screen.getByTestId("status-chip")).toHaveTextContent("live");
    expect(screen.getByTestId("support-score")).toHaveTextContent("−0.40");
    expect(screen.getByTestId("headline")).toHaveTextContent("Brent held above $78 through July");
  });

  it("NEVER colours the score by which way it moved — a thesis predicting a fall succeeds when the line goes down", () => {
    const { rerender } = renderWithProviders(<HypothesisRow row={row({ support_score: -0.4 })} />);
    const down = window.getComputedStyle(screen.getByTestId("support-score")).color;
    rerender(<HypothesisRow row={row({ support_score: 0.4 })} />);
    const up = window.getComputedStyle(screen.getByTestId("support-score")).color;
    expect(up).toBe(down);
    // And neither is a semantic colour: green-up/red-down is the finance-UI
    // reflex this product is built to refuse (§ 2b principle 2).
    for (const colour of [up, down]) {
      expect(colour).not.toBe(lightTheme.palette.success.main);
      expect(colour).not.toBe(lightTheme.palette.error.main);
      expect(colour).not.toBe(lightTheme.palette.warning.main);
    }
  });

  it("calls the score a SUMMARY that decides nothing", () => {
    renderWithProviders(<HypothesisRow row={row()} />);
    expect(screen.getByTestId("support-score")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("decides nothing"),
    );
  });

  it("shows an ellipsis affordance for a truncated title and never claims it is complete", () => {
    renderWithProviders(<HypothesisRow row={row({ title_truncated: true })} />);
    expect(screen.getByTestId("title-truncated")).toBeInTheDocument();
  });

  it("omits the affordance when the title is whole", () => {
    renderWithProviders(<HypothesisRow row={row()} />);
    expect(screen.queryByTestId("title-truncated")).toBeNull();
  });

  it("renders a hypothesis with no trusted state row rather than dropping it", () => {
    renderWithProviders(<HypothesisRow row={row({ title: null, status: null, owner: null })} />);
    expect(screen.getByText(NO_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId("status-chip")).toHaveAttribute("data-status-known", "false");
  });

  it("renders the condition summary with a glyph as well as a colour, and an accessible count", () => {
    renderWithProviders(
      <HypothesisRow
        row={row({
          conditions_summary: { tripped: 1, holding: 3, indeterminate: 2, evaluated_at_ms: 1 },
        })}
      />,
    );
    const summary = screen.getByTestId("conditions-summary");
    expect(summary).toHaveTextContent("◉1");
    expect(summary).toHaveTextContent("●3");
    expect(summary).toHaveTextContent("△2");
    expect(screen.getByLabelText("2 indeterminate")).toBeInTheDocument();
  });

  it("links to the hypothesis with a BARE id — never a doubled hyp- prefix", () => {
    renderWithProviders(<HypothesisRow row={row()} />);
    const link = screen.getByRole("link", { name: /Petrodollar/ });
    expect(link).toHaveAttribute("href", "/hypotheses/1a2b3c4d");
  });
});
