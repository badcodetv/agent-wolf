/**
 * W23 — the sandboxed report frame, and the boundary it exists to hold.
 *
 * 🔴 The first describe block is the highest-value test in the feature. The
 * two remaining ones are the other half of the same rule: the composed report
 * document must arrive as a URL the browser loads into a sandbox, never as
 * bytes this application holds.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ThemeProvider } from "@mui/material/styles";
import { collectSourceFiles } from "@wolf/import-boundary";
import ReportPanel, {
  NO_REPORT_TEMPLATE,
  NO_REPORT_YET,
  REPORT_WITHHELD,
  reportFrameSrc,
} from "./ReportPanel.js";
import { lightTheme } from "../theme.js";
import type { ReportBlock } from "../api/types.js";

const ID = "1a2b3c4d";

function block(over: Partial<ReportBlock> = {}): ReportBlock {
  return {
    has_template: true,
    structure_hash: "9f2c",
    stripped_count: 0,
    updated_at_ms: 1_789_000_000_123,
    drift: { orphan_slots: [], unfilled_slots: [] },
    unreadable: false,
    tamper: null,
    ...over,
  };
}

function renderPanel(report: ReportBlock | null | undefined) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <ReportPanel hypothesisId={ID} report={report} />
    </ThemeProvider>,
  );
}

// ── The sandbox ─────────────────────────────────────────────────────────

describe("🔴 the frame's sandbox", () => {
  it('renders sandbox="allow-scripts" and NOTHING else', () => {
    renderPanel(block());
    const frame = screen.getByTestId("report-frame");

    // The literal, on the DOM attribute string. `allow-scripts` alone leaves
    // the document in an OPAQUE origin: it can run script, and that script
    // can reach neither Wolf's cookies, nor Wolf's DOM, nor any same-origin
    // API on this host.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("🔴 never carries allow-same-origin, because the two together cancel the sandbox", () => {
    renderPanel(block());
    const sandbox = screen.getByTestId("report-frame").getAttribute("sandbox");

    // `allow-scripts` + `allow-same-origin` is not "two permissions": it is
    // NO sandbox. The framed document regains this origin, so model-authored
    // script inside it can read Wolf's session cookie, call every signed-in
    // API route as the human, and reach into the parent document — a bounded
    // risk becomes a session compromise. This is Orange's hazard H3.
    expect(sandbox).not.toBeNull();
    expect(sandbox ?? "").not.toContain("allow-same-origin");

    // Asserted on the string the DOM actually holds, not on a prop: an
    // `allow-same-origin` arriving through any route — a second attribute, a
    // spread, a token appended later — lands in this same string.
    expect((sandbox ?? "").split(/\s+/).filter(Boolean)).toEqual(["allow-scripts"]);
  });
});

// ── The document is a URL, never data ───────────────────────────────────

describe("🔴 the composed document never reaches this application as data", () => {
  it("points the frame at the frame route and carries no inline document", () => {
    renderPanel(block());
    const frame = screen.getByTestId("report-frame");

    // The bytes are safe only inside the frame the CSP header applies to.
    // `srcdoc` would inherit THIS page's CSP and none of the route's.
    expect(frame.getAttribute("src")).toBe(`/api/hypotheses/${ID}/report/frame`);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
  });

  it("escapes the id into the path, so an id can never open a second route", () => {
    expect(reportFrameSrc("a/b")).toBe("/api/hypotheses/a%2Fb/report/frame");
    expect(reportFrameSrc("../../admin")).toBe("/api/hypotheses/..%2F..%2Fadmin/report/frame");
  });

  it("makes no network request of its own — the browser loads the frame, this component does not", () => {
    // The document must not pass through this application, so this component
    // must not ask for it. A `fetch` here would mean the HTML had become a
    // string something in the SPA holds, with no CSP and no sandbox.
    const fetchSpy = vi.fn(async () => {
      throw new Error("ReportPanel must not fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      renderPanel(block());
      expect(screen.getByTestId("report-frame")).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("🔴 dangerouslySetInnerHTML appears nowhere under web/src", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(here, "..");
  const selfPath = resolve(here, "ReportPanel.test.tsx");
  // Assembled at runtime so THIS constant is not itself a literal occurrence
  // in any other reader's grep, and so the check below cannot match its own
  // definition line.
  const NEEDLE = ["dangerously", "Set", "Inner", "HTML"].join("");

  function offenders(): string[] {
    return collectSourceFiles(srcDir)
      .filter((file: string) => resolve(file) !== selfPath)
      .filter((file: string) => readFileSync(file, "utf8").includes(NEEDLE));
  }

  it("finds none", () => {
    // React's one escape hatch from escaping. Wolf renders model-authored
    // HTML in exactly one place — a sandboxed iframe pointed at a route that
    // sets a CSP — and any other path to the DOM bypasses both.
    expect(offenders()).toEqual([]);
  });

  it("would have found one — the scan really reads these files", () => {
    // Without this, `offenders()` returning `[]` proves nothing: an empty
    // file list, a wrong root or a typo'd needle all pass the test above.
    const files = collectSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(30);
    expect(files.map((f: string) => resolve(f))).toContain(selfPath);
    // The needle is found in the one file that contains it — this one.
    expect(readFileSync(selfPath, "utf8").includes(NEEDLE)).toBe(true);
    // …and the exclusion is what keeps that from failing the test above.
    expect(resolve(join(here, "ReportPanel.test.tsx"))).toBe(selfPath);
  });
});

// ── The empty states ────────────────────────────────────────────────────

describe("the empty states name why, and never show a blank frame", () => {
  it("says the first tick has not run when there is a template and no report", () => {
    renderPanel(block({ drift: null }));
    expect(screen.queryByTestId("report-frame")).toBeNull();
    expect(screen.getByTestId("report-empty")).toHaveTextContent(
      "no report yet — the first tick has not run",
    );
    expect(NO_REPORT_YET).toBe("no report yet — the first tick has not run");
  });

  it("says no template has been locked when there is none", () => {
    renderPanel(block({ has_template: false, structure_hash: null, drift: null }));
    expect(screen.queryByTestId("report-frame")).toBeNull();
    // A DIFFERENT sentence from the one above: "nobody authored a template"
    // and "a template exists and no tick has filled it" are different states
    // of the product, and a reader who cannot tell them apart does not know
    // whether to run the interview or wait for tomorrow.
    expect(screen.getByTestId("report-empty")).toHaveTextContent(NO_REPORT_TEMPLATE);
    expect(NO_REPORT_TEMPLATE).not.toBe(NO_REPORT_YET);

    // Criterion 3's "never a blank frame", asserted on the RENDERED text and
    // placed FIRST so it is the assertion that dies on an emptied constant —
    // an assertion that never gets to run is not the one doing the work.
    expect((screen.getByTestId("report-empty").textContent ?? "").trim().length).toBeGreaterThan(20);

    // 🔴 Pinned as LITERALS, not through the imported constant: an assertion
    // made through the thing it checks still holds when that thing is emptied
    // or replaced with gibberish. A distinctive phrase rather than the whole
    // sentence, so a copy edit to the tail does not fail the test for nothing.
    expect(NO_REPORT_TEMPLATE).toMatch(/^no report template yet\b/);
    // …and it names WHY, which is the half of criterion 3 the identity
    // phrase alone does not carry: the reader has to learn where a template
    // comes from, not merely that there isn't one.
    expect(NO_REPORT_TEMPLATE).toMatch(/interview/);
  });

  it("🔴 mounts no frame when a report exists but its template does not", () => {
    // Reachable, and not obviously so: the template row is gone or was never
    // locked while a `kind=report` memory still carries slots, so the server
    // computes drift against NO declared slots and every filled slot is an
    // orphan. `GET …/report/frame` answers 404 for that state — there is
    // nothing to compose the slots into — so a frame here would put the
    // API's not-found body inside the report panel.
    renderPanel(
      block({
        has_template: false,
        structure_hash: null,
        drift: { orphan_slots: ["intro"], unfilled_slots: [] },
      }),
    );
    expect(screen.queryByTestId("report-frame")).toBeNull();
    expect(screen.getByTestId("report-empty")).toHaveTextContent(NO_REPORT_TEMPLATE);
  });

  it("degrades to the same explicit state when the payload carries no report block at all", () => {
    // R140: a missing block costs the panel, never the page.
    renderPanel(undefined);
    expect(screen.getByTestId("report-empty")).toBeInTheDocument();
    renderPanel(null);
    expect(screen.getAllByTestId("report-empty").length).toBe(2);
  });
});

// ── unreadable ──────────────────────────────────────────────────────────

describe("🔴 unreadable withholds the frame — it is not an empty state", () => {
  it("mounts no frame and says the report could not be read", () => {
    renderPanel(block({ drift: null, unreadable: true }));
    // `GET …/report/frame` fails for this same state, so a frame here would
    // display the API's error body inside the report panel.
    expect(screen.queryByTestId("report-frame")).toBeNull();
    expect(screen.getByTestId("report-withheld")).toHaveTextContent(REPORT_WITHHELD);
    expect(screen.queryByTestId("report-empty")).toBeNull();

    // Never blank here either — this panel is the one a model can cause at
    // will, so a wordless box is the worst possible outcome. Asserted first,
    // for the reason given on the sibling state above.
    expect((screen.getByTestId("report-withheld").textContent ?? "").trim().length).toBeGreaterThan(20);

    // Literals again, for the reason above. The first phrase is the panel's
    // identity — the frame is being withheld — and the second is the reason,
    // which is what stops this reading as "there is nothing here yet".
    expect(REPORT_WITHHELD).toMatch(/^this report is not being shown\b/);
    expect(REPORT_WITHHELD).toMatch(/could not read/);
  });

  it("🔴 tells {drift: null, unreadable: true} apart from {drift: null, unreadable: false}", () => {
    // The two payloads differ in ONE boolean. Rendering the second as the
    // first is what W22's verifier proved can hide a cross-hypothesis attack.
    const { unmount } = renderPanel(block({ drift: null, unreadable: false }));
    expect(screen.getByTestId("report-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("report-withheld")).toBeNull();
    unmount();

    renderPanel(block({ drift: null, unreadable: true }));
    expect(screen.getByTestId("report-withheld")).toBeInTheDocument();
    expect(screen.queryByTestId("report-empty")).toBeNull();
  });

  it("withholds the frame even when drift is populated — a stale template is unreadable too", () => {
    // The OTHER `unreadable` cause: the report body parsed, but the stored
    // template no longer validates, so every filled slot is an orphan.
    renderPanel(
      block({ drift: { orphan_slots: ["intro", "chart"], unfilled_slots: [] }, unreadable: true }),
    );
    expect(screen.queryByTestId("report-frame")).toBeNull();
    expect(screen.getByTestId("report-withheld")).toBeInTheDocument();
  });
});

// ── The frame is mounted when, and only when, there is a report ─────────

describe("the frame is mounted when there is a readable report", () => {
  it("mounts it for a tick that matched the template exactly", () => {
    renderPanel(block({ drift: { orphan_slots: [], unfilled_slots: [] } }));
    expect(screen.getByTestId("report-frame")).toBeInTheDocument();
    expect(screen.queryByTestId("report-empty")).toBeNull();
    expect(screen.queryByTestId("report-withheld")).toBeNull();
  });

  it("mounts it for a drifted tick — drift degrades the report, it does not withhold it", () => {
    renderPanel(block({ drift: { orphan_slots: ["gone"], unfilled_slots: ["missing"] } }));
    expect(screen.getByTestId("report-frame")).toBeInTheDocument();
  });

  it("fills the height its host gave it and negotiates nothing", () => {
    const { container } = renderPanel(block());
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    // The host owns `clamp(480px, 70vh, 900px)`; the frame takes 100% of it.
    // No pixel height, and nothing that could be recomputed from content.
    expect(getComputedStyle(frame as Element).height).toBe("100%");
    expect(frame?.getAttribute("height")).toBeNull();
  });

  it("gives the frame an accessible name", () => {
    renderPanel(block());
    expect(screen.getByTitle(/report/i)).toBe(screen.getByTestId("report-frame"));
  });

  it("mounts exactly one frame", () => {
    const { container } = renderPanel(block());
    expect(within(container).getAllByTestId("report-frame").length).toBe(1);
    expect(container.querySelectorAll("iframe").length).toBe(1);
  });
});
