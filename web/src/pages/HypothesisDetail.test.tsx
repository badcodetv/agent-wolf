import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import HypothesisDetail from "./HypothesisDetail.js";
import { renderWithProviders, stubFetchRoutes, type FetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const DETAIL = `GET /api/hypotheses/${ID}`;
const TOKEN = `GET /api/hypotheses/${ID}/embed-token`;
const ARTIFACTS = `GET /api/hypotheses/${ID}/artifacts`;

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
    ...over,
  };
}

/**
 * The same payload past `draft`.
 *
 * The detail page collapses its empty analysis sections and its empty report
 * FRAME on a draft only (2026-09-07): a draft has no locked spec, so those
 * blocks are empty by definition and eight headings saying so buried the two
 * things that mattered. Every resilience assertion about "a missing block
 * costs a region, never the page" therefore renders a LIVE hypothesis, where
 * an empty region is a real finding and is still shown.
 */
function livePayload(over: Record<string, unknown> = {}) {
  const base = detailBody(over);
  return { ...base, hypothesis: { ...base.hypothesis, status: "live" } };
}

/** W22's report block, with only the field under test varying. */
function reportBlock(over: Record<string, unknown> = {}) {
  return {
    has_template: true,
    structure_hash: "sha256:abc",
    stripped_count: 0,
    updated_at_ms: 1_780_000_000_000,
    drift: null,
    unreadable: false,
    tamper: null,
    ...over,
  };
}

async function renderDetail(routes: FetchRoutes) {
  // W29's panel fetches its own list, so every render of this page makes the
  // request. Defaulted here rather than in each case — `stubFetchRoutes`
  // THROWS on an unrouted path, which is what keeps the no-live-network pin
  // honest — and overridable by any case that cares what comes back.
  const stub = stubFetchRoutes({ [ARTIFACTS]: { json: { artifacts: [] } }, ...routes });
  renderWithProviders(
    <Routes>
      <Route path="/hypotheses/:id" element={<HypothesisDetail />} />
    </Routes>,
    { route: `/hypotheses/${ID}` },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return stub;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tokenRoute = {
  json: { token: "tok", expires_at_sec: Math.floor(Date.parse("2026-08-24T12:00:00Z") / 1000) + 900, embed_url: "" },
};

describe("HypothesisDetail (W13's frame; W14 fills the left column)", () => {
  it("renders the two columns: a left column and the sticky rail", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.getByText("Petrodollar / drone parts")).toBeInTheDocument();
    expect(screen.getByTestId("chat-rail")).toHaveAttribute("data-rail-mode", "rail");
    expect(screen.getByTestId("bob-chat-frame")).toBeInTheDocument();
  });

  it("takes the Go Live gate from spec_validation and report.has_template, and nothing else", async () => {
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          spec_validation: { valid: false, errors: [{ path: "horizon_days", message: "required" }] },
          report: reportBlock({ has_template: true }),
        }),
      },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("go-live-button")).toBeDisabled();
    expect(screen.getByText("horizon_days: required")).toBeInTheDocument();
  });

  it("renders a tampered hypothesis's alert on the detail page too", async () => {
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          hypothesis: {
            ...detailBody().hypothesis,
            tamper: [
              {
                reason: "cross_hypothesis_write",
                written_by_worker: "",
                written_by_session: "sess_18ab",
                memory_id: "mem_99",
              },
            ],
          },
        }),
      },
      [TOKEN]: tokenRoute,
    });
    const alert = screen.getByTestId("severity");
    expect(alert).toHaveAttribute("data-severity", "attacked");
    expect(alert).toHaveTextContent(/cross-hypothesis write/i);
  });
});

