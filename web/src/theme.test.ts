/**
 * W28 — the theme is `design/2026-08-24-agent-wolf-ui.md` § 2b in code
 * (agent-bob repo), so these tests are § 2b read back out of the built
 * theme object. They are deliberately literal: § 2b is the specification four
 * later tickets consume, and a palette that silently drifts from it is exactly
 * the failure W28 exists to prevent.
 *
 * The RENDERED assertions — provenance's ground against every semantic shade,
 * and `error` red appearing nowhere but `attacked` — live beside the
 * components that render them, in `components/trust/*.test.tsx`.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { decomposeColor } from "@mui/material/styles";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_FONT_SIZE_PX,
  BOARD_ROW_FONT_SIZE_PX,
  BOARD_ROW_HEIGHT_PX,
  CONDITION_GLYPHS,
  CONDITION_ROW_RULE_STYLE,
  MONO_FONT_FAMILY,
  PALETTE,
  SEVERITY_GLYPHS,
  SPACING_PX,
  TABULAR_NUMS,
  UI_FONT_FAMILY,
  conditionColor,
  darkTheme,
  lightTheme,
  useWolfTheme,
  wolfTheme,
} from "./theme.js";

const THEMES = [
  ["light", lightTheme],
  ["dark", darkTheme],
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/

/** `#cf222e` and `rgb(207, 34, 46)` are the same colour; string equality says otherwise. */
function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

describe("§ 2b the palette", () => {
  it("light matches § 2b's table exactly", () => {
    expect(PALETTE.light).toEqual({
      background: "#fbfbfc",
      paper: "#ffffff",
      textPrimary: "#12161c",
      textSecondary: "#5a6472",
      accent: "#1f6feb",
      warning: "#9a6700",
      error: "#cf222e",
      positive: "#1a7f37",
      provenanceGround: "rgba(0,0,0,0.025)",
      provenanceRule: "rgba(0,0,0,0.12)",
    });
  });

  it("dark matches § 2b's table exactly", () => {
    expect(PALETTE.dark).toEqual({
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
    });
  });

  it.each([
    ["light", lightTheme],
    ["dark", darkTheme],
  ] as const)("%s: every § 2b role reaches the MUI palette slot that renders it", (mode, theme) => {
    const c = PALETTE[mode];
    expect(theme.palette.mode).toBe(mode);
    expect(rgba(theme.palette.background.default)).toBe(rgba(c.background));
    expect(rgba(theme.palette.background.paper)).toBe(rgba(c.paper));
    expect(rgba(theme.palette.text.primary)).toBe(rgba(c.textPrimary));
    expect(rgba(theme.palette.text.secondary)).toBe(rgba(c.textSecondary));
    expect(rgba(theme.palette.primary.main)).toBe(rgba(c.accent));
    expect(rgba(theme.palette.warning.main)).toBe(rgba(c.warning));
    expect(rgba(theme.palette.error.main)).toBe(rgba(c.error));
    expect(rgba(theme.palette.success.main)).toBe(rgba(c.positive));
    expect(theme.palette.provenance).toEqual({ ground: c.provenanceGround, rule: c.provenanceRule });
  });

  // The token-level half of the criterion; Provenance.test.tsx asserts the
  // same thing against what the browser actually computes.
  it.each([
    ["light", lightTheme],
    ["dark", darkTheme],
  ] as const)("%s: the provenance ground and rule are no shade of warning, error or info", (_mode, theme) => {
    const semantic = (["warning", "error", "info"] as const).flatMap((role) => [
      theme.palette[role].main,
      theme.palette[role].light,
      theme.palette[role].dark,
      theme.palette[role].contrastText,
    ]);
    const forbidden = new Set(semantic.map(rgba));
    expect(forbidden.has(rgba(theme.palette.provenance.ground))).toBe(false);
    expect(forbidden.has(rgba(theme.palette.provenance.rule))).toBe(false);
  });

  it("`tripped` is the accent and not the error red — the rule that keeps both colours meaningful", () => {
    for (const theme of [lightTheme, darkTheme]) {
      expect(rgba(conditionColor(theme, "tripped"))).toBe(rgba(theme.palette.primary.main));
      expect(rgba(conditionColor(theme, "tripped"))).not.toBe(rgba(theme.palette.error.main));
    }
  });

  it("`holding` is neutral and low-emphasis, deliberately NOT green", () => {
    for (const theme of [lightTheme, darkTheme]) {
      expect(rgba(conditionColor(theme, "holding"))).toBe(rgba(theme.palette.text.secondary));
      expect(rgba(conditionColor(theme, "holding"))).not.toBe(rgba(theme.palette.success.main));
    }
  });

  it("`indeterminate` is warning, and therefore unmistakably distinct from `holding`", () => {
    for (const theme of [lightTheme, darkTheme]) {
      expect(rgba(conditionColor(theme, "indeterminate"))).toBe(rgba(theme.palette.warning.main));
      expect(rgba(conditionColor(theme, "indeterminate"))).not.toBe(rgba(conditionColor(theme, "holding")));
    }
  });
});

