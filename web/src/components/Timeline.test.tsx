/**
 * W14 — the timeline.
 *
 * The load-bearing tests: newest-first ordering across four different kinds,
 * and every row labelled trusted or untrusted on BOTH channels — the
 * provenance treatment and the word.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import Timeline, { SNIPPET_NOTE, buildTimeline } from "./Timeline.js";
import { lightTheme } from "../theme.js";
import type { EvidenceRow, HypothesisDetail } from "../api/types.js";

const ID = "1a2b3c4d";
const T = (day: number, hour = 0): number => Date.UTC(2026, 7, day, hour);

function evidence(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "mem_1",
    snippet: "brent held near 78; DXY unchanged",
    status: null,
    created_at_ms: T(10),
    created_by_worker: "researcher-1a2b3c4d",
    created_by_session: "",
    ...over,
  };
}

function detail(over: Partial<HypothesisDetail> = {}): HypothesisDetail {
  return {
    hypothesis: {
      id: ID,
      session_name: `hyp-${ID}`,
      session_id: "sess",
      title: "Petrodollar / drone parts",
      title_truncated: false,
      owner: "kai",
      status: "challenged",
      status_memory_id: "mem_state",
      updated_at_ms: T(20),
      restated_from: null,
    },
    spec_source: "hypothesis-spec",
    spec_validation: { valid: true, errors: [] },
    ...over,
  };
}

function renderTimeline(value: HypothesisDetail) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <Timeline detail={value} />
    </ThemeProvider>,
  );
}

describe("newest first, across every kind", () => {
  it("orders the state row, verdict, notes and amendments by created_at_ms descending", () => {
    const items = buildTimeline(
      detail({
        verdict: { id: "mem_v", status: "confirmed", content: "held", created_at_ms: T(22) },
        notes: [
          evidence({ id: "mem_n1", created_at_ms: T(18) }),
          evidence({ id: "mem_n2", created_at_ms: T(5) }),
        ],
        amendments: [evidence({ id: "mem_a1", created_at_ms: T(19), status: "proposed" })],
      }),
    );
    expect(items.map((item) => item.key)).toEqual([
      "verdict:mem_v",
      "hypothesis:mem_state",
      "spec-amendment:mem_a1",
      "research-note:mem_n1",
      "research-note:mem_n2",
    ]);
  });

  it("renders the rows in that same order in the DOM", () => {
    renderTimeline(
      detail({
        notes: [
          evidence({ id: "mem_old", created_at_ms: T(1), snippet: "the older note" }),
          evidence({ id: "mem_new", created_at_ms: T(23), snippet: "the newer note" }),
        ],
      }),
    );
    const rows = screen.getAllByTestId("timeline-row");
    expect(rows[0]).toHaveTextContent("the newer note");
    expect(rows[rows.length - 1]).toHaveTextContent("the older note");
  });

  it("sorts a row with no timestamp last rather than to 1970", () => {
    const items = buildTimeline(
      detail({
        hypothesis: { ...detail().hypothesis, updated_at_ms: null },
        notes: [evidence({ id: "mem_n", created_at_ms: T(2) })],
      }),
    );
    expect(items[items.length - 1]?.kind).toBe("hypothesis");
  });
});

describe("🔴 every row is labelled trusted or untrusted", () => {
  it("labels the four kinds per § 'Memory kinds' — in words", () => {
    renderTimeline(
      detail({
        verdict: { id: "mem_v", status: "invalidated", content: "the thesis failed", created_at_ms: T(22) },
        notes: [evidence({ id: "mem_n" })],
        amendments: [evidence({ id: "mem_a", status: "proposed" })],
      }),
    );
    const byKind = new Map(
      screen.getAllByTestId("timeline-row").map((row) => [row.getAttribute("data-kind"), row]),
    );
    expect(byKind.get("hypothesis")).toHaveAttribute("data-trust", "trusted");
    expect(byKind.get("verdict")).toHaveAttribute("data-trust", "trusted");
    expect(byKind.get("research-note")).toHaveAttribute("data-trust", "untrusted");
    expect(byKind.get("spec-amendment")).toHaveAttribute("data-trust", "untrusted");

    expect(within(byKind.get("verdict") as HTMLElement).getByTestId("timeline-trust-label")).toHaveTextContent(
      "trusted",
    );
    expect(
      within(byKind.get("research-note") as HTMLElement).getByTestId("timeline-trust-label"),
    ).toHaveTextContent("untrusted");
  });

  it("gives untrusted rows the model provenance treatment and trusted rows none at all", () => {
    renderTimeline(
      detail({
        verdict: { id: "mem_v", status: "confirmed", content: "held", created_at_ms: T(22) },
        notes: [evidence({ id: "mem_n", created_by_worker: "researcher-4f2a" })],
      }),
    );
    const rows = screen.getAllByTestId("timeline-row");
    const untrusted = rows.filter((row) => row.getAttribute("data-trust") === "untrusted");
    const trusted = rows.filter((row) => row.getAttribute("data-trust") === "trusted");

    expect(untrusted.length).toBe(1);
    expect(trusted.length).toBe(2);
    for (const row of untrusted) {
      expect(within(row).getByTestId("provenance")).toHaveAttribute("data-provenance", "model");
    }
    for (const row of trusted) {
      expect(within(row).queryByTestId("provenance")).toBeNull();
    }
  });

  it("stamps an untrusted row with the writer it names", () => {
    renderTimeline(detail({ notes: [evidence({ created_by_worker: "researcher-4f2a" })] }));
    expect(screen.getByTestId("provenance-stamp")).toHaveTextContent("researcher-4f2a");
  });

  it("falls back to the session when a row names no worker", () => {
    renderTimeline(
      detail({ notes: [evidence({ created_by_worker: "", created_by_session: "hyp-1a2b3c4d" })] }),
    );
    expect(screen.getByTestId("provenance-stamp")).toHaveTextContent("hyp-1a2b3c4d");
  });

  it("says out loud that the untrusted rows are 500-byte snippets", () => {
    renderTimeline(detail({ notes: [evidence()] }));
    expect(screen.getByTestId("timeline-snippet-note")).toHaveTextContent(SNIPPET_NOTE);
  });

  it("omits the snippet note when there is nothing untrusted to qualify", () => {
    renderTimeline(detail());
    expect(screen.queryByTestId("timeline-snippet-note")).toBeNull();
  });
});

describe("🔴 it degrades instead of throwing", () => {
  it("renders with no notes, no amendments and no verdict at all", () => {
    renderTimeline(detail());
    expect(screen.getAllByTestId("timeline-row").length).toBe(1);
  });

  it("survives a payload whose notes and amendments are not arrays", () => {
    const malformed = detail({
      notes: null as unknown as EvidenceRow[],
      amendments: "nope" as unknown as EvidenceRow[],
    });
    renderTimeline(malformed);
    expect(screen.getAllByTestId("timeline-row").length).toBe(1);
  });

  it("renders a hypothesis with no trusted state row rather than dropping it", () => {
    renderTimeline(detail({ hypothesis: { ...detail().hypothesis, status: null } }));
    expect(screen.getByTestId("timeline-row")).toHaveTextContent("no state row");
  });
});