/**
 * 🔴 R219 — the Go Live gate's TEMPLATE half, wired on the DETAIL page.
 *
 * W24 built `GoLiveButton`'s second prop and proved all four combinations at
 * COMPONENT level, then wired it on the go-live review screen only:
 * `HypothesisDetail.tsx` went on rendering the button with `specValidation`
 * alone, so the detail page's Go Live button was enabled with no template
 * accepted — while the comment on that very line claimed W24 had added the
 * other half. W24 was right not to reach into this file; the gap was assigned
 * here, to the ticket that owns it.
 *
 * These are therefore PAGE-LEVEL wiring cases, not a second copy of
 * `GoLiveButton.test.tsx`: each one dies when the page stops passing
 * `templateAccepted={detail.report?.has_template}`, and nothing in the
 * component suite can.
 *
 * All four assert the SAME three things — the button's disabled state, whether
 * the template sentence is on screen, and whether the spec errors are — so the
 * pair written second cannot quietly carry a thinner list than the first
 * (R182).
 */
describe("🔴 R219 — the detail page passes BOTH halves of the Go Live gate", () => {
  it("spec valid + template accepted → ENABLED, no blocking sentence of either kind", async () => {
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          spec_validation: { valid: true, errors: [] },
          report: reportBlock({ has_template: true }),
        }),
      },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("go-live-button")).toBeEnabled();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("🔴 spec valid + NO template accepted → DISABLED, and the template sentence is on screen", async () => {
    // THE case. Before R219 was closed this button was enabled and the server
    // answered the click with W22's 422 — an action offered and then refused.
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          spec_validation: { valid: true, errors: [] },
          report: reportBlock({ has_template: false }),
        }),
      },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("go-live-button")).toBeDisabled();
    // The literal sentence, not the exported constant: an assertion that reads
    // the constant the component renders holds however the constant changes.
    expect(screen.getByTestId("template-blocked")).toHaveTextContent(
      "No report template has been accepted yet, so this hypothesis cannot go live: " +
        "review the candidate and accept it first.",
    );
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("spec INVALID + template accepted → DISABLED, spec errors only — the two halves are read independently", async () => {
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          spec_validation: { valid: false, errors: [{ path: "horizon_days", message: "required" }] },
          report: reportBlock({ has_template: true }),
        }),
      },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("go-live-button")).toBeDisabled();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
    expect(screen.getByTestId("spec-errors")).toHaveTextContent("horizon_days: required");
  });

  it("NO report block at all → ENABLED: silence from the server is not a refusal", async () => {
    // `report` is optional on the wire (an older server, a fixture, a router
    // built without the report pair), so `templateAccepted` is `undefined` —
    // which blocks nothing, exactly as an absent `spec_validation` does. W22's
    // server-side 422 is the backstop, not a second gate decided here.
    await renderDetail({
      [DETAIL]: { json: detailBody({ spec_validation: { valid: true, errors: [] } }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("go-live-button")).toBeEnabled();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });
});

// ── W29: the artifact surface ───────────────────────────────────────────

describe("W29 — the artifacts section", () => {
  it("renders Orange's ArtifactPanel from `…/artifacts`, once, inside its own section", async () => {
    const stub = await renderDetail({
      [DETAIL]: { json: detailBody() },
      [TOKEN]: tokenRoute,
      [ARTIFACTS]: {
        json: {
          artifacts: [
            {
              id: "art-1",
              file_path: "/workspace/report.md",
              artifact_type: "file",
              status: "extracted",
              label: "Report",
              description: "",
              mime_type: "text/markdown",
              file_size_bytes: 4096,
              source: "tool",
              is_dir: false,
            },
          ],
        },
      },
    });
    const section = screen.getByTestId("section-artifacts");
    expect(within(section).getByTestId("artifacts-panel")).toBeInTheDocument();
    expect(within(section).getByText("report.md")).toBeInTheDocument();
    expect(stub.countFor(ARTIFACTS)).toBe(1);
    // § 2: artifact METADATA is `machine`, so there is no tint and no stamp.
    expect(within(section).queryByTestId("provenance-stamp")).toBeNull();
  });

  it("renders the explicit empty state for a session that has written nothing", async () => {
    // R198: the same assertion list as its sibling above — the section, what
    // is in it, the request count and the absence of a provenance stamp.
    // Trimming the second half of a pair to "what looks relevant" is how a
    // case ends up passing for a reason it does not state.
    const stub = await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    const section = screen.getByTestId("section-artifacts");
    expect(within(section).getByTestId("artifacts-empty")).toBeInTheDocument();
    expect(within(section).queryByTestId("artifacts-panel")).toBeNull();
    expect(stub.countFor(ARTIFACTS)).toBe(1);
    expect(within(section).queryByTestId("provenance-stamp")).toBeNull();
  });
});

// ── W14: the left column ────────────────────────────────────────────────

const ID_SERIES = (slug: string): string => `GET /api/hypotheses/${ID}/series/${slug}`;

const SPEC = {
  thesis: "the petrodollar unwinds",
  horizon_days: 180,
  flat_band_pct: 2,
  staleness_days: 5,
  metrics: [{ slug: "brent_crude", source: "stooq", direction: "down", weight: 1, unit: "USD" }],
  // 🔴 DELIBERATELY in the opposite order to `EVALUATION.conditions` below,
  // with two different statistics. The page joins the spec's `stat` to the
  // evaluation's rows BY CONDITION ID; a join by index would swap these two
  // and print `drawdown_pct` against the wrong condition. One condition, or
  // two in matching order, proves nothing about which join was written.
  invalidation: [
    {
      id: "c2",
      metric: "brent_crude",
      stat: "change_pct",
      op: "lt",
      threshold: -10,
      sustained_days: 3,
      meaning: "brent breaks the floor",
    },
    {
      id: "c1",
      metric: "dxy",
      stat: "drawdown_pct",
      op: "gt",
      threshold: 5,
      sustained_days: 3,
      meaning: "the dollar rolls over",
    },
  ],
};

const EVALUATION = {
  evaluated_at_ms: Date.UTC(2026, 7, 21),
  support_score: -0.4,
  // `c1` first, `c2` second — the reverse of the spec's order above.
  conditions: [
    {
      id: "c1",
      metric: "dxy",
      state: "holding",
      reason: null,
      value: 1.2,
      threshold: 5,
      op: "gt",
      window_start_ms: Date.UTC(2026, 5, 1),
      window_end_ms: Date.UTC(2026, 7, 21),
      observations_in_window: 58,
    },
    {
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
    },
  ],
  metrics: [
    {
      slug: "brent_crude",
      direction: "down",
      realised_change_pct: -12.4,
      last_observation_ms: Date.UTC(2026, 7, 20),
      stale: false,
      stale_reason: null,
    },
  ],
};

function fullBody(over: Record<string, unknown> = {}) {
  return detailBody({
    hypothesis: { ...detailBody().hypothesis, status: "challenged" },
    spec: SPEC,
    spec_source: "hypothesis-spec",
    evaluation: EVALUATION,
    notes: [
      {
        id: "mem_n1",
        snippet: "brent slid again",
        status: null,
        created_at_ms: Date.UTC(2026, 7, 20),
        created_by_worker: "researcher-1a2b3c4d",
        created_by_session: "",
      },
    ],
    amendments: [
      {
        id: "mem_a1",
        snippet: "raise staleness_days to 7",
        status: "proposed",
        created_at_ms: Date.UTC(2026, 7, 19),
        created_by_worker: "researcher-1a2b3c4d",
        created_by_session: "",
      },
    ],
    verdict: null,
    attention_requests: [],
    atoms: { session_id: "sess", worker: "researcher-1a2b3c4d", schedule_id: "sch", datasets: [] },
    ...over,
  });
}

const seriesBody = {
  json: {
    points: [
      { tMs: Date.UTC(2026, 7, 19), v: 78 },
      { tMs: Date.UTC(2026, 7, 20), v: 71 },
    ],
    unit: "USD",
    version: 4,
    fetched_at_ms: Date.UTC(2026, 7, 24),
    state: "ok",
  },
};

describe("🔴 the rail is a SIBLING of the scrolling column", () => {
  it("does not nest the rail inside the left column", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    const column = screen.getByTestId("detail-column");
    const rail = screen.getByTestId("chat-rail");
    // The whole of D4's sizing argument: a sticky column's height is the
    // viewport's. A rail inside the scrolling column would be a fixed-height
    // box in the middle of a document, which is exactly what § 5 forbids.
    expect(column.contains(rail)).toBe(false);
    expect(within(column).queryByTestId("chat-rail")).toBeNull();
    expect(column.parentElement).toBe(rail.parentElement);
  });
});

