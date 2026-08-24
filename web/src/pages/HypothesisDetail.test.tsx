import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
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
