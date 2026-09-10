/**
 * Wolf's theme — the single implementation of
 * `design/2026-08-24-agent-wolf-ui.md` § 2b "Visual direction" (agent-bob
 * repo). W13, W14, W23 and W24 IMPORT from here; none of them adds a second
 * theme, a second palette or its own severity treatment. That is the whole
 * point of W28 running first.
 *
 * The five principles § 2b states, and where each one lives below:
 *
 *   1. Colour is scarce, and spent almost entirely on severity  → `PALETTE`
 *   2. NEVER colour a metric by which way it moved              → there is no
 *      up/down colour token here to reach for. Movement is the direction glyph
 *      and the expected-versus-realised pairing. `success.main` is a
 *      `confirmed` VERDICT and nothing else.
 *   3. Numbers are the interface                                → `tabular-nums`
 *      on `body` and on the `mono` variant
 *   4. Density over air                                         → `spacing: 6`,
 *      `MuiTableCell`, `MuiChip`, `BOARD_ROW_*`
 *   5. Dark-first, following the OS                             → `useWolfTheme`
 *
 * 🔴 `error` red means exactly ONE thing in this product: something wrote what
 * it had no right to write (severity `attacked`). A `tripped` condition is the
 * ACCENT, because a trip is the system working correctly and consequentially,
 * while an attack is the system being lied to. `web/src/components/trust/
 * Severity.test.tsx` asserts this by rendering every other trust state and
 * checking none of them computes to the error colour.
 */
import { createTheme, type Theme, type ThemeOptions } from "@mui/material/styles";
import { useMediaQuery } from "@mui/material";
import type { CSSProperties } from "react";

/** The colour mode. There is no third value and no manual override — see `useWolfTheme`. */
export type WolfColorMode = "light" | "dark";

/**
 * § 2b "The palette", verbatim. Neutral ground, one accent, two semantic
 * colours — and metric movement uses none of them.
 *
 * The right-hand column of § 2b's table is a *prohibition*, not a hint: each
 * role is used for what it names and for nothing else.
 */
export const PALETTE = {
  light: {
    /** ground */
    background: "#fbfbfc",
    /** paper */
    paper: "#ffffff",
    textPrimary: "#12161c",
    textSecondary: "#5a6472",
    /** interactive affordances AND `tripped` conditions */
    accent: "#1f6feb",
    /** `indeterminate`, and severity `degraded` */
    warning: "#9a6700",
    /** severity `attacked` — nowhere else in the entire UI */
    error: "#cf222e",
    /** a `confirmed` verdict only */
    positive: "#1a7f37",
    /** the `model` provenance channel — non-semantic BY CONSTRUCTION */
    provenanceGround: "rgba(0,0,0,0.025)",
    /** the 2px left rule on model-authored content */
    provenanceRule: "rgba(0,0,0,0.12)",
  },
  dark: {
    background: "#0e1116",
    paper: "#161b22",
    textPrimary: "#e6edf3",
    textSecondary: "#8b949e",
    accent: "#58a6ff",
    warning: "#d29922",
    error: "#f85149",
    positive: "#3fb950",
    provenanceGround: "rgba(255,255,255,0.035)",
    provenanceRule: "rgba(255,255,255,0.14)",
  },
} as const satisfies Record<WolfColorMode, Record<string, string>>;

/** § 2b "Typography": the system stack. No web font — a font request is a remote fetch, and this product argues about remote fetches for a living. */
export const UI_FONT_FAMILY =
  '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** § 2b "Typography": figures, ids, slugs, metric names, hashes, timestamps. A metric slug is an identifier and should look like one. */
export const MONO_FONT_FAMILY =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** § 2b principle 3. Applied to `body` (so it reaches every figure) and to the `mono` variant. */
export const TABULAR_NUMS = "tabular-nums";

/** § 2b "Typography": base 14px. */
export const BASE_FONT_SIZE_PX = 14;

/** § 2b "Typography": board rows 13px. W13 consumes this rather than re-deciding it. */
export const BOARD_ROW_FONT_SIZE_PX = 13;

/** § 2b principle 4: "Target a 40px board row." W13 consumes this rather than re-deciding it. */
export const BOARD_ROW_HEIGHT_PX = 40;

/** § 2b "Density": MUI's `1` unit is 6px here, not 8px. */
export const SPACING_PX = 6;

/**
 * § 2b "Condition and severity glyphs" — never colour-alone. Every state
 * carries a glyph AS WELL AS a colour, so the state survives a greyscale
 * screenshot, colour-blindness, and a screenshot pasted into a chat.
 */
