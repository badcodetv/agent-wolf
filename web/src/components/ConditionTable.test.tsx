/**
 * W14 — the condition table.
 *
 * The load-bearing tests here are the ones that separate `indeterminate` from
 * `holding`. "We could not tell" reading as "it is fine" is the single most
 * expensive way this page could lie, and colour alone would not survive a
 * greyscale screenshot — so both the colour AND the dashed rule are asserted,
 * in both modes.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { decomposeColor } from "@mui/material/styles";
import ConditionTable from "./ConditionTable.js";
import { NO_REASON_GIVEN, indeterminateCause } from "../reasons.js";
import { darkTheme, lightTheme } from "../theme.js";
import type { ConditionResult } from "../api/types.js";

const THEMES = [
  ["light", lightTheme],
  ["dark", darkTheme],
] as const;

function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

function condition(over: Partial<ConditionResult> = {}): ConditionResult {
  return {
    id: "c2",
    metric: "brent_crude",
    state: "tripped",
    reason: "condition_tripped",
    value: -12.4,
    threshold: -10,
    op: "lt",
    window_start_ms: Date.UTC(2026, 5, 1),
    window_end_ms: Date.UTC(2026, 7, 21),
    observations_in_window: 58,
    ...over,
  };
}

function renderTable(conditions: ConditionResult[], theme: Theme = lightTheme, statFor?: (id: string) => string | undefined) {
  return render(
    <ThemeProvider theme={theme}>
      <ConditionTable conditions={conditions} {...(statFor === undefined ? {} : { statFor })} />
    </ThemeProvider>,
  );
}

function stateCellOf(id: string): HTMLElement {
  const row = screen.getByTestId("condition-table-row");
  expect(row).toHaveAttribute("data-condition-id", id);
  return row;
}

describe("every pinned field renders", () => {
  it("renders the id, metric, statistic, state, value, threshold, window and observation count", () => {
    renderTable([condition()], lightTheme, (id) => (id === "c2" ? "change_pct" : undefined));
    const row = screen.getByTestId("condition-table-row");
    expect(within(row).getByText("c2")).toBeInTheDocument();
    expect(within(row).getByText("brent_crude")).toBeInTheDocument();
    expect(within(row).getByText("change_pct")).toBeInTheDocument();
    expect(within(row).getByText("tripped")).toBeInTheDocument();
    expect(within(row).getByText("-12.4")).toBeInTheDocument();
    // The comparison, not just the number: the reader is looking at
    // `value <op> threshold` and "-10" alone does not say which side trips.
    expect(within(row).getByText("< -10")).toBeInTheDocument();
    expect(within(row).getByText("1 Jun 2026–21 Aug 2026")).toBeInTheDocument();
    expect(within(row).getByText("58")).toBeInTheDocument();
  });

  it("renders an em dash for the statistic when there is no spec — never a guessed one", () => {
    renderTable([condition()]);
    const row = screen.getByTestId("condition-table-row");
    expect(within(row).getByText("brent_crude")).toBeInTheDocument();
    expect(row.querySelectorAll("td").length).toBe(8);
    // 🔴 The CONTENT, not just the column. A statistic Wolf invented — say a
    // default of "level" — would read as one the spec recorded, and this page
    // must never print a value nobody wrote.
    const statistic = row.querySelectorAll("td")[2];
    expect(statistic?.textContent).toBe("—");
  });

  it("renders an explicit empty state rather than an empty table", () => {
    renderTable([]);
    expect(screen.getByTestId("condition-table-empty")).toHaveTextContent(
      "no conditions have been evaluated yet",
    );
    expect(screen.queryByTestId("condition-table")).toBeNull();
  });
});

describe("🔴 indeterminate is visually distinct from holding", () => {
  it.each(THEMES)("%s: indeterminate takes warning, holding takes neutral, and they differ", (_mode, theme) => {
    render(
      <ThemeProvider theme={theme}>
        <ConditionTable
          conditions={[
            condition({ id: "c1", state: "holding", reason: null }),
            condition({ id: "c3", state: "indeterminate", reason: "insufficient_coverage" }),
          ]}
        />
      </ThemeProvider>,
    );
    const holding = screen.getByText("holding");
    const indeterminate = screen.getByText("indeterminate");
    const holdingColour = rgba(getComputedStyle(holding).color);
    const indeterminateColour = rgba(getComputedStyle(indeterminate).color);

    expect(holdingColour).toBe(rgba(theme.palette.text.secondary));
    expect(indeterminateColour).toBe(rgba(theme.palette.warning.main));
    expect(indeterminateColour).not.toBe(holdingColour);
    // Never green: a hypothesis holding on every condition can still be a bad
    // thesis, and colouring it green quietly editorialises (§ 2b).
    expect(holdingColour).not.toBe(rgba(theme.palette.success.main));
  });

  it("gives the indeterminate row a DASHED rule and the others a solid one, so the state survives greyscale", () => {
    renderTable([
      condition({ id: "c1", state: "holding", reason: null }),
      condition({ id: "c2", state: "tripped" }),
      condition({ id: "c3", state: "indeterminate", reason: "stale_data" }),
    ]);
    const [c1, c2, c3] = screen.getAllByTestId("condition-table-row");
    expect(c1).toHaveAttribute("data-rule-style", "solid");
    expect(c2).toHaveAttribute("data-rule-style", "solid");
    expect(c3).toHaveAttribute("data-rule-style", "dashed");
    const cell = c3?.querySelector("td");
    expect(cell).not.toBeNull();
    expect(getComputedStyle(cell as Element).borderBottomStyle).toBe("dashed");
  });

  it("marks an indeterminate row degraded, and leaves holding and tripped with no severity at all", () => {
    renderTable([
      condition({ id: "c1", state: "holding", reason: null }),
      condition({ id: "c2", state: "tripped" }),
      condition({ id: "c3", state: "indeterminate", reason: "no_observations" }),
    ]);
    const markers = screen.getAllByTestId("severity");
    expect(markers.length).toBe(1);
    expect(markers[0]).toHaveAttribute("data-severity", "degraded");
  });
});

describe("🔴 tripped is the accent, and error red appears nowhere", () => {
  it.each(THEMES)("%s: tripped takes primary.main, never error.main", (_mode, theme) => {
    render(
      <ThemeProvider theme={theme}>
        <ConditionTable conditions={[condition({ state: "tripped" })]} />
      </ThemeProvider>,
    );
    const colour = rgba(getComputedStyle(screen.getByText("tripped")).color);
    expect(colour).toBe(rgba(theme.palette.primary.main));
    expect(colour).not.toBe(rgba(theme.palette.error.main));
  });

  it.each(THEMES)("%s: no element in the whole table computes to the error colour", (_mode, theme) => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ConditionTable
          conditions={[
            condition({ id: "c1", state: "holding", reason: null }),
            condition({ id: "c2", state: "tripped" }),
            condition({ id: "c3", state: "indeterminate", reason: "stale_data" }),
          ]}
        />
      </ThemeProvider>,
    );
    const error = rgba(theme.palette.error.main);
    const colours = Array.from(container.querySelectorAll("*")).map((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor, style.borderBottomColor];
    });
    expect(colours.length).toBeGreaterThan(0);
    for (const group of colours) {
      for (const value of group) {
        // jsdom hands back CSS system keywords (`canvastext`) for anything
        // unset, which `decomposeColor` cannot parse. Only real colour values
        // are compared; the assertion below still sees every colour the
        // component actually SETS.
        if (!/^(#|rgb|hsl)/.test(value) || value === "rgba(0, 0, 0, 0)") continue;
        expect(rgba(value)).not.toBe(error);
      }
    }
  });
});

describe("🔴 the reason renders VERBATIM", () => {
  it("shows a recognised reason as its raw token, with the gloss after it", () => {
    renderTable([condition({ state: "indeterminate", reason: "non_positive_reference" })]);
    const marker = screen.getByTestId("severity");
    expect(marker).toHaveTextContent("non_positive_reference");
    expect(marker).toHaveTextContent("the reference value was zero or negative");
  });

  it("renders a reason OUTSIDE W4's closed set verbatim rather than dropping it", () => {
    // `stale_series` is the value W14's own ticket enumerates and W4 never
    // emits (it emits `stale_data`). A UI that only rendered tokens it
    // recognised would show this row with a blank reason — which is exactly
    // how a spec mistake stays invisible.
    renderTable([condition({ state: "indeterminate", reason: "stale_series" })]);
    expect(screen.getByTestId("severity")).toHaveTextContent("indeterminate — stale_series");
  });

  it("never renders a blank cause when the reason is null or empty", () => {
    renderTable([condition({ state: "indeterminate", reason: null })]);
    expect(screen.getByTestId("severity")).toHaveTextContent(NO_REASON_GIVEN);
    expect(indeterminateCause("")).toContain(NO_REASON_GIVEN);
    expect(indeterminateCause(undefined)).toContain(NO_REASON_GIVEN);
  });
});

describe("🔴 the word is `indeterminate`, never `unknown`", () => {
  it("uses the word indeterminate and never the word unknown", () => {
    const { container } = renderTable([
      condition({ id: "c1", state: "holding", reason: null }),
      condition({ id: "c3", state: "indeterminate", reason: "insufficient_coverage" }),
    ]);
    expect(container.textContent).toContain("indeterminate");
    expect(container.textContent?.toLowerCase()).not.toContain("unknown");
  });
});

describe("a state W4 does not emit", () => {
  it("renders the value verbatim and does NOT give it the holding treatment", () => {
    renderTable([condition({ id: "c9", state: "somehow_new", reason: "who_knows" })]);
    const row = stateCellOf("c9");
    expect(within(row).getByText("somehow_new")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-rule-style", "dashed");
    expect(screen.getByTestId("severity")).toHaveTextContent("who_knows");
    expect(rgba(getComputedStyle(screen.getByText("somehow_new")).color)).toBe(
      rgba(lightTheme.palette.warning.main),
    );
  });
});
