/**
 * W29 — the artifact surface, and the theming assertion that is the whole
 * argument for revision 5's tiered reuse.
 *
 * 🔴 **The theming case is written to be able to fail.** Asserting the dot
 * against `theme.palette.success.main` alone would pass for the wrong reason
 * the day Wolf's green happened to equal MUI's default — the very state a
 * component "carrying Orange's palette with it" would produce. So each case
 * pins WOLF's colour as a **literal** and, beside it, asserts the rendered
 * colour is **not** MUI's stock `success.main`. Only a component taking its
 * colours from the host's `ThemeProvider` satisfies both.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, type RenderResult } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { createTheme, decomposeColor, type Theme } from "@mui/material/styles";
import ArtifactsPanel, { fileNameFor, toArtifactInfo } from "./ArtifactsPanel.js";
import { darkTheme, lightTheme } from "../theme.js";
import { stubFetchRoutes, type FetchRoutes } from "../testUtils.js";
import type { ArtifactRow } from "../api/types.js";

const ID = "1a2b3c4d";
const ARTIFACTS = `GET /api/hypotheses/${ID}/artifacts`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "art-1",
    file_path: "/workspace/report.md",
    artifact_type: "file",
    status: "extracted",
    label: "Report",
    description: "the daily report",
    mime_type: "text/markdown",
    file_size_bytes: 4096,
    source: "tool",
    is_dir: false,
    ...over,
  };
}

/** Renders under an EXPLICIT theme — the theming cases need both modes, and `renderWithProviders` pins the light one. */
function renderPanel(theme: Theme, routes: FetchRoutes): { stub: ReturnType<typeof stubFetchRoutes>; view: RenderResult } {
  const stub = stubFetchRoutes(routes);
  const view = render(
    <ThemeProvider theme={theme}>
      <ArtifactsPanel hypothesisId={ID} />
    </ThemeProvider>,
  );
  return { stub, view };
}

/** `rgb(…)`/`#hex` → a comparable `r,g,b,a`, so a hex token and a computed style can be compared. */
function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