describe("W14's left column", () => {
  it("renders every region, in the order § 5 draws them", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    const sections = Array.from(
      screen.getByTestId("detail-column").querySelectorAll("[data-testid^='section-']"),
    ).map((node) => node.getAttribute("data-testid"));
    expect(sections).toEqual([
      "section-scoreboard",
      "section-conditions",
      "section-charts",
      "section-artifacts",
      "section-proposals",
      "section-timeline",
    ]);
    expect(screen.getByTestId("challenged-case")).toBeInTheDocument();
    expect(screen.getByTestId("verdict-actions")).toBeInTheDocument();
    expect(screen.getByTestId("report-frame-host")).toBeInTheDocument();
  });

  it("🔴 joins the spec's STATISTIC to each row BY CONDITION ID, not by index", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // `stat` lives on the spec's condition, not on the evaluation's — the page
    // is the only place that holds both. The fixture's two orders disagree, so
    // an index join lands `drawdown_pct` on `c2` and this goes red.
    const rows = screen.getAllByTestId("condition-table-row");
    const statOf = (row: Element): string | null | undefined =>
      row.querySelectorAll("td")[2]?.textContent;
    const byId = new Map(rows.map((row) => [row.getAttribute("data-condition-id"), row]));
    expect([...byId.keys()]).toEqual(["c1", "c2"]);
    expect(statOf(byId.get("c1") as Element)).toBe("drawdown_pct");
    expect(statOf(byId.get("c2") as Element)).toBe("change_pct");
  });

  it("renders an em dash for a condition the spec does not name", async () => {
    const body = fullBody();
    // `detailBody`'s return type does not reflect the spread, so the widening
    // goes through `unknown` — `as` alone is TS2352, which `vitest run` would
    // never have told us (esbuild strips types without checking them) and
    // `yarn build` does.
    const spec = (body as unknown as { spec: { invalidation: unknown[] } }).spec;
    spec.invalidation = [];
    await renderDetail({
      [DETAIL]: { json: body },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    for (const row of screen.getAllByTestId("condition-table-row")) {
      expect(row.querySelectorAll("td")[2]?.textContent).toBe("—");
    }
  });

  it("fetches one series per metric of a LOCKED spec", async () => {
    const stub = await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    expect(stub.countFor(ID_SERIES("brent_crude"))).toBe(1);
    expect(stub.countFor(DETAIL)).toBe(1);
  });

  it("reads the detail payload EXACTLY ONCE per load", async () => {
    const stub = await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // One detail type, one detail fetch. A second read here would mean two
    // components disagreeing about the same payload.
    expect(stub.countFor(DETAIL)).toBe(1);
  });
});

