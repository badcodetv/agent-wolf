/**
 * W23 — the band above the verdict buttons.
 *
 * The two rules it exists to keep are the two easiest to break by accident:
 * `indeterminate` must never read as `holding`, and the score must never read
 * as a decision.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider, decomposeColor } from "@mui/material/styles";
import VerdictBand from "./VerdictBand.js";
import { darkTheme, lightTheme } from "../theme.js";
import type { ConditionResult, EvaluationResult } from "../api/types.js";

const THEMES: Array<[string, typeof lightTheme]> = [
  ["light", lightTheme],
  ["dark", darkTheme],
];

function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

/** jsdom answers unset colours with system keywords (`canvastext`) that MUI cannot decompose. */
function parsable(color: string): boolean {
  return /^(#|rgb|hsl|color\()/.test(color.trim());
}

function condition(over: Partial<ConditionResult> = {}): ConditionResult {
  return {
    id: "c1",
    metric: "brent_crude",
    state: "holding",
    reason: null,
    value: 1,
    threshold: 2,
    op: "lt",
    window_start_ms: 1_780_000_000_000,
    window_end_ms: 1_789_000_000_000,
    observations_in_window: 58,
    ...over,
  };
}

function evaluation(over: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluated_at_ms: 1_789_000_000_123,
    support_score: 0.1,
    conditions: [],
    metrics: [],
    ...over,
  };
}

function renderBand(
  props: { status?: string | null; evaluation?: EvaluationResult | null } = {},
  theme = lightTheme,
) {
  return render(
    <ThemeProvider theme={theme}>
      <VerdictBand
        // NOT `?? "challenged"`: `status: null` is a case under test, and a
        // nullish default would quietly turn it into the happy one.
        status={"status" in props ? (props.status ?? null) : "challenged"}
        evaluation={props.evaluation ?? null}
      />
    </ThemeProvider>,
  );
}

function countText(state: string): string {
  return (
    within(screen.getByTestId("verdict-band"))
      .getByTestId(`verdict-band-count-${state}`)
      .textContent ?? ""
  );
}

// ── Status, score, counts ───────────────────────────────────────────────

describe("what the band shows", () => {
  it("shows the lifecycle state verbatim", () => {
    renderBand({ status: "challenged" });
    expect(screen.getByTestId("verdict-band-status")).toHaveTextContent("challenged");
  });

  it("shows a state it does not recognise rather than dropping it", () => {
    renderBand({ status: "somehow_new" });
    expect(screen.getByTestId("verdict-band-status")).toHaveTextContent("somehow_new");
  });

  it("names the absence of a trusted state row instead of rendering a blank", () => {
    renderBand({ status: null });
    expect(screen.getByTestId("verdict-band-status")).toHaveTextContent("no state row");
  });

  it("shows the support score to two decimals", () => {
    renderBand({ evaluation: evaluation({ support_score: -0.5 }) });
    expect(screen.getByTestId("verdict-band-score")).toHaveTextContent("-0.50");
  });

  it("shows an em dash, never a zero, when there is no evaluation", () => {
    renderBand({ evaluation: null });
    // A zero is a real score. The absence of one is not, and rendering the
    // second as the first invents a reading nothing produced.
    expect(screen.getByTestId("verdict-band-score")).toHaveTextContent("—");
    expect(screen.getByTestId("verdict-band-score")).not.toHaveTextContent("0.00");
    // The sentence is load-bearing: "tripped 0 · holding 0" with no words
    // beside it reads as "nothing has tripped", which is a claim about the
    // world rather than about our own arithmetic never having run.
    expect(screen.getByTestId("verdict-band")).toHaveTextContent(
      "not evaluated yet — the daily researcher has not produced a reading",
    );
  });

  it("🔴 says the score summarises and does not decide", () => {
    renderBand({ evaluation: evaluation() });
    // Asserted as the literal a human reads, not as the imported constant:
    // an assertion that imports the string it checks passes whatever the
    // string becomes.
    expect(screen.getByTestId("verdict-band-note")).toHaveTextContent(
      "summary only — it decides nothing, only conditions do",
    );
  });

  it("counts the three condition states", () => {
    renderBand({
      evaluation: evaluation({
        conditions: [
          condition({ id: "c1", state: "holding" }),
          condition({ id: "c2", state: "tripped" }),
          condition({ id: "c3", state: "indeterminate", reason: "insufficient_coverage" }),
          condition({ id: "c4", state: "tripped" }),
        ],
      }),
    });
    expect(countText("tripped")).toContain("2");
    expect(countText("holding")).toContain("1");
    expect(countText("indeterminate")).toContain("1");
  });

  it("counts a state it does not recognise as indeterminate rather than losing it", () => {
    renderBand({
      evaluation: evaluation({
        conditions: [condition({ id: "c1", state: "holding" }), condition({ id: "c9", state: "wat" })],
      }),
    });
    // The condition table gives an unrecognised state the indeterminate
    // treatment for the same reason: "we could not tell" is what an unknown
    // state means here, and a count that silently drops a row makes the three
    // figures add up to fewer conditions than the table below shows.
    expect(countText("indeterminate")).toContain("1");
    expect(countText("holding")).toContain("1");
    expect(countText("tripped")).toContain("0");
  });

  it("survives an evaluation whose conditions are not an array", () => {
    renderBand({
      evaluation: evaluation({ conditions: "nope" as unknown as ConditionResult[] }),
    });
    // The wire types the evaluation `unknown` and the server re-serves
    // whatever the memory held. A malformed one costs the counts, never the
    // page carrying the verdict buttons (R140).
    expect(countText("tripped")).toContain("0");
  });
});

