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
  it("posts { title, thesis } and, on 201, goes to the new hypothesis", async () => {
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    type("new-title", "Petrodollar / drone parts");
    type("new-thesis", "The petrodollar ends as drone warfare displaces oil-backed leverage.");

    await act(async () => {
      screen.getByTestId("new-submit").click();
    });

    expect(stub.countFor(CREATE)).toBe(1);
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Petrodollar / drone parts",
      thesis: "The petrodollar ends as drone warfare displaces oil-backed leverage.",
    });
    expect(screen.getByTestId("detail-page")).toBeInTheDocument();
  });

  it("🔴 the thesis is REQUIRED — a title alone cannot be submitted", async () => {
    // It was optional, and that was the single most confusing thing in the
    // product: the thesis is the interview's first message, so an empty one is
    // a conversation that cannot start. The server requires it too; this is
    // the affordance matching that gate.
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    type("new-title", "Debasement trade");
    expect(screen.getByTestId("new-submit")).toBeDisabled();

    // Whitespace is not a thesis.
    type("new-thesis", "   ");
    expect(screen.getByTestId("new-submit")).toBeDisabled();

    // Belt to the disabled attribute's braces: a click must not reach the wire.
    await act(async () => {
      screen.getByTestId("new-submit").click();
    });
    expect(stub.mock).not.toHaveBeenCalled();

    type("new-thesis", "Hard assets rise as the currency is debased.");
    expect(screen.getByTestId("new-submit")).not.toBeDisabled();
  });

  it("both fields are sent TRIMMED, so the form and the memory hold the same bytes", async () => {
    const stub = stubFetchRoutes({ [CREATE]: { status: 201, json: { id: "1a2b3c4d" } } });
    renderPage();
    type("new-title", "  Copper supply squeeze  ");
    type("new-thesis", "  Mine outages persist into Q4.  ");
    await act(async () => {
      screen.getByTestId("new-submit").click();
    });
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Copper supply squeeze",
      thesis: "Mine outages persist into Q4.",
    });
  });

  it("🔴 shows a spinner and says why it is slow while the session is provisioned", async () => {
    // The route polls Bob until the session leaves `creating`, and a first
    // create on a cold host also pulls the session image. A form that looks
    // frozen for a minute reads as a bug and gets clicked again.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubFetchRoutes({
      [CREATE]: { status: 201, json: { id: "1a2b3c4d" }, wait: held },
    });
    renderPage();
    type("new-title", "Debasement trade");
    type("new-thesis", "Hard assets rise as the currency is debased.");

    expect(screen.queryByTestId("new-spinner")).toBeNull();
    expect(screen.queryByTestId("new-progress")).toBeNull();

    act(() => {
      screen.getByTestId("new-submit").click();
    });

    expect(screen.getByTestId("new-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("new-progress")).toBeInTheDocument();
    expect(screen.getByTestId("new-submit")).toBeDisabled();

    await act(async () => {
      release?.();
      await held;
    });
    expect(stub.countFor(CREATE)).toBe(1);
  });

  it("surfaces Bob's create error VERBATIM — 'host port pool is exhausted' is actionable", async () => {
    stubFetchRoutes({
      [CREATE]: {
        status: 503,
        json: { kind: "unavailable", message: "host port pool is exhausted" },
      },
    });
    renderPage();
    type("new-title", "Yen carry unwind");
    type("new-thesis", "The BOJ holds and the carry unwinds.");
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
    type("new-thesis", "A perfectly good thesis.");
    type("new-title", "   ");
    expect(screen.getByTestId("new-submit")).toBeDisabled();
    expect(stub.mock).not.toHaveBeenCalled();
  });
});
