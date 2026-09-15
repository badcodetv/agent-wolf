import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import ResearchStrip, { runOutcomeSay } from "./ResearchStrip.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";
import type { ResearchStatus } from "../api/types.js";

const ID = "1a2b3c4d";
const RUN = `POST /api/hypotheses/${ID}/research/run`;
const NOW = Date.UTC(2026, 8, 15, 11, 0);

function idle(over: Partial<ResearchStatus> = {}): ResearchStatus {
  return {
    state: "idle",
    started_at_ms: null,
    last_finished_at_ms: Date.UTC(2026, 8, 15, 10, 43),
    last_outcome: "ok",
    next_run_at_ms: Date.UTC(2026, 8, 16, 6, 0),
    cron: "0 6 * * *",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResearchStrip", () => {
  it("says WHEN it runs, when next, and how the last run went", () => {
    renderWithProviders(<ResearchStrip hypothesisId={ID} research={idle()} onStarted={() => {}} nowMs={NOW} />);
    expect(screen.getByTestId("research-strip-title")).toHaveTextContent("Researcher runs every day at 06:00 UTC");
    expect(screen.getByTestId("research-strip-detail")).toHaveTextContent("Next run in 19 h (16 Sept 2026 06:00 UTC)");
    expect(screen.getByTestId("research-strip-detail")).toHaveTextContent("finished OK");
    expect(screen.getByTestId("research-run-now")).toHaveTextContent("Run now");
  });

  it("before any run, the button offers the first one", () => {
    renderWithProviders(
      <ResearchStrip hypothesisId={ID} research={idle({ last_finished_at_ms: null, last_outcome: null })} onStarted={() => {}} nowMs={NOW} />,
    );
    expect(screen.getByTestId("research-run-now")).toHaveTextContent("Run the first research now");
  });

  it("while running, the button is disabled and progress shows", () => {
    renderWithProviders(
      <ResearchStrip hypothesisId={ID} research={idle({ state: "running", started_at_ms: NOW - 60_000 })} onStarted={() => {}} nowMs={NOW} />,
    );
    expect(screen.getByTestId("research-run-now")).toBeDisabled();
    expect(screen.getByTestId("research-strip-progress")).toBeInTheDocument();
  });

  it("Run now posts once and asks the page to re-read", async () => {
    const stub = stubFetchRoutes({ [RUN]: { json: { outcome: "requested", reason: "" } } });
    const onStarted = vi.fn();
    renderWithProviders(<ResearchStrip hypothesisId={ID} research={idle()} onStarted={onStarted} nowMs={NOW} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("research-run-now"));
    });
    expect(stub.countFor(RUN)).toBe(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("research-run-notice")).toBeNull();
  });

  it("a double press inside a minute is explained, not hidden", async () => {
    stubFetchRoutes({ [RUN]: { json: { outcome: "already_fired", reason: "" } } });
    renderWithProviders(<ResearchStrip hypothesisId={ID} research={idle()} onStarted={() => {}} nowMs={NOW} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("research-run-now"));
    });
    expect(screen.getByTestId("research-run-notice")).toHaveTextContent("not started twice");
  });

  it("a refused run says why", async () => {
    stubFetchRoutes({ [RUN]: { status: 409, json: { kind: "conflict", message: "the researcher schedule is switched off" } } });
    renderWithProviders(<ResearchStrip hypothesisId={ID} research={idle()} onStarted={() => {}} nowMs={NOW} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("research-run-now"));
    });
    expect(screen.getByTestId("research-run-notice")).toBeInTheDocument();
  });

  it("an unreadable schedule costs the strip a sentence, not the page", () => {
    renderWithProviders(<ResearchStrip hypothesisId={ID} research={null} onStarted={() => {}} nowMs={NOW} />);
    expect(screen.getByTestId("research-strip")).toHaveAttribute("data-state", "unknown");
    expect(screen.queryByTestId("research-run-now")).toBeNull();
  });

  it("an unknown outcome is shown verbatim", () => {
    expect(runOutcomeSay("requested", "")).toBeNull();
    expect(runOutcomeSay("sideways", "")).toBe('Bob answered "sideways".');
  });
});
