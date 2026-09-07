import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import ArchiveButton from "./ArchiveButton.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const RETIRE = `POST /api/hypotheses/${ID}/retire`;

function typeRationale(value: string): void {
  const input = screen.getByTestId("archive-rationale").querySelector("input, textarea");
  if (input === null) throw new Error("no rationale input");
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArchiveButton", () => {
  it("🔴 renders NOTHING for a status whose `→ archived` transition is illegal", () => {
    // Not a second gate: W5's state machine is the gate. This is the
    // affordance matching it, so a control is never offered for something the
    // server would refuse.
    for (const status of ["confirmed", "invalidated", "archived", null, undefined]) {
      const { unmount } = renderWithProviders(
        <ArchiveButton hypothesisId={ID} status={status} />,
      );
      expect(screen.queryByTestId("archive-open")).toBeNull();
      unmount();
    }
  });

  it("offers itself on draft, live and challenged", () => {
    for (const status of ["draft", "live", "challenged"]) {
      const { unmount } = renderWithProviders(<ArchiveButton hypothesisId={ID} status={status} />);
      expect(screen.getByTestId("archive-open")).toBeInTheDocument();
      unmount();
    }
  });

  it("🔴 a rationale is required, and whitespace is not one", async () => {
    const stub = stubFetchRoutes({ [RETIRE]: { status: 200, json: {} } });
    renderWithProviders(<ArchiveButton hypothesisId={ID} status="draft" />);
    act(() => {
      screen.getByTestId("archive-open").click();
    });

    expect(screen.getByTestId("archive-confirm")).toBeDisabled();
    typeRationale("   ");
    expect(screen.getByTestId("archive-confirm")).toBeDisabled();

    // Belt to the disabled attribute's braces: a blank rationale is a 400 in
    // front of someone who has already decided.
    await act(async () => {
      screen.getByTestId("archive-confirm").click();
    });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it("posts the TRIMMED rationale and calls back so the caller can re-read", async () => {
    const stub = stubFetchRoutes({ [RETIRE]: { status: 200, json: {} } });
    const onDone = vi.fn();
    renderWithProviders(<ArchiveButton hypothesisId={ID} status="draft" onDone={onDone} />);
    act(() => {
      screen.getByTestId("archive-open").click();
    });
    typeRationale("  created by mistake  ");

    await act(async () => {
      screen.getByTestId("archive-confirm").click();
    });

    expect(stub.countFor(RETIRE)).toBe(1);
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ rationale: "created by mistake" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's sentence and does NOT call back on failure", async () => {
    const stub = stubFetchRoutes({
      [RETIRE]: { status: 409, json: { kind: "conflict", message: "draft → archived is illegal" } },
    });
    const onDone = vi.fn();
    renderWithProviders(<ArchiveButton hypothesisId={ID} status="draft" onDone={onDone} />);
    act(() => {
      screen.getByTestId("archive-open").click();
    });
    typeRationale("nope");

    await act(async () => {
      screen.getByTestId("archive-confirm").click();
    });

    expect(stub.countFor(RETIRE)).toBe(1);
    expect(screen.getByTestId("severity")).toHaveTextContent("draft → archived is illegal");
    // A board that re-read here would show the row still present and look broken.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says what archiving does — it is not a delete, and must not read as one", () => {
    renderWithProviders(<ArchiveButton hypothesisId={ID} status="draft" />);
    act(() => {
      screen.getByTestId("archive-open").click();
    });
    expect(screen.getByTestId("archive-form")).toHaveTextContent("Nothing is deleted");
  });
});
