import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import HypothesisDetail from "./HypothesisDetail.js";
import { renderWithProviders, stubFetchRoutes, type FetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const DETAIL = `GET /api/hypotheses/${ID}`;
const TOKEN = `GET /api/hypotheses/${ID}/embed-token`;

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

async function renderDetail(routes: FetchRoutes) {
  const stub = stubFetchRoutes(routes);
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
    expect(screen.getByTestId("orange-chat-frame")).toBeInTheDocument();
  });

  it("takes the Go Live gate from spec_validation and nothing else", async () => {
    await renderDetail({
      [DETAIL]: {
        json: detailBody({
          spec_validation: { valid: false, errors: [{ path: "horizon_days", message: "required" }] },
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
    // No spec, no evaluation, no notes, no amendments, no verdict, no atoms.
    // This is the payload of a hypothesis created ten seconds ago.
    await renderDetail({ [DETAIL]: { json: detailBody() }, [TOKEN]: tokenRoute });
    expect(screen.getByTestId("detail-column")).toBeInTheDocument();
    expect(screen.getByTestId("scoreboard")).toHaveAttribute("data-evaluated", "false");
    expect(screen.getByTestId("condition-table-empty")).toBeInTheDocument();
    expect(screen.getByTestId("charts-no-spec")).toBeInTheDocument();
    expect(screen.getByTestId("amendments-empty")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
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
