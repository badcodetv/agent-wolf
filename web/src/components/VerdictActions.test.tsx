/**
 * W14 — the verdict gate.
 *
 * Three things are load-bearing here and each has already been a real bug
 * somewhere: the buttons appearing outside `challenged`, a whitespace-only
 * rationale reaching the wire, and the request body's field names.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import VerdictActions from "./VerdictActions.js";
import { HYPOTHESIS_STATES } from "../api/types.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const VERDICT = `POST /api/hypotheses/${ID}/verdict`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderActions(status: string | null, onDone?: () => void) {
  return renderWithProviders(
    <VerdictActions hypothesisId={ID} status={status} {...(onDone ? { onDone } : {})} />,
  );
}

function type(value: string): void {
  fireEvent.change(screen.getByTestId("verdict-rationale").querySelector("textarea") as Element, {
    target: { value },
  });
}

describe("🔴 both buttons appear ONLY in `challenged`", () => {
  it.each(HYPOTHESIS_STATES)("%s", (status) => {
    stubFetchRoutes({});
    renderActions(status);
    if (status === "challenged") {
      expect(screen.getByTestId("verdict-confirm")).toBeInTheDocument();
      expect(screen.getByTestId("verdict-invalidate")).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId("verdict-actions")).toBeNull();
      expect(screen.queryByTestId("verdict-confirm")).toBeNull();
      expect(screen.queryByTestId("verdict-invalidate")).toBeNull();
    }
  });

  it("renders nothing for a hypothesis with no trusted state row", () => {
    stubFetchRoutes({});
    renderActions(null);
    expect(screen.queryByTestId("verdict-actions")).toBeNull();
  });
});

describe("🔴 a rationale is required, and whitespace is not one", () => {
  it("keeps both buttons disabled with an EMPTY rationale", () => {
    stubFetchRoutes({});
    renderActions("challenged");
    expect(screen.getByTestId("verdict-confirm")).toBeDisabled();
    expect(screen.getByTestId("verdict-invalidate")).toBeDisabled();
    expect(screen.getByTestId("verdict-blocked")).toBeInTheDocument();
  });

  it("keeps both buttons disabled with a WHITESPACE-ONLY rationale", () => {
    stubFetchRoutes({});
    renderActions("challenged");
    type("   \n\t  ");
    expect(screen.getByTestId("verdict-confirm")).toBeDisabled();
    expect(screen.getByTestId("verdict-invalidate")).toBeDisabled();
  });

  it("enables them once real text is entered", () => {
    stubFetchRoutes({});
    renderActions("challenged");
    type("the thesis held: brent never broke the floor");
    expect(screen.getByTestId("verdict-confirm")).toBeEnabled();
    expect(screen.getByTestId("verdict-invalidate")).toBeEnabled();
    expect(screen.queryByTestId("verdict-blocked")).toBeNull();
  });

  it("sends NOTHING when a click is forced with a whitespace-only rationale", () => {
    // The disabled attribute is an affordance; this is the guard. A blank
    // rationale must never reach a route that answers 400 to it.
    const stub = stubFetchRoutes({});
    renderActions("challenged");
    type("     ");
    fireEvent.click(screen.getByTestId("verdict-confirm"));
    expect(stub.mock).not.toHaveBeenCalled();
  });
});

describe("🔴 the request body", () => {
  it("posts { verdict: 'confirmed', rationale } and nothing else", async () => {
    let body: unknown;
    const stub = stubFetchRoutes({
      [VERDICT]: (_index, init) => {
        body = JSON.parse(String(init?.body));
        return { json: { ok: true } };
      },
    });
    const onDone = vi.fn();
    renderActions("challenged", onDone);
    type("  the thesis held  ");
    fireEvent.click(screen.getByTestId("verdict-confirm"));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(stub.countFor(VERDICT)).toBe(1);
    // Byte-exact, keys included: `verdict`, not `decision`; `confirmed`, not
    // `confirm`. Both would pass a looser assertion and 400 in production.
    expect(body).toEqual({ verdict: "confirmed", rationale: "the thesis held" });
  });

  it("posts { verdict: 'invalidated', rationale } for the other button", async () => {
    let body: unknown;
    stubFetchRoutes({
      [VERDICT]: (_index, init) => {
        body = JSON.parse(String(init?.body));
        return { json: { ok: true } };
      },
    });
    renderActions("challenged");
    type("brent broke the floor and stayed there");
    fireEvent.click(screen.getByTestId("verdict-invalidate"));

    await waitFor(() =>
      expect(body).toEqual({ verdict: "invalidated", rationale: "brent broke the floor and stayed there" }),
    );
  });

  it("posts as JSON to the verdict route on this origin", async () => {
    let init: RequestInit | undefined;
    const stub = stubFetchRoutes({
      [VERDICT]: (_index, received) => {
        init = received;
        return { json: {} };
      },
    });
    renderActions("challenged");
    type("done");
    fireEvent.click(screen.getByTestId("verdict-confirm"));
    await waitFor(() => expect(stub.countFor(VERDICT)).toBe(1));
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("a refusal is surfaced verbatim", () => {
  it("shows the server's own sentence and does not clear the rationale", async () => {
    stubFetchRoutes({
      [VERDICT]: { status: 409, json: { kind: "conflict", message: "hypothesis is not challenged" } },
    });
    renderActions("challenged");
    type("the thesis held");
    fireEvent.click(screen.getByTestId("verdict-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("severity")).toHaveTextContent("hypothesis is not challenged"),
    );
    expect(screen.getByTestId("verdict-rationale").querySelector("textarea")).toHaveValue(
      "the thesis held",
    );
  });
});
