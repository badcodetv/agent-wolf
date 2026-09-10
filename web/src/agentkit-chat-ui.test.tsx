/**
 * W28 — proof that the vendored `@agentkit/chat-ui` tarball is really usable
 * from Wolf, and that Wolf's theme is what colours it.
 *
 * 🔴 This file is the reason `web/vite.config.ts` sets
 * `test.server.deps.inline: [/@mui/, /@agentkit/]`. Without that line this
 * suite dies with
 *
 *   Directory import '.../@mui/material/utils' is not supported resolving ES
 *   modules imported from .../@mui/icons-material/esm/utils/createSvgIcon.js
 *
 * — an error naming MUI's own ESM build rather than anything of ours, which is
 * exactly why an executor would reasonably conclude the package is broken
 * (agent-bob R125). Delete the `inline` entry and this file fails outright.
 *
 * The theming assertion is the argument for revision 5's tiered reuse and the
 * one thing an iframe can never do: a component built in the OTHER repository,
 * rendered under Wolf's `ThemeProvider`, takes WOLF's palette. W29 makes the
 * same assertion again at the point of use.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { decomposeColor } from "@mui/material/styles";
// R136: the DEEP subpath, not the `./components` barrel. The barrel is 46
// re-exports and importing any one of them pulled all of them — ~36s of
// module resolution per suite, which a consumer could not opt out of until
// agent-bob 0.1.1 added a `./components/*` wildcard export. The deep path
// pulls ONE module. Prefer it in every Wolf ticket.
// NOTE the DEFAULT import: a deep subpath gives you the module's own export
// shape, and each component module default-exports itself — the `./components`
// barrel is what renames them into named exports. Getting this wrong is a
// typecheck error, not a runtime surprise.
import ArtifactPanel from "@agentkit/chat-ui/components/ArtifactPanel";
import type { ArtifactInfo } from "@agentkit/chat-ui/pure";
import { darkTheme, lightTheme } from "./theme.js";
import Provenance from "./components/trust/Provenance.js";

afterEach(cleanup);

function rgba(color: string): string {
  const { values } = decomposeColor(color);
  const [r, g, b, a] = values;
  return `${r},${g},${b},${a ?? 1}`;
}

// Typed against the package's OWN tier-1 export (`@agentkit/chat-ui/pure`),
// which is the other half of what revision 5 buys: Wolf shares Orange's types
// rather than restating them.
const artifacts: ArtifactInfo[] = [
  {
    fileName: "dgs10.csv",
    filePath: "/workspace/dgs10.csv",
    label: "DGS10",
    artifactType: "csv",
    source: "auto",
    status: "live",
  },
];

describe("the vendored @agentkit/chat-ui tarball", () => {
  it("resolves and renders a tier-2 component (this is the test the vite `inline` config exists for)", () => {
    render(
      <ThemeProvider theme={lightTheme}>
        <ArtifactPanel artifacts={artifacts} sessionId="sess-1" />
      </ThemeProvider>,
    );
    expect(screen.getByText("dgs10.csv")).toBeInTheDocument();
  });

  it.each([
    ["light", lightTheme],
    ["dark", darkTheme],
  ] as const)("%s: is coloured by WOLF's theme, not by Orange's", (_mode, theme) => {
    render(
      <ThemeProvider theme={theme}>
        <ArtifactPanel artifacts={artifacts} sessionId="sess-1" />
      </ThemeProvider>,
    );
    const entry = screen.getByTestId("artifact-entry");
    const dot = entry.firstElementChild as HTMLElement;
    // ArtifactPanel paints a `live` artifact's status dot `success.main`. Wolf's
    // success.main is § 2b's `positive` — used for a `confirmed` verdict only.
    expect(rgba(getComputedStyle(dot).backgroundColor)).toBe(rgba(theme.palette.success.main));
  });

  it("composes with Wolf's own trust components", () => {
    // § 2 maps artifact METADATA to `machine`: it is Orange's record of what a
    // container wrote, not model prose. W29 renders it exactly this way.
    const { container } = render(
      <ThemeProvider theme={lightTheme}>
        <Provenance kind="machine">
          <ArtifactPanel artifacts={artifacts} sessionId="sess-1" />
        </Provenance>
      </ThemeProvider>,
    );
    expect(container.querySelector('[data-testid="provenance"]')).toBeNull();
    expect(screen.getByText("dgs10.csv")).toBeInTheDocument();
  });
});