describe("ArtifactsPanel", () => {
  it("artifacts_panel: renders Orange's panel from the proxied list, by file name", async () => {
    const { stub } = renderPanel(lightTheme, {
      [ARTIFACTS]: {
        json: { artifacts: [row(), row({ id: "art-2", file_path: "/workspace/chart.json" })] },
      },
    });
    expect(await screen.findByText("report.md")).toBeInTheDocument();
    expect(screen.getByText("chart.json")).toBeInTheDocument();
    // ONE request, to Wolf's own relative path. Never Orange's origin.
    expect(stub.calls).toEqual([ARTIFACTS]);
  });

  // ── The theming assertion, in both modes ──────────────────────────────
  //
  // Both cases assert the SAME three things (R182: the second half of a pair
  // is where the trimmed assertion hides) — the literal Wolf colour, the
  // not-MUI-default discriminator, and that the value is a real colour rather
  // than an empty computed style.

  it("artifacts_panel: LIGHT — a `live` artifact's dot computes to WOLF's success.main, not MUI's default", async () => {
    renderPanel(lightTheme, { [ARTIFACTS]: { json: { artifacts: [row({ status: "live" })] } } });
    const entry = await screen.findByTestId("artifact-entry");
    const dot = entry.firstElementChild as HTMLElement;
    const painted = getComputedStyle(dot).backgroundColor;

    // § 2b's `positive`, light: #1a7f37. Pinned as a LITERAL, not read back
    // through `lightTheme.palette.success.main` — a test that computes its own
    // expectation from the same object the component read cannot fail.
    expect(painted).toBe("rgb(26, 127, 55)");
    // 🔴 The discriminator. If `ArtifactPanel` carried Orange's own palette
    // rather than taking Wolf's, this is what it would paint.
    expect(rgba(painted)).not.toBe(rgba(createTheme().palette.success.main));
    expect(painted).not.toBe("");
  });

  it("artifacts_panel: DARK — a `live` artifact's dot computes to WOLF's success.main, not MUI's default", async () => {
    renderPanel(darkTheme, { [ARTIFACTS]: { json: { artifacts: [row({ status: "live" })] } } });
    const entry = await screen.findByTestId("artifact-entry");
    const dot = entry.firstElementChild as HTMLElement;
    const painted = getComputedStyle(dot).backgroundColor;

    // § 2b's `positive`, dark: #3fb950.
    expect(painted).toBe("rgb(63, 185, 80)");
    expect(rgba(painted)).not.toBe(rgba(createTheme().palette.success.main));
    expect(painted).not.toBe("");
  });

  it("artifacts_panel: the two modes paint DIFFERENT greens — the panel follows the theme it is given", async () => {
    // The pair above could both be satisfied by a component that ignored the
    // theme and hard-coded one of the two. This is the case that cannot.
    renderPanel(lightTheme, { [ARTIFACTS]: { json: { artifacts: [row({ status: "live" })] } } });
    const light = getComputedStyle(
      (await screen.findByTestId("artifact-entry")).firstElementChild as HTMLElement,
    ).backgroundColor;
    cleanup();
    vi.unstubAllGlobals();

    renderPanel(darkTheme, { [ARTIFACTS]: { json: { artifacts: [row({ status: "live" })] } } });
    const dark = getComputedStyle(
      (await screen.findByTestId("artifact-entry")).firstElementChild as HTMLElement,
    ).backgroundColor;

    expect(light).not.toBe(dark);
  });

  // ── Channel P ─────────────────────────────────────────────────────────

  it("artifacts_panel: renders inside Provenance kind=\"machine\" — no tint, no rule, no stamp", async () => {
    // § 2: artifact METADATA is Orange's record of what a container wrote, not
    // model prose. `machine` renders no wrapper at all, which is exactly what
    // "no treatment" has to mean if the `model` ground is to keep its force.
    const { view } = renderPanel(lightTheme, {
      [ARTIFACTS]: { json: { artifacts: [row()] } },
    });
    await screen.findByText("report.md");
    expect(view.container.querySelector('[data-provenance="model"]')).toBeNull();
    expect(screen.queryByTestId("provenance")).toBeNull();
    expect(screen.queryByTestId("provenance-stamp")).toBeNull();
  });

  // ── The two states that are not a list ────────────────────────────────

  it("artifacts_panel: a session with NO artifacts renders an explicit empty state", async () => {
    renderPanel(lightTheme, { [ARTIFACTS]: { json: { artifacts: [] } } });
    const empty = await screen.findByTestId("artifacts-empty");
    // The literal, not the exported constant: an assertion that reads the
    // constant the component renders holds however the constant changes.
    expect(empty).toHaveTextContent(
      "No artifacts yet — nothing has been written to this session's workspace.",
    );
    // And the panel itself is NOT rendered — Orange's component returns null
    // for an empty list, so a missing empty state would be a silent blank.
    expect(screen.queryByTestId("artifacts-panel")).toBeNull();
    // 🔴 Mirrors its sibling below. An empty session is NOT a problem, so no
    // severity marker may appear: § 2 is emphatic that if the everyday state
    // is styled as a warning, a real alert loses all its force.
    expect(screen.queryByTestId("severity")).toBeNull();
  });

  it("artifacts_panel: a failed read costs the BLOCK, not the page — a degraded severity naming the cause", async () => {
    renderPanel(lightTheme, {
      [ARTIFACTS]: { status: 404, json: { kind: "not_found", message: "no session hyp-1a2b3c4d" } },
    });
    const severity = await screen.findByTestId("severity");
    expect(severity).toHaveAttribute("data-severity", "degraded");
    // The server's own sentence, verbatim — "no session hyp-1a2b3c4d" is the
    // actionable half and flattening it would throw it away.
    expect(severity).toHaveTextContent("no session hyp-1a2b3c4d");
    expect(screen.queryByTestId("artifacts-panel")).toBeNull();
    // 🔴 Mirrors its sibling above: a failed read is NOT an empty session, and
    // rendering "nothing has been written yet" over an unreadable list is the
    // one confusion this pair exists to keep apart.
    expect(screen.queryByTestId("artifacts-empty")).toBeNull();
  });

  it("artifacts_panel: a NON-HTTP failure renders the component's OWN sentence, not a blank marker", async () => {
    // The sibling above covers the `ApiError` half, where the SERVER's
    // sentence is surfaced verbatim. This is the other half: a 200 whose body
    // is not JSON throws a `SyntaxError` out of `response.json()`, below
    // `ApiError`, and the component has to say something itself.
    //
    // It went unasserted, and changing the fallback left all 478 web tests
    // green — this is the sentence a user actually reads when the read fails
    // for a reason the taxonomy never saw.
    renderPanel(lightTheme, { [ARTIFACTS]: { status: 200, text: "<html>not json at all</html>" } });
    const severity = await screen.findByTestId("severity");
    // Same four assertions as its sibling (R222/R226), with the literal
    // sentence rather than the exported constant.
    expect(severity).toHaveAttribute("data-severity", "degraded");
    expect(severity).toHaveTextContent("could not read this session's artifacts");
    expect(screen.queryByTestId("artifacts-panel")).toBeNull();
    expect(screen.queryByTestId("artifacts-empty")).toBeNull();
  });

  // ── The mapping ───────────────────────────────────────────────────────

  it("artifacts_map: toArtifactInfo carries NO downloadUrl, and derives fileName from the path", () => {
    const info = toArtifactInfo(row({ file_path: "/workspace/nested/dgs10.csv", status: "live" }));
    expect(info.fileName).toBe("dgs10.csv");
    expect(info.filePath).toBe("/workspace/nested/dgs10.csv");
    expect(info.fileSize).toBe(4096);
    expect(info.status).toBe("live");
    // 🔴 The field that would put an Orange URL — and the project API key that
    // opens it — into the page. Absent, and asserted as absent by KEY, because
    // `undefined` and "not there" must both hold.
    expect(info.downloadUrl).toBeUndefined();
    expect(Object.keys(info)).not.toContain("downloadUrl");
  });

  it("artifacts_map: fileNameFor handles both slash spellings, and falls back rather than going blank", () => {
    expect(fileNameFor("/workspace/report.md")).toBe("report.md");
    expect(fileNameFor("workspace/report.md")).toBe("report.md");
    expect(fileNameFor("report.md")).toBe("report.md");
    expect(fileNameFor("/")).toBe("/");
  });

  it("artifacts_map: an UNKNOWN status is passed through, not rewritten into a known one", () => {
    // Orange's status set is closed at four values today and its type is a Go
    // string; a fifth must cost one dot's colour, never a fabricated status.
    expect(toArtifactInfo(row({ status: "quarantined" })).status).toBe("quarantined");
  });
});
