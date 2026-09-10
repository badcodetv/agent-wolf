/**
 * W14 — the scoreboard.
 *
 * Three of these are load-bearing:
 *
 *  1. the "decides nothing" sentence, asserted on rendered text;
 *  2. expected direction rendered beside realised change;
 *  3. 🔴 **no colour by movement** — asserted by rendering a +40% and a −40%
 *     metric and proving they compute to the SAME colour. That test fails the
 *     moment someone adds the finance-UI green/red reflex, which is backwards
 *     for a thesis that predicted a fall.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { decomposeColor } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import Scoreboard, { NEVER_EVALUATED, SUPPORT_SCORE_NOTE } from "./Scoreboard.js";
import { darkTheme, lightTheme } from "../theme.js";
import type { EvaluationResult, MetricResult } from "../api/types.js";

const THEMES = [
  ["light", lightTheme],
  ["dark", darkTheme],
] as const;

function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

function metric(over: Partial<MetricResult> = {}): MetricResult {
  return {
    slug: "brent_crude",
    direction: "down",
    realised_change_pct: -12.4,
    last_observation_ms: Date.UTC(2026, 7, 12),
    stale: false,
    stale_reason: null,
    ...over,
  };
}

function evaluation(over: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluated_at_ms: Date.UTC(2026, 7, 21, 6, 15),
    support_score: 0.1,
    conditions: [],
    metrics: [metric()],
    ...over,
  };
}

function renderBoard(value: EvaluationResult | null | undefined, theme: Theme = lightTheme) {
  return render(
    <ThemeProvider theme={theme}>
      <Scoreboard evaluation={value} />
    </ThemeProvider>,
  );
}

describe("🔴 the score is a summary that decides nothing", () => {
  it("renders the sentence, not just the number", () => {
    renderBoard(evaluation());
    expect(screen.getByTestId("support-score")).toHaveTextContent("0.10");
    expect(screen.getByTestId("support-score-note")).toHaveTextContent(SUPPORT_SCORE_NOTE);
    expect(screen.getByTestId("support-score-note").textContent).toContain("only conditions do");
  });

  it("renders the score at two decimals rather than a raw float", () => {
    renderBoard(evaluation({ support_score: -0.6666666 }));
    expect(screen.getByTestId("support-score")).toHaveTextContent("-0.67");
  });
});

describe("🔴 never coloured by which way it moved", () => {
  it.each(THEMES)("%s: a +40%% metric and a -40%% metric compute to the same colour", (_mode, theme) => {
    renderBoard(
      evaluation({
        metrics: [
          metric({ slug: "up_one", realised_change_pct: 40 }),
          metric({ slug: "down_one", realised_change_pct: -40 }),
        ],
      }),
      theme,
    );
    const [up, down] = screen.getAllByTestId("metric-realised");
    expect(up).toHaveTextContent("40%");
    expect(down).toHaveTextContent("-40%");
    expect(rgba(getComputedStyle(up as Element).color)).toBe(
      rgba(getComputedStyle(down as Element).color),
    );
  });

  it.each(THEMES)("%s: a positive and a negative support score compute to the same colour", (_mode, theme) => {
    const { unmount } = renderBoard(evaluation({ support_score: 0.9 }), theme);
    const positive = rgba(getComputedStyle(screen.getByTestId("support-score")).color);
    unmount();
    renderBoard(evaluation({ support_score: -0.9 }), theme);
    const negative = rgba(getComputedStyle(screen.getByTestId("support-score")).color);
    expect(positive).toBe(negative);
    // And neither borrows a semantic colour — success is a CONFIRMED VERDICT
    // and nothing else; error red is severity `attacked` and nothing else.
    expect(positive).not.toBe(rgba(theme.palette.success.main));
    expect(positive).not.toBe(rgba(theme.palette.error.main));
  });
});

describe("expected direction beside realised change", () => {
  it("shows the spec's expected direction next to what actually happened", () => {
    renderBoard(evaluation({ metrics: [metric({ direction: "down", realised_change_pct: 8.2 })] }));
    const row = screen.getByTestId("scoreboard-metric");
    expect(within(row).getByTestId("metric-direction")).toHaveTextContent("expected ↓ down");
    expect(within(row).getByTestId("metric-realised")).toHaveTextContent("realised 8.2%");
  });

  it("renders `flat` as a legal expected direction, not as a missing one", () => {
    renderBoard(evaluation({ metrics: [metric({ direction: "flat" })] }));
    expect(screen.getByTestId("metric-direction")).toHaveTextContent("expected → flat");
  });

  it("renders an absent realised change as an em dash, never as 0%", () => {
    renderBoard(evaluation({ metrics: [metric({ realised_change_pct: null })] }));
    expect(screen.getByTestId("metric-realised")).toHaveTextContent("realised —");
    expect(screen.getByTestId("metric-realised")).not.toHaveTextContent("0%");
  });
});

describe("🔴 staleness comes from the evaluation, and carries its reason", () => {
  it("marks a stale metric degraded and names W4's reason verbatim", () => {
    renderBoard(
      evaluation({ metrics: [metric({ stale: true, stale_reason: "stale_data" })] }),
    );
    const marker = screen.getByTestId("severity");
    expect(marker).toHaveAttribute("data-severity", "degraded");
    expect(marker).toHaveTextContent("brent_crude is stale");
    expect(marker).toHaveTextContent("stale_data");
  });

  it("renders a stale_reason outside W4's closed set verbatim rather than dropping it", () => {
    renderBoard(evaluation({ metrics: [metric({ stale: true, stale_reason: "gremlins" })] }));
    expect(screen.getByTestId("severity")).toHaveTextContent("gremlins");
  });

  it("marks a stale metric with NO reason without leaving the cause blank", () => {
    renderBoard(evaluation({ metrics: [metric({ stale: true, stale_reason: null })] }));
    expect(screen.getByTestId("severity")).toHaveTextContent("no reason was recorded");
  });

  it("shows no severity at all for a metric that is not stale", () => {
    renderBoard(evaluation({ metrics: [metric({ stale: false })] }));
    expect(screen.queryByTestId("severity")).toBeNull();
  });

  it("does not invent staleness from the last observation date", () => {
    // Ten years old, and `stale: false`. The evaluation is the authority and
    // this component owns no clock: if it ever grew one, this goes red.
    renderBoard(
      evaluation({
        metrics: [metric({ stale: false, last_observation_ms: Date.UTC(2016, 0, 1) })],
      }),
    );
    expect(screen.queryByTestId("severity")).toBeNull();
    expect(screen.getByTestId("scoreboard-metric")).toHaveAttribute("data-stale", "false");
  });
});

describe("🔴 it degrades instead of throwing", () => {
  it("renders an explicit empty state when the hypothesis has never been evaluated", () => {
    renderBoard(null);
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "false");
    expect(screen.getByTestId("scoreboard")).toHaveTextContent(NEVER_EVALUATED);
  });

  it("renders when `evaluation` is absent entirely", () => {
    renderBoard(undefined);
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "false");
  });

  it("survives a malformed evaluation whose `metrics` is not an array", () => {
    // The wire types `evaluation` as `unknown`; the server re-serves whatever
    // the memory held. A malformed body must render, not unmount the page.
    const malformed = { evaluated_at_ms: 1, support_score: 0, conditions: [], metrics: null };
    renderBoard(malformed as unknown as EvaluationResult);
    expect(screen.getByTestId("scoreboard-no-metrics")).toBeInTheDocument();
  });

  it("survives an evaluation with no support_score at all", () => {
    const malformed = { evaluated_at_ms: 1, conditions: [], metrics: [] };
    renderBoard(malformed as unknown as EvaluationResult);
    expect(screen.getByTestId("support-score")).toHaveTextContent("—");
  });
});

describe("🔴 nothing comes from a Bob delivery status", () => {
  it("renders completely from a payload carrying no delivery information at all", () => {
    // There is no delivery field anywhere in this fixture, and there is none
    // on the wire either. A delivery parked at `awaiting_human` never clears,
    // so a page that took its status from one would never look current.
    const payload = JSON.parse(JSON.stringify(evaluation())) as EvaluationResult;
    expect(JSON.stringify(payload)).not.toContain("delivery");
    renderBoard(payload);
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "true");
    expect(screen.getByTestId("scoreboard-metric")).toBeInTheDocument();
  });
});
