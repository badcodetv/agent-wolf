/**
 * W28 — Channel P. `design/2026-08-24-agent-wolf-ui.md` § 2 (agent-bob repo).
 *
 * The load-bearing test in this file is the last one: the `model` ground uses
 * **no** semantic palette colour, at any shade, in either mode. If provenance
 * ever borrows `warning`, `error` or `info`, every research note — the normal,
 * useful, everyday output — reads as a problem, and the whole trust language
 * fails silently and looks fine while doing it.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { decomposeColor } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import type { ReactNode } from "react";
import Provenance, { UNKNOWN_WRITER, provenanceStamp, relativeTime } from "./Provenance.js";
import { darkTheme, lightTheme } from "../../theme.js";

afterEach(cleanup);

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

describe('kind="machine" — no treatment at all', () => {
  it("renders its children with no wrapper element", () => {
    const { container } = inTheme(
      lightTheme,
      <Provenance kind="machine">
        <span data-testid="child">computed by Wolf</span>
      </Provenance>,
    );
    // Not "a wrapper with no styles" — no wrapper. Machine-authored content IS
    // the default ground, so this must be indistinguishable from not using the
    // component at all.
    expect(container.innerHTML).toBe('<span data-testid="child">computed by Wolf</span>');
    expect(container.querySelector('[data-testid="provenance"]')).toBeNull();
    expect(container.querySelector('[data-testid="provenance-stamp"]')).toBeNull();
  });

  it("renders no stamp, even when a worker and a time are supplied", () => {
    inTheme(
      lightTheme,
      <Provenance kind="machine" worker="researcher-4f2a" atMs={Date.now()}>
        <span>x</span>
      </Provenance>,
    );
    expect(screen.queryByTestId("provenance-stamp")).toBeNull();
  });
});

describe('kind="model" — ground, 2px rule, stamp', () => {
  it("wraps the children and stamps them", () => {
    inTheme(
      lightTheme,
      <Provenance kind="model" worker="researcher-4f2a" atMs={Date.now() - 3 * 24 * 60 * 60 * 1000}>
        <span data-testid="child">the model wrote this</span>
      </Provenance>,
    );
    const wrapper = screen.getByTestId("provenance");
    expect(wrapper).toContainElement(screen.getByTestId("child"));
    expect(screen.getByTestId("provenance-stamp")).toHaveTextContent("researcher-4f2a · 3 days ago");
  });

  it.each(THEMES)("%s: paints the ground and the 2px left rule from the provenance tokens", (_mode, theme) => {
    inTheme(
      theme,
      <Provenance kind="model" worker="w" atMs={0}>
        <span>x</span>
      </Provenance>,
    );
    const style = getComputedStyle(screen.getByTestId("provenance"));
    expect(rgba(style.backgroundColor)).toBe(rgba(theme.palette.provenance.ground));
    expect(style.borderLeftWidth).toBe("2px");
    expect(style.borderLeftStyle).toBe("solid");
    expect(rgba(style.borderLeftColor)).toBe(rgba(theme.palette.provenance.rule));
  });

  it("names the worker, falls back to the session, and never renders a blank writer", () => {
    expect(provenanceStamp({ worker: "researcher-4f2a", session: "hyp-1a2b3c4d" })).toBe("researcher-4f2a");
    expect(provenanceStamp({ worker: "", session: "hyp-1a2b3c4d" })).toBe("hyp-1a2b3c4d");
    expect(provenanceStamp({ worker: null, session: null })).toBe(UNKNOWN_WRITER);
    expect(provenanceStamp({})).toBe(UNKNOWN_WRITER);
  });

  it("omits the time rather than inventing one when there is no timestamp", () => {
    expect(provenanceStamp({ worker: "w" })).toBe("w");
    expect(provenanceStamp({ worker: "w", atMs: null })).toBe("w");
    expect(relativeTime(undefined)).toBeUndefined();
    expect(relativeTime(Number.NaN)).toBeUndefined();
  });

  it("renders unix MILLISECONDS as a relative phrase", () => {
    const now = 1_789_000_000_000;
    expect(relativeTime(now - 45 * 1000, now)).toBe("45 seconds ago");
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3 * 60 * 60 * 1000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 2 * 24 * 60 * 60 * 1000, now)).toBe("2 days ago");
    expect(relativeTime(now - 400 * 24 * 60 * 60 * 1000, now)).toBe("last year");
  });
});

describe("🔴 the provenance ground borrows NO semantic colour", () => {
  it.each(THEMES)(
    "%s: the rendered background matches neither warning nor error nor info, at any shade",
    (_mode, theme) => {
      inTheme(
        theme,
        <Provenance kind="model" worker="researcher-4f2a" atMs={0}>
          <span>a perfectly ordinary daily research note</span>
        </Provenance>,
      );
      const style = getComputedStyle(screen.getByTestId("provenance"));

      const forbidden = new Set(
        (["warning", "error", "info"] as const).flatMap((role) =>
          [
            theme.palette[role].main,
            theme.palette[role].light,
            theme.palette[role].dark,
            theme.palette[role].contrastText,
          ].map(rgba),
        ),
      );

      expect(forbidden.size).toBeGreaterThan(0); // the assertion below is only meaningful if there is something to fail against
      expect(forbidden.has(rgba(style.backgroundColor))).toBe(false);
      expect(forbidden.has(rgba(style.borderLeftColor))).toBe(false);
    },
  );
});
