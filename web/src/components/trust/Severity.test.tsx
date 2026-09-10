/**
 * W28 — Channel S. `design/2026-08-24-agent-wolf-ui.md` § 2 (agent-bob repo).
 *
 * Two load-bearing tests here:
 *
 *   1. `<Severity>` refuses to render without a cause — throwing in
 *      development, silent in production. A bare marker that does not say what
 *      happened is how a spec mistake stays invisible for three weeks.
 *   2. 🔴 `error` red appears NOWHERE but `attacked`. The last describe block
 *      renders every other trust state — `none`, `degraded`, both provenance
 *      kinds, and all three condition states — and asserts that not one of
 *      them computes to the error colour, in either mode.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Box, ThemeProvider } from "@mui/material";
import { decomposeColor } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import type { ReactNode } from "react";
import Severity from "./Severity.js";
import Provenance from "./Provenance.js";
import { CONDITION_GLYPHS, SEVERITY_GLYPHS, conditionColor, darkTheme, lightTheme } from "../../theme.js";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const THEMES = [
  ["light", lightTheme],
  ["dark", darkTheme],
] as const;

function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

function inTheme(theme: Theme, node: ReactNode) {
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

/** Every colour any element in `container` actually computes to. */
function renderedColors(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    const s = getComputedStyle(el);
    for (const value of [s.color, s.backgroundColor, s.borderLeftColor, s.borderTopColor, s.fill, s.outlineColor]) {
      if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") continue;
      try {
        out.push(rgba(value));
      } catch {
        // Not a colour jsdom resolved (e.g. "currentcolor", "none") — nothing to compare.
      }
    }
  }
  return out;
}

describe('level="none" — nothing rendered', () => {
  it("renders nothing at all, with or without a cause", () => {
    const { container } = inTheme(lightTheme, <Severity level="none" />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const second = inTheme(lightTheme, <Severity level="none" cause="ignored" />);
    expect(second.container.innerHTML).toBe("");
  });
});

describe("🔴 no default cause — it refuses to render without one", () => {
  // A render-phase throw is EXPECTED in these cases, and React makes it noisy
  // twice over: it logs the component stack to console.error, and (in dev) it
  // rethrows through a synthetic DOM error event, which jsdom's virtual
  // console reports as "Uncaught [Error: …]" independently of the console spy.
  // Silencing both keeps a passing run's output honest — an expected failure
  // printed as a stack trace is how a real one gets scrolled past.
  function quietReact(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    return () => {
      window.removeEventListener("error", swallow);
      spy.mockRestore();
    };
  }

  it.each([
    ["degraded", undefined],
    ["degraded", ""],
    ["degraded", "   "],
    ["attacked", undefined],
    ["attacked", ""],
    ["attacked", "\t\n "],
  ] as const)("throws in development: level=%s cause=%j", (level, cause) => {
    const restore = quietReact();
    try {
      expect(import.meta.env.MODE).not.toBe("production"); // the premise of this test
      expect(() => inTheme(lightTheme, <Severity level={level} cause={cause} />)).toThrow(/without a cause/);
    } finally {
      restore();
    }
  });

  it.each(["degraded", "attacked"] as const)("renders nothing in production: level=%s", (level) => {
    vi.stubEnv("MODE", "production");
    const { container } = inTheme(lightTheme, <Severity level={level} cause="  " />);
    expect(container.innerHTML).toBe("");
  });

  it("still renders normally in production when a cause IS given", () => {
    vi.stubEnv("MODE", "production");
    inTheme(lightTheme, <Severity level="degraded" cause="no update since 12 Aug" />);
    expect(screen.getByTestId("severity")).toHaveTextContent("no update since 12 Aug");
  });
});

describe('level="degraded" — warning-toned marker plus a sentence', () => {
  it.each(THEMES)("%s: carries the glyph AS WELL AS the colour, and the cause verbatim", (_mode, theme) => {
    inTheme(
      theme,
      <Severity level="degraded" cause="no update since 12 Aug — FRED restated DGS10" />,
    );
    const marker = screen.getByTestId("severity");
    expect(marker.dataset.severity).toBe("degraded");
    // Never a bare icon: the sentence is mandatory and it is what a reader acts on.
    expect(marker).toHaveTextContent("no update since 12 Aug — FRED restated DGS10");
    // Never colour-alone: the glyph survives a greyscale screenshot.
    expect(marker.textContent).toContain(SEVERITY_GLYPHS.degraded);
    expect(rgba(getComputedStyle(marker).color)).toBe(rgba(theme.palette.warning.main));
  });
});

describe('level="attacked" — full-width error Alert', () => {
  it.each(THEMES)("%s: names what happened, carries the glyph, and IS the error colour", (_mode, theme) => {
    const { container } = inTheme(
      theme,
      <Severity level="attacked" cause="forged row — researcher-9c1b wrote memory mem_7f3a" />,
    );
    const alert = screen.getByTestId("severity");
    expect(alert.dataset.severity).toBe("attacked");
    // The MUI severity PROP, not just our data-attribute: flipping it to
    // "warning" changes the rendered colour and the a11y role and, before
    // this line existed, nothing went red. § 2 pins `Alert severity="error"`
    // and four tickets (W13, W14, W23, W24) consume this component.
    expect(alert).toHaveClass("MuiAlert-colorError");
    expect(alert).toHaveAttribute("role", "alert");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(alert).toHaveTextContent("forged row — researcher-9c1b wrote memory mem_7f3a");
    expect(alert.textContent).toContain(SEVERITY_GLYPHS.attacked);
    expect(getComputedStyle(alert).width).toBe("100%");
    // This is the ONE place in the product where the error red is allowed.
    expect(renderedColors(container)).toContain(rgba(theme.palette.error.main));
  });
});

describe("🔴 `error` red appears nowhere but severity `attacked`", () => {
  it.each(THEMES)("%s: every other trust state computes to something else", (_mode, theme) => {
    const { container } = inTheme(
      theme,
      <Box>
        {/* Channel S, everything short of an attack */}
        <Severity level="none" />
        <Severity level="degraded" cause="stripped 3 elements from the report candidate" />
        <Severity level="degraded" cause="report drift — 2 unfilled slots" />
        {/* Channel P, both values */}
        <Provenance kind="machine">
          <span>the scoreboard, computed by Wolf</span>
        </Provenance>
        <Provenance kind="model" worker="researcher-4f2a" atMs={0}>
          <span>a daily research note</span>
        </Provenance>
        {/* Every condition state, including the consequential one */}
        {(["holding", "tripped", "indeterminate"] as const).map((state) => (
          <Box key={state} sx={{ color: conditionColor(theme, state) }}>
            {CONDITION_GLYPHS[state]} {state}
          </Box>
        ))}
      </Box>,
    );

    const error = rgba(theme.palette.error.main);
    expect(container.querySelectorAll("*").length).toBeGreaterThan(5); // something really was rendered
    expect(renderedColors(container)).not.toContain(error);
  });
});