describe("§ 2b typography", () => {
  it.each(THEMES)("%s: uses the system stack and requests no web font", (_mode, theme) => {
    expect(theme.typography.fontFamily).toBe(UI_FONT_FAMILY);
    // A font request is a remote fetch, and this product argues about remote
    // fetches for a living.
    expect(theme.typography.fontFamily).not.toMatch(/url\(|@font-face|fonts\.googleapis/i);
    expect(theme.typography.fontSize).toBe(BASE_FONT_SIZE_PX);
  });

  it.each(THEMES)("%s: splits figures, ids and slugs onto the monospace stack with tabular-nums", (_mode, theme) => {
    expect(theme.typography.mono).toEqual({
      fontFamily: MONO_FONT_FAMILY,
      fontVariantNumeric: TABULAR_NUMS,
      fontSize: BOARD_ROW_FONT_SIZE_PX,
    });
    expect(MONO_FONT_FAMILY).toMatch(/ui-monospace/);
  });

  it.each(THEMES)("%s: puts tabular-nums on body, so every figure gets it", (_mode, theme) => {
    const baseline = theme.components?.MuiCssBaseline?.styleOverrides as
      | { body?: { fontVariantNumeric?: string } }
      | undefined;
    expect(baseline?.body?.fontVariantNumeric).toBe(TABULAR_NUMS);
  });

  it("gives the custom `mono` variant an element to render as", () => {
    const defaults = lightTheme.components?.MuiTypography?.defaultProps as
      | { variantMapping?: Record<string, string> }
      | undefined;
    expect(defaults?.variantMapping?.mono).toBe("span");
  });
});

describe("§ 2b density", () => {
  it.each(THEMES)("%s: makes MUI's 1 unit 6px, not 8px", (_mode, theme) => {
    expect(SPACING_PX).toBe(6);
    expect(theme.spacing(1)).toBe("6px");
    expect(theme.spacing(2)).toBe("12px");
  });

  it.each(THEMES)("%s: tightens MuiTableCell to 6px 12px", (_mode, theme) => {
    const overrides = theme.components?.MuiTableCell?.styleOverrides as { root?: { padding?: string } } | undefined;
    expect(overrides?.root?.padding).toBe("6px 12px");
  });

  it.each(THEMES)("%s: defaults MuiChip to size=small", (_mode, theme) => {
    const defaults = theme.components?.MuiChip?.defaultProps as { size?: string } | undefined;
    expect(defaults?.size).toBe("small");
  });

  it("publishes the board-row figures so W13 does not re-decide them", () => {
    expect(BOARD_ROW_FONT_SIZE_PX).toBe(13);
    expect(BOARD_ROW_HEIGHT_PX).toBe(40);
  });
});

describe("§ 2b glyphs — never colour-alone", () => {
  it("matches § 2b's glyph table", () => {
    expect(CONDITION_GLYPHS).toEqual({ holding: "●", tripped: "◉", indeterminate: "△" });
    expect(SEVERITY_GLYPHS).toEqual({ degraded: "△", attacked: "◉" });
  });

  it("gives `indeterminate` the dashed row rule that survives colour-blindness", () => {
    expect(CONDITION_ROW_RULE_STYLE).toEqual({ holding: "solid", tripped: "solid", indeterminate: "dashed" });
  });
});

describe("§ 2b principle 5 — the mode follows the OS and cannot be told otherwise", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPrefersDark(prefersDark: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("prefers-color-scheme: dark") ? prefersDark : false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
  }

  it("selects the dark theme when the OS prefers dark", () => {
    stubPrefersDark(true);
    const { result } = renderHook(() => useWolfTheme());
    expect(result.current).toBe(darkTheme);
  });

  it("selects the light theme otherwise", () => {
    stubPrefersDark(false);
    const { result } = renderHook(() => useWolfTheme());
    expect(result.current).toBe(lightTheme);
  });

  it("exposes two theme OBJECTS, not one with `mode` flipped", () => {
    expect(lightTheme).not.toBe(darkTheme);
    expect(wolfTheme("light")).toBe(lightTheme);
    expect(wolfTheme("dark")).toBe(darkTheme);
  });

  it("offers no way to override the mode", () => {
    // If a toggle is ever added, Wolf and the Orange rail it iframes can end
    // up in different modes with no way to reconcile them (§ 2b principle 5).
    const source = readFileSync(join(webRoot, "src", "theme.ts"), "utf8");
    expect(source).not.toMatch(/setMode|toggleColorMode|localStorage/);
  });
});

describe("R134 — the vendored tarball and the dependency range must always agree", () => {
  const manifest = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    comment?: string;
  };
  const spec = manifest.dependencies?.["@agentkit/chat-ui"];

  it("is installed from a local tarball under web/vendor/", () => {
    expect(spec).toMatch(/^file:\.\/vendor\/agentkit-chat-ui-.+\.tgz$/);
  });

  it("names a tarball that is actually committed there", () => {
    const relative = (spec ?? "").replace(/^file:/, "");
    expect(existsSync(resolve(webRoot, relative))).toBe(true);
  });

  it("names the SAME version the installed package reports — the bump R134 requires", () => {
    const version = /agentkit-chat-ui-(.+)\.tgz$/.exec(spec ?? "")?.[1];
    expect(version).toBeTruthy();
    // Resolved through the workspace root, which is where yarn 1 hoists it.
    const installed = join(repoRoot, "node_modules", "@agentkit", "chat-ui", "package.json");
    const installedVersion = (JSON.parse(readFileSync(installed, "utf8")) as { version: string }).version;
    expect(installedVersion).toBe(version);
  });

  it("records the version-bump rule beside the dependency", () => {
    expect(manifest.comment).toMatch(/@agentkit\/chat-ui/);
    expect(manifest.comment).toMatch(/BUMP THE VERSION ON EVERY REPUBLISH/);
    expect(manifest.comment).toMatch(/stale/i);
  });
});