export const CONDITION_GLYPHS = {
  holding: "●",
  tripped: "◉",
  indeterminate: "△",
} as const;

export const SEVERITY_GLYPHS = {
  degraded: "△",
  attacked: "◉",
} as const;

export type ConditionState = keyof typeof CONDITION_GLYPHS;

/**
 * § 2b's glyph table gives `indeterminate` one extra affordance: "a **dashed**
 * rule on the row, so it survives colour-blindness". Exported so W14's
 * condition table reads it rather than re-deciding it.
 */
export const CONDITION_ROW_RULE_STYLE = {
  holding: "solid",
  tripped: "solid",
  indeterminate: "dashed",
} as const satisfies Record<ConditionState, "solid" | "dashed">;

/**
 * The colour for a condition state, § 2b's glyph table.
 *
 * `holding` is deliberately **neutral and low-emphasis, not green**: a
 * hypothesis holding on every condition can still be a bad thesis, and
 * colouring it green quietly editorialises. It is also what keeps
 * `indeterminate` (warning) unmistakably distinct from `holding` (neutral).
 */
export function conditionColor(theme: Theme, state: ConditionState): string {
  switch (state) {
    case "tripped":
      return theme.palette.primary.main;
    case "indeterminate":
      return theme.palette.warning.main;
    case "holding":
      return theme.palette.text.secondary;
  }
}

function themeOptions(mode: WolfColorMode): ThemeOptions {
  const c = PALETTE[mode];
  return {
    spacing: SPACING_PX,
    palette: {
      mode,
      background: { default: c.background, paper: c.paper },
      text: { primary: c.textPrimary, secondary: c.textSecondary },
      primary: { main: c.accent },
      warning: { main: c.warning },
      error: { main: c.error },
      success: { main: c.positive },
      provenance: { ground: c.provenanceGround, rule: c.provenanceRule },
    },
    typography: {
      fontFamily: UI_FONT_FAMILY,
      fontSize: BASE_FONT_SIZE_PX,
      mono: {
        fontFamily: MONO_FONT_FAMILY,
        fontVariantNumeric: TABULAR_NUMS,
        fontSize: BOARD_ROW_FONT_SIZE_PX,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // Principle 3, "numbers are the interface": a column of scores
          // aligns and a changing digit never reflows its row.
          body: { fontVariantNumeric: TABULAR_NUMS },
        },
      },
      MuiTypography: {
        // A custom variant has no default element; without this it renders a
        // <span>, which is right for an inline identifier but only by accident.
        defaultProps: { variantMapping: { mono: "span" } },
      },
      // § 2b "Density". MUI 6's defaults are too generous — the board is a
      // table, not a card gallery.
      MuiTableCell: {
        styleOverrides: { root: { padding: "6px 12px" } },
      },
      MuiChip: {
        defaultProps: { size: "small" },
      },
    },
  };
}

/**
 * Two theme objects, not one with `mode` flipped — the same rule the Orange
 * console shell and its embed page follow.
 */
export const lightTheme: Theme = createTheme(themeOptions("light"));
export const darkTheme: Theme = createTheme(themeOptions("dark"));

export function wolfTheme(mode: WolfColorMode): Theme {
  return mode === "dark" ? darkTheme : lightTheme;
}

/**
 * § 2b principle 5, and it is a necessity rather than a taste: the Orange rail
 * Wolf iframes reads `prefers-color-scheme` and **cannot be told otherwise**
 * (`examples/web/src/EmbedSession.tsx:77-80` — `useMediaQuery(
 * "(prefers-color-scheme: dark)")`, two theme objects, no prop and no toggle).
 * Wolf follows the identical rule, so the page and the rail inside it agree by
 * construction instead of visibly disagreeing for half of users.
 *
 * There is deliberately no setter, no toggle and no persisted preference.
 * Adding one would put Wolf and the embedded rail into different modes with no
 * way to reconcile them.
 */
export function useWolfTheme(): Theme {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  return prefersDark ? darkTheme : lightTheme;
}

declare module "@mui/material/styles" {
  interface Palette {
    /**
     * The provenance channel's ground and rule. Non-semantic by construction:
     * see `Provenance` and § 2 "Channel P".
     */
    provenance: { ground: string; rule: string };
  }
  interface PaletteOptions {
    provenance?: { ground: string; rule: string };
  }
  interface TypographyVariants {
    /** Figures, ids, slugs, metric names, hashes, timestamps. */
    mono: CSSProperties;
  }
  interface TypographyVariantsOptions {
    mono?: CSSProperties;
  }
}

declare module "@mui/material/Typography" {
  interface TypographyPropsVariantOverrides {
    mono: true;
  }
}