describe("🔴 R141 — the truncated title carries its sentence HERE", () => {
  it("shows a degraded sentence naming the 500-byte cut", async () => {
    await renderDetail({
      [DETAIL]: { json: detailBody({ hypothesis: { ...detailBody().hypothesis, title_truncated: true } }) },
      [TOKEN]: tokenRoute,
    });
    const marker = screen.getByTestId("severity");
    expect(marker).toHaveAttribute("data-severity", "degraded");
    expect(marker).toHaveTextContent("500-byte snippet");
  });

  it("shows no such sentence when the title is complete", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.queryByTestId("severity")).toBeNull();
  });
});

describe("🔴 a missing block costs a region, never the page", () => {
  it("renders the whole page from a payload carrying ONLY W13's fields", async () => {
    // No spec, no evaluation, no notes, no amendments, no verdict, no atoms —
    // on a LIVE hypothesis, where every empty region is still rendered. (On a
    // draft these same blocks collapse; that is asserted separately below.)
    await renderDetail({ [DETAIL]: { json: livePayload() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("detail-column")).toBeInTheDocument();
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "false");
    expect(screen.getByTestId("condition-table-empty")).toBeInTheDocument();
    expect(screen.getByTestId("charts-no-spec")).toBeInTheDocument();
    expect(screen.getByTestId("amendments-empty")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  // ── The draft-only layout collapse (2026-09-07) ─────────────────────────
  //
  // A fresh draft opened on a title, a disabled GO LIVE, two refusal
  // sentences, eight empty sections and a 480–900px empty report box, and the
  // reader's own report was "I'm not sure what to do". These four assert the
  // fix AND its limit: nothing is hidden once the hypothesis has left draft.

  it("🔴 a draft does NOT render the empty 480-900px report frame", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("report-section")).toHaveAttribute("data-report-frame", "suppressed");
    expect(screen.queryByTestId("report-frame-host")).toBeNull();
    // The sentence the box existed to say is still said.
    expect(screen.getByTestId("report-section")).toHaveTextContent("No report template yet");
  });

  it("a draft WITH an accepted template gets the frame back", async () => {
    await renderDetail({
      [DETAIL]: { json: detailBody({ report: reportBlock() }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("report-section")).toHaveAttribute("data-report-frame", "shown");
    expect(screen.getByTestId("report-frame-host")).toBeInTheDocument();
  });

  it("🔴 a draft collapses the four empty analysis sections into one line", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("analysis-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("scoreboard")).toBeNull();
    expect(screen.queryByTestId("condition-table-empty")).toBeNull();
    // ARTIFACTS and TIMELINE are one line each and are meaningful on a draft:
    // they are NOT collapsed, and hiding them would be hiding a fact.
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("🔴 THE LIMIT: a LIVE hypothesis collapses nothing, however empty", async () => {
    // An empty scoreboard on a live hypothesis is a real finding — the
    // researcher has not produced a reading — and must stay on the page.
    await renderDetail({ [DETAIL]: { json: livePayload() }, [TOKEN]: tokenRoute });
    expect(screen.queryByTestId("analysis-empty")).toBeNull();
    expect(screen.getByTestId("scoreboard")).toBeInTheDocument();
    expect(screen.getByTestId("report-section")).toHaveAttribute("data-report-frame", "shown");
  });

  it("a draft mid-interview shows NO next-step banner", async () => {
    await renderDetail({
      [DETAIL]: { json: detailBody({ spec_validation: { valid: false, errors: [] } }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.queryByTestId("next-step")).toBeNull();
  });

  it("a draft whose spec validates DOES get one — the template is a real next step", async () => {
    await renderDetail({
      [DETAIL]: { json: detailBody({ spec_validation: { valid: true, errors: [] } }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("next-step-say")).toHaveTextContent("report template");
  });

  it("a draft offers Archive; the transition is legal from draft", async () => {
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("archive-open")).toBeInTheDocument();
  });

  it("renders when `evaluation` is explicitly null", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody({ evaluation: null, spec: null, spec_source: null }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "false");
    expect(screen.getByTestId("challenged-case")).toBeInTheDocument();
  });

  it("renders when spec_validation is absent entirely", async () => {
    // R140: an absent optional field threw INSIDE render and unmounted the
    // page. This is that regression, kept.
    const body = fullBody();
    delete (body as Record<string, unknown>)["spec_validation"];
    await renderDetail({ [DETAIL]: { json: body }, [TOKEN]: tokenRoute, [ID_SERIES("brent_crude")]: seriesBody });
    expect(screen.getByTestId("detail-column")).toBeInTheDocument();
    expect(screen.getByTestId("go-live-button")).toBeInTheDocument();
  });

  it("renders when the spec is malformed JSON rather than a spec", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody({ spec: { metrics: "nope", invalidation: 7 } }) },
      [TOKEN]: tokenRoute,
    });
    expect(screen.getByTestId("charts-no-metrics")).toBeInTheDocument();
    expect(screen.getByTestId("detail-column")).toBeInTheDocument();
  });
});

describe("🔴 status never comes from an Orange delivery", () => {
  it("renders correctly from a payload carrying no delivery information at all", async () => {
    const body = fullBody();
    expect(JSON.stringify(body)).not.toContain("delivery");
    await renderDetail({
      [DETAIL]: { json: body },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // The status comes from the trusted `hypothesis` memory, which is what
    // puts the verdict buttons on the page.
    expect(screen.getByTestId("status-chip")).toHaveAttribute("data-status", "challenged");
    expect(screen.getByTestId("verdict-actions")).toBeInTheDocument();
  });
});

/**
 * 🔴 R139: jsdom defines no `window.matchMedia`, so MUI's `useMediaQuery` is
 * always `false` and the below-`md` branch runs in NO test unless one is
 * stubbed. W13 lost a fix round to exactly this. The stub is local to this
 * block; `unstubAllGlobals` in the file's `afterEach` removes it.
 */
describe("the detail page below the md breakpoint", () => {
  function stubNarrowViewport(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("keeps the whole left column while the rail collapses to a tab", async () => {
    stubNarrowViewport();
    await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // Proof the branch actually ran: without the stub this is "rail".
    expect(screen.getByTestId("chat-rail")).toHaveAttribute("data-rail-mode", "tab");
    // And the column is still a sibling, still carrying every region.
    const column = screen.getByTestId("detail-column");
    expect(column.contains(screen.getByTestId("chat-rail"))).toBe(false);
    expect(screen.getByTestId("section-conditions")).toBeInTheDocument();
    expect(screen.getByTestId("section-timeline")).toBeInTheDocument();
  });
});

// ── W23: the band and the report panel ──────────────────────────────────

const REPORT = {
  has_template: true,
  structure_hash: "9f2c",
  stripped_count: 0,
  updated_at_ms: Date.UTC(2026, 7, 24, 6),
  drift: { orphan_slots: [], unfilled_slots: [] },
  unreadable: false,
  tamper: null,
};

describe("W23's verdict band", () => {
  it("composes ABOVE the verdict actions, without absorbing them", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    const band = screen.getByTestId("verdict-band");
    const actions = screen.getByTestId("verdict-actions");
    // Two components, not one: the "buttons only in `challenged`" rule lives
    // in `VerdictActions`, and folding them together would put it in two
    // places.
    expect(band.contains(actions)).toBe(false);
    expect(band.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the band in a state that has no buttons at all", async () => {
    // `draft`: `VerdictActions` renders nothing, and the band still has to
    // say where the hypothesis stands.
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.queryByTestId("verdict-actions")).toBeNull();
    expect(screen.getByTestId("verdict-band-status")).toHaveTextContent("draft");
  });

  it("takes its counts from the evaluation the page already fetched", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody() },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // One fetch, handed down. The fixture is one tripped and one holding.
    expect(screen.getByTestId("verdict-band-count-tripped")).toHaveTextContent("1");
    expect(screen.getByTestId("verdict-band-count-holding")).toHaveTextContent("1");
    expect(screen.getByTestId("verdict-band-count-indeterminate")).toHaveTextContent("0");
  });
});

describe("W23's report panel, in its host", () => {
  it("replaces W14's placeholder with the real panel", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody({ report: REPORT }) },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    expect(screen.queryByTestId("report-placeholder")).toBeNull();
    const host = screen.getByTestId("report-frame-host");
    expect(within(host).getByTestId("report-frame")).toBeInTheDocument();
  });

  it("🔴 keeps the sandbox in the EXPANDED copy too", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody({ report: REPORT }) },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    fireEvent.click(screen.getByTestId("report-expand"));
    const expanded = screen.getByTestId("report-frame-host-expanded");
    const frame = within(expanded).getByTestId("report-frame");
    // The expand dialog renders the SAME component, so it carries the same
    // sandbox — a preview that differs from production defeats the purpose,
    // and a full-viewport frame that regained this origin would be the worst
    // possible place to lose it.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
    // Still exactly one live frame.
    expect(screen.getAllByTestId("report-frame").length).toBe(1);
  });

  it("sits on the model provenance ground with a stamp when a template is locked", async () => {
    await renderDetail({
      [DETAIL]: { json: fullBody({ report: REPORT }) },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    const section = screen.getByTestId("report-section");
    const ground = within(section).getByTestId("provenance");
    expect(ground).toHaveAttribute("data-provenance", "model");
    expect(within(ground).getByTestId("report-frame-host")).toBeInTheDocument();
    // The stamp is above the frame, not inside it.
    const stamp = within(ground).getByTestId("provenance-stamp");
    expect(stamp.contains(screen.getByTestId("report-frame"))).toBe(false);
  });

  it("uses NO provenance ground when there is no template — nothing model-authored is on screen", async () => {
    await renderDetail({
      [DETAIL]: {
        json: fullBody({
          report: { ...REPORT, has_template: false, structure_hash: null, drift: null },
        }),
      },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    const section = screen.getByTestId("report-section");
    // `Provenance kind="machine"` renders no wrapper at all: a tinted ground
    // and a writer's stamp over an empty state would be claiming an author
    // for content nobody has written.
    expect(within(section).queryByTestId("provenance")).toBeNull();
    expect(within(section).getByTestId("report-empty")).toBeInTheDocument();
  });

  it("🔴 shows the notices ABOVE the frame's box, not inside it", async () => {
    await renderDetail({
      [DETAIL]: {
        json: fullBody({
          report: {
            ...REPORT,
            stripped_count: 2,
            drift: { orphan_slots: ["stale-slot"], unfilled_slots: [] },
          },
        }),
      },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    const notices = screen.getByTestId("report-notices");
    const host = screen.getByTestId("report-frame-host");
    // The host scrolls internally at a fixed height. A notice inside it would
    // scroll away from the report it is about.
    expect(host.contains(notices)).toBe(false);
    expect(notices.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("report-notice-stripped")).toBeInTheDocument();
    expect(screen.getByTestId("report-notice-drift")).toHaveTextContent("stale-slot");
  });

  it("🔴 an unreadable report degrades the panel and never the page", async () => {
    await renderDetail({
      [DETAIL]: {
        json: fullBody({
          report: {
            ...REPORT,
            drift: null,
            unreadable: true,
            tamper: [
              {
                reason: "cross_hypothesis_write",
                written_by_worker: "",
                written_by_session: "sess_18ab",
                memory_id: "mem_99",
              },
            ],
          },
        }),
      },
      [TOKEN]: tokenRoute,
      [ID_SERIES("brent_crude")]: seriesBody,
    });
    // Model-authored content must never be able to take the human's controls
    // away: the verdict buttons and every other region are still here.
    expect(screen.getByTestId("verdict-actions")).toBeInTheDocument();
    expect(screen.getByTestId("section-conditions")).toBeInTheDocument();
    expect(screen.getByTestId("report-withheld")).toBeInTheDocument();
    expect(screen.queryByTestId("report-frame")).toBeNull();
    // …and the tamper the board would have named is named here too.
    expect(screen.getByTestId("report-notice-tamper")).toHaveTextContent(/cross-hypothesis write/i);
  });

  it("renders the panel's empty state for a payload with no report block at all", async () => {
    // Every existing fixture on this page omits it; a missing block costs the
    // panel, never the page (R140).
    await renderDetail({ [DETAIL]: { json: livePayload() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("report-frame-host")).toBeInTheDocument();
    expect(screen.getByTestId("report-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("report-frame")).toBeNull();
  });
});
