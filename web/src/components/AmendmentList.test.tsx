/**
 * W14 — spec amendments.
 *
 * The single most valuable assertion in this file is the request body. It is
 * the one thing no amount of local testing catches if it is written from the
 * ticket rather than from `amendBody`: `"accept"` and `"accepted"` both pass a
 * loose test, and only one of them is not a 400 in front of a human.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AmendmentList, { PROPOSAL_NOTE, SNIPPET_NOTE } from "./AmendmentList.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";
import type { EvidenceRow } from "../api/types.js";

const ID = "1a2b3c4d";
const AMEND = `POST /api/hypotheses/${ID}/amend`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function amendment(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "mem_amend_1",
    snippet: "raise staleness_days from 5 to 7 — FRED restates DGS10 late",
    status: "proposed",
    created_at_ms: Date.UTC(2026, 7, 20, 9, 0),
    created_by_worker: "researcher-1a2b3c4d",
    created_by_session: "",
    ...over,
  };
}

function renderList(rows: EvidenceRow[], onDone?: () => void) {
  return renderWithProviders(
    <AmendmentList hypothesisId={ID} amendments={rows} {...(onDone ? { onDone } : {})} />,
  );
}

function typeRationale(text: string, index = 0): void {
  const field = screen.getAllByTestId("amendment-rationale")[index];
  fireEvent.change(field?.querySelector("textarea") as Element, { target: { value: text } });
}

describe("🔴 proposals render as proposals, labelled untrusted", () => {
  it("carries the word Proposal, the untrusted label and the model provenance ground", () => {
    stubFetchRoutes({});
    renderList([amendment()]);
    const row = screen.getByTestId("amendment");
    expect(row).toHaveAttribute("data-trust", "untrusted");
    expect(within(row).getByText("Proposal")).toBeInTheDocument();
    expect(within(row).getByText("untrusted")).toBeInTheDocument();
    expect(within(row).getByTestId("provenance")).toHaveAttribute("data-provenance", "model");
    expect(within(row).getByTestId("provenance-stamp")).toHaveTextContent("researcher-1a2b3c4d");
  });

  it("says that ACCEPTING is what makes the change trusted", () => {
    stubFetchRoutes({});
    renderList([amendment()]);
    expect(screen.getByTestId("amendment-note")).toHaveTextContent(PROPOSAL_NOTE);
    expect(screen.getByTestId("amendment-note").textContent).toContain("makes the change trusted");
  });

  it("does not claim the snippet is the whole proposal", () => {
    stubFetchRoutes({});
    renderList([amendment()]);
    expect(screen.getByTestId("amendments-snippet-note")).toHaveTextContent(SNIPPET_NOTE);
  });

  it("is NOT a severity treatment — a proposal is the product working", () => {
    // § 2: a research note or a proposal is `model` + `none`. Styling it as a
    // warning is how a real tamper alert loses its force.
    stubFetchRoutes({});
    renderList([amendment()]);
    expect(screen.queryByTestId("severity")).toBeNull();
  });

  it("renders an explicit empty state when nothing has been proposed", () => {
    stubFetchRoutes({});
    renderList([]);
    expect(screen.getByTestId("amendments-empty")).toBeInTheDocument();
  });

  it("survives an amendments block that is not an array", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <AmendmentList hypothesisId={ID} amendments={null as unknown as EvidenceRow[]} />,
    );
    expect(screen.getByTestId("amendments-empty")).toBeInTheDocument();
  });
});

describe("🔴 the amend request body, byte for byte", () => {
  it('posts { amendment_id, decision: "accept", rationale }', async () => {
    let body: unknown;
    const stub = stubFetchRoutes({
      [AMEND]: (_index, init) => {
        body = JSON.parse(String(init?.body));
        return { json: { ok: true } };
      },
    });
    const onDone = vi.fn();
    renderList([amendment()], onDone);
    typeRationale("  the restatement lag is real  ");
    fireEvent.click(screen.getByTestId("amendment-accept"));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(stub.countFor(AMEND)).toBe(1);
    expect(body).toEqual({
      amendment_id: "mem_amend_1",
      decision: "accept",
      rationale: "the restatement lag is real",
    });
    // Spelled out, because this is the assertion that pays for the file: the
    // server's enum is present tense, and the past tense 400s.
    expect((body as { decision: string }).decision).toBe("accept");
    expect((body as { decision: string }).decision).not.toBe("accepted");
  });

  it('posts { amendment_id, decision: "reject", rationale }', async () => {
    let body: unknown;
    stubFetchRoutes({
      [AMEND]: (_index, init) => {
        body = JSON.parse(String(init?.body));
        return { json: {} };
      },
    });
    renderList([amendment()]);
    typeRationale("the spec is right as written");
    fireEvent.click(screen.getByTestId("amendment-reject"));

    await waitFor(() =>
      expect(body).toEqual({
        amendment_id: "mem_amend_1",
        decision: "reject",
        rationale: "the spec is right as written",
      }),
    );
    expect((body as { decision: string }).decision).not.toBe("rejected");
  });

  it("sends the id of the amendment whose buttons were clicked, not the first one", async () => {
    let body: unknown;
    stubFetchRoutes({
      [AMEND]: (_index, init) => {
        body = JSON.parse(String(init?.body));
        return { json: {} };
      },
    });
    renderList([amendment({ id: "mem_a" }), amendment({ id: "mem_b" })]);
    typeRationale("this is the second one", 1);
    fireEvent.click(screen.getAllByTestId("amendment-accept")[1] as Element);

    await waitFor(() =>
      expect(body).toEqual({
        amendment_id: "mem_b",
        decision: "accept",
        rationale: "this is the second one",
      }),
    );
  });
});

describe("🔴 a rationale is required for BOTH decisions", () => {
  it("disables Accept and Reject until non-whitespace text is entered", () => {
    stubFetchRoutes({});
    renderList([amendment()]);
    expect(screen.getByTestId("amendment-accept")).toBeDisabled();
    expect(screen.getByTestId("amendment-reject")).toBeDisabled();

    typeRationale("   \t ");
    expect(screen.getByTestId("amendment-accept")).toBeDisabled();
    expect(screen.getByTestId("amendment-reject")).toBeDisabled();

    typeRationale("because the provider restates");
    expect(screen.getByTestId("amendment-accept")).toBeEnabled();
    expect(screen.getByTestId("amendment-reject")).toBeEnabled();
  });

  it("sends nothing when a click is forced with a whitespace-only rationale", () => {
    const stub = stubFetchRoutes({});
    renderList([amendment()]);
    typeRationale("    ");
    fireEvent.click(screen.getByTestId("amendment-accept"));
    fireEvent.click(screen.getByTestId("amendment-reject"));
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it("keeps each proposal's rationale separate from its neighbour's", () => {
    stubFetchRoutes({});
    renderList([amendment({ id: "mem_a" }), amendment({ id: "mem_b" })]);
    typeRationale("only the second", 1);
    expect(screen.getAllByTestId("amendment-accept")[0]).toBeDisabled();
    expect(screen.getAllByTestId("amendment-accept")[1]).toBeEnabled();
  });
});

describe("a refusal is surfaced verbatim", () => {
  it("shows the server's own sentence", async () => {
    stubFetchRoutes({
      [AMEND]: { status: 404, json: { kind: "not_found", message: "no such amendment" } },
    });
    renderList([amendment()]);
    typeRationale("accept it");
    fireEvent.click(screen.getByTestId("amendment-accept"));
    await waitFor(() => expect(screen.getByTestId("severity")).toHaveTextContent("no such amendment"));
  });
});
