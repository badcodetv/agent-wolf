import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { AppRoutes, AuthenticatedApp } from "./App.js";
import { renderWithProviders, stubFetchRoutes, type FetchRoutes } from "./testUtils.js";

const ME = "GET /api/auth/me";
const BOARD = "GET /api/hypotheses";

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function renderAt(route: string, routes: FetchRoutes) {
  stubFetchRoutes(routes);
  return renderWithProviders(<AppRoutes />, { route });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the route table", () => {
  it("renders the board at /", async () => {
    renderAt("/", { [BOARD]: { json: [] } });
    await settle();
    expect(screen.getByTestId("board-section-needs_human")).toBeInTheDocument();
  });

  it("renders the new-hypothesis form at /new", async () => {
    renderAt("/new", {});
    await settle();
    expect(screen.getByTestId("new-title")).toBeInTheDocument();
  });

  it("renders the archive at /archive", async () => {
    renderAt("/archive", { [BOARD]: { json: [] } });
    await settle();
    expect(screen.getByTestId("archive-empty")).toBeInTheDocument();
  });

  it("renders the detail placeholder at /hypotheses/:id", async () => {
    renderAt("/hypotheses/1a2b3c4d", {
      "GET /api/hypotheses/1a2b3c4d": {
        json: {
          hypothesis: {
            id: "1a2b3c4d",
            session_name: "hyp-1a2b3c4d",
            session_id: "s",
            title: "a thesis",
            title_truncated: false,
            owner: "kai",
            status: "draft",
            status_memory_id: "m",
            updated_at_ms: 1_780_000_000_000,
            restated_from: null,
          },
          spec_source: null,
          spec_validation: { valid: false, errors: [] },
        },
      },
      "GET /api/hypotheses/1a2b3c4d/embed-token": {
        json: { token: "t", expires_at_sec: Math.floor(Date.now() / 1000) + 900, embed_url: "" },
      },
    });
    await settle();
    expect(screen.getByTestId("detail-placeholder")).toBeInTheDocument();
    expect(screen.getByTestId("chat-rail")).toBeInTheDocument();
  });

  it("answers an unknown path rather than rendering nothing", async () => {
    renderAt("/nope", {});
    await settle();
    expect(screen.getByTestId("not-found")).toBeInTheDocument();
  });
});

describe("the sign-in gate", () => {
  it("shows the sign-in page when /api/auth/me answers 401", async () => {
    stubFetchRoutes({ [ME]: { status: 401, json: { kind: "forbidden", message: "not signed in" } } });
    renderWithProviders(<AuthenticatedApp />);
    await settle();
    expect(screen.getByTestId("dev-submit")).toBeInTheDocument();
    expect(screen.queryByTestId("sign-out")).toBeNull();
  });

  it("shows the app, and who is signed in, when /api/auth/me answers 200", async () => {
    stubFetchRoutes({ [ME]: { json: { email: "kai@badcode.dev" } }, [BOARD]: { json: [] } });
    renderWithProviders(<AuthenticatedApp />);
    await settle();
    expect(screen.getByTestId("signed-in-email")).toHaveTextContent("kai@badcode.dev");
    expect(screen.getByTestId("board-section-needs_human")).toBeInTheDocument();
  });

  it("signs out with a POST — never a GET, which a prefetch or an <img> could trigger", async () => {
    const stub = stubFetchRoutes({
      [ME]: { json: { email: "kai@badcode.dev" } },
      [BOARD]: { json: [] },
      "POST /api/auth/logout": { status: 204 },
    });
    renderWithProviders(<AuthenticatedApp />);
    await settle();

    await act(async () => {
      screen.getByTestId("sign-out").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(stub.countFor("POST /api/auth/logout")).toBe(1);
    expect(stub.calls.some((call) => call === "GET /api/auth/logout")).toBe(false);
    expect(screen.getByTestId("dev-submit")).toBeInTheDocument();
  });
});
