import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { Route, Routes } from "react-router";
import NewHypothesis from "./NewHypothesis.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const CREATE = "POST /api/hypotheses";

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/new" element={<NewHypothesis />} />
      <Route path="/hypotheses/:id" element={<div data-testid="detail-page">detail</div>} />
    </Routes>,
    { route: "/new" },
  );
}

function type(testId: string, value: string): void {
  const input = screen.getByTestId(testId).querySelector("input, textarea");
  if (input === null) throw new Error(`no input inside ${testId}`);
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewHypothesis", () => {
  it("posts { title } and, on 201, goes to the new hypothesis", async () => {
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    type("new-title", "Petrodollar / drone parts");

    await act(async () => {
      screen.getByTestId("new-submit").click();
    });

    expect(stub.countFor(CREATE)).toBe(1);
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Petrodollar / drone parts" });
    expect(screen.getByTestId("detail-page")).toBeInTheDocument();
  });

  it("sends the optional thesis only when one was typed", async () => {
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    type("new-title", "Copper supply squeeze");
    type("new-thesis", "Mine outages persist into Q4.");
    await act(async () => {
      screen.getByTestId("new-submit").click();
    });
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Copper supply squeeze",
      thesis: "Mine outages persist into Q4.",
    });
  });

  it("surfaces Orange's create error VERBATIM — 'host port pool is exhausted' is actionable", async () => {
    stubFetchRoutes({
      [CREATE]: {
        status: 503,
        json: { kind: "unavailable", message: "host port pool is exhausted" },
      },
    });
    renderPage();
    type("new-title", "Yen carry unwind");
    await act(async () => {
      screen.getByTestId("new-submit").click();
    });

    const severity = screen.getByTestId("severity");
    expect(severity).toHaveTextContent("host port pool is exhausted");
    // Not flattened, not prefixed into uselessness, and not replaced. The
    // only extra character is W28's `degraded` glyph, which is the severity
    // channel's own mark and not part of the sentence.
    expect((severity.textContent ?? "").replace(/^△/, "")).toBe("host port pool is exhausted");
    expect(screen.queryByTestId("detail-page")).toBeNull();
  });

  it("will not post an empty or whitespace-only title", async () => {
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    expect(screen.getByTestId("new-submit")).toBeDisabled();
    type("new-title", "   ");
    expect(screen.getByTestId("new-submit")).toBeDisabled();
    expect(stub.mock).not.toHaveBeenCalled();
  });
});