// ── indeterminate is not holding ────────────────────────────────────────

describe("🔴 indeterminate is visually distinct from holding", () => {
  it.each(THEMES)("%s: warning against neutral, and never green", (_mode, theme) => {
    renderBand(
      {
        evaluation: evaluation({
          conditions: [
            condition({ id: "c1", state: "holding" }),
            condition({ id: "c3", state: "indeterminate", reason: "stale_data" }),
          ],
        }),
      },
      theme,
    );
    const holding = rgba(
      getComputedStyle(screen.getByTestId("verdict-band-count-holding")).color,
    );
    const indeterminate = rgba(
      getComputedStyle(screen.getByTestId("verdict-band-count-indeterminate")).color,
    );
    expect(indeterminate).toBe(rgba(theme.palette.warning.main));
    expect(holding).toBe(rgba(theme.palette.text.secondary));
    expect(indeterminate).not.toBe(holding);
    // `holding` is deliberately not green: a hypothesis holding on every
    // condition can still be a bad thesis.
    expect(holding).not.toBe(rgba(theme.palette.success.main));
  });

  it("gives each state its own glyph, so the three read in greyscale", () => {
    renderBand({
      evaluation: evaluation({
        conditions: [
          condition({ id: "c1", state: "holding" }),
          condition({ id: "c2", state: "tripped" }),
          condition({ id: "c3", state: "indeterminate", reason: "no_observations" }),
        ],
      }),
    });
    expect(countText("holding")).toContain("●");
    expect(countText("tripped")).toContain("◉");
    expect(countText("indeterminate")).toContain("△");
    // Never glyph-alone either: § 2b's rule is a glyph AND a word, so the
    // three labels are pinned as literals beside their glyphs. Without this,
    // a band rendering three bare figures passes every other assertion here.
    expect(countText("holding")).toContain("holding");
    expect(countText("tripped")).toContain("tripped");
    expect(countText("indeterminate")).toContain("indeterminate");
  });

  it("gives the indeterminate figure a DASHED rule and the others a solid one", () => {
    renderBand({ evaluation: evaluation() });
    expect(screen.getByTestId("verdict-band-count-holding")).toHaveAttribute("data-rule-style", "solid");
    expect(screen.getByTestId("verdict-band-count-tripped")).toHaveAttribute("data-rule-style", "solid");
    const indeterminate = screen.getByTestId("verdict-band-count-indeterminate");
    expect(indeterminate).toHaveAttribute("data-rule-style", "dashed");
    expect(getComputedStyle(indeterminate).borderBottomStyle).toBe("dashed");
  });

  it('🔴 never uses the word "unknown"', () => {
    renderBand({
      evaluation: evaluation({
        conditions: [condition({ id: "c3", state: "indeterminate", reason: "stale_data" })],
      }),
    });
    // The word is `indeterminate` throughout the product. "Unknown" invites
    // the reader to assume it is fine; "indeterminate" says Wolf's own
    // arithmetic could not tell.
    expect(screen.getByTestId("verdict-band").textContent ?? "").not.toMatch(/unknown/i);
    expect(screen.getByTestId("verdict-band").textContent ?? "").toMatch(/indeterminate/);
  });
});

// ── colour discipline ───────────────────────────────────────────────────

describe("🔴 error red appears nowhere in the band", () => {
  it.each(THEMES)("%s: no element computes to the error colour", (_mode, theme) => {
    renderBand(
      {
        status: "challenged",
        evaluation: evaluation({
          support_score: -0.9,
          conditions: [
            condition({ id: "c1", state: "holding" }),
            condition({ id: "c2", state: "tripped" }),
            condition({ id: "c3", state: "indeterminate", reason: "stale_data" }),
          ],
        }),
      },
      theme,
    );
    const error = rgba(theme.palette.error.main);
    const band = screen.getByTestId("verdict-band");
    let checked = 0;
    for (const node of [band, ...Array.from(band.querySelectorAll("*"))]) {
      const style = getComputedStyle(node);
      // `tripped` is the ACCENT, not red. Red means something wrote what it
      // had no right to write, and sharing the colour would blunt both.
      for (const value of [style.color, style.backgroundColor, style.borderBottomColor]) {
        if (!parsable(value)) continue;
        checked += 1;
        expect(rgba(value)).not.toBe(error);
      }
    }
    // Without this the loop above passes on a band that declares no colours
    // at all — including one this component never rendered.
    expect(checked).toBeGreaterThan(3);
  });

  it.each(THEMES)("%s: a negative score is not coloured differently from a positive one", (_mode, theme) => {
    const { unmount } = renderBand({ evaluation: evaluation({ support_score: 0.8 }) }, theme);
    const positive = rgba(getComputedStyle(screen.getByTestId("verdict-band-score")).color);
    unmount();
    renderBand({ evaluation: evaluation({ support_score: -0.8 }) }, theme);
    const negative = rgba(getComputedStyle(screen.getByTestId("verdict-band-score")).color);
    // § 2b principle 2: a thesis predicting a fall SUCCEEDS when the line
    // drops, so colouring the summary by sign is not a taste violation here,
    // it is backwards.
    expect(negative).toBe(positive);
    expect(positive).toBe(rgba(theme.palette.text.primary));
  });
});
