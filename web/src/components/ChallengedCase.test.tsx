/**
 * W14 — the `challenged`-only block.
 *
 * Two load-bearing properties: it appears in `challenged` and in NO other
 * state, and the three research notes are labelled as the agent's untrusted
 * evidence rather than as a recommendation. The second is not decoration —
 * nothing wakes the researcher when a condition trips, so these are three
 * ordinary daily notes and a human must not read them as an argument someone
 * assembled.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import ChallengedCase, {
  EVIDENCE_HEADING,
  REASON_NOT_SERVED,
  challengeReasonText,
  recentNotes,
  trippedConditions,
} from "./ChallengedCase.js";
import { lightTheme } from "../theme.js";
import { HYPOTHESIS_STATES } from "../api/types.js";
import type { ConditionResult, EvaluationResult, EvidenceRow } from "../api/types.js";

function condition(over: Partial<ConditionResult> = {}): ConditionResult {
  return {
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
    ...over,
  };
}

function note(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "mem_n",
    snippet: "brent slid again; nothing in the drone-parts index moved",
    status: null,
    created_at_ms: Date.UTC(2026, 7, 20),
    created_by_worker: "researcher-1a2b3c4d",
    created_by_session: "",
    ...over,
  };
}

const EVALUATION: EvaluationResult = {
  evaluated_at_ms: Date.UTC(2026, 7, 21),
  support_score: -0.4,
  conditions: [
    condition({ id: "c1", state: "holding" }),
    condition({ id: "c2", state: "tripped" }),
    condition({ id: "c3", state: "indeterminate", reason: "stale_data" }),
  ],
  metrics: [],
};

function renderCase(over: Partial<Parameters<typeof ChallengedCase>[0]> = {}) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <ChallengedCase
        status="challenged"
        evaluation={EVALUATION}
        notes={[note()]}
        {...over}
      />
    </ThemeProvider>,
  );
}

describe("🔴 it shows in `challenged` and in no other state", () => {
  it.each(HYPOTHESIS_STATES)("%s", (status) => {
    renderCase({ status });
    if (status === "challenged") {
      expect(screen.getByTestId("challenged-case")).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId("challenged-case")).toBeNull();
    }
  });

  it("shows nothing for a hypothesis with no trusted state row", () => {
    renderCase({ status: null });
    expect(screen.queryByTestId("challenged-case")).toBeNull();
  });
});

describe("the tripped rows, and only the tripped rows", () => {
  it("renders the tripped condition in full and omits holding and indeterminate", () => {
    renderCase({ statFor: (id) => (id === "c2" ? "change_pct" : undefined) });
    const rows = screen.getAllByTestId("case-conditions-row");
    expect(rows.length).toBe(1);
    const row = rows[0] as HTMLElement;
    expect(row).toHaveAttribute("data-condition-id", "c2");
    expect(within(row).getByText("brent_crude")).toBeInTheDocument();
    expect(within(row).getByText("change_pct")).toBeInTheDocument();
    expect(within(row).getByText("-12.4")).toBeInTheDocument();
    expect(within(row).getByText("< -10")).toBeInTheDocument();
    expect(within(row).getByText("1 Jun 2026–21 Aug 2026")).toBeInTheDocument();
    expect(within(row).getByText("58")).toBeInTheDocument();
  });

  it("says so explicitly when a hypothesis was challenged with nothing tripped", () => {
    renderCase({ evaluation: { ...EVALUATION, conditions: [condition({ state: "holding" })] } });
    expect(screen.getByTestId("case-conditions-empty")).toHaveTextContent("challenged at its horizon");
  });

  it("filters a malformed evaluation without throwing", () => {
    expect(trippedConditions(null)).toEqual([]);
    expect(trippedConditions(undefined)).toEqual([]);
    expect(trippedConditions({ conditions: "nope" } as unknown as EvaluationResult)).toEqual([]);
  });
});

describe("🔴 the three research notes, labelled as evidence and not as a recommendation", () => {
  it("names them the agent's untrusted evidence, NOT a recommendation", () => {
    renderCase();
    const heading = screen.getByTestId("case-evidence-heading");
    expect(heading).toHaveTextContent(EVIDENCE_HEADING);
    expect(heading.textContent).toContain("untrusted");
    expect(heading.textContent).toContain("not a recommendation");
  });

  it("shows the THREE most recent notes, newest first, and no more", () => {
    const notes = [1, 2, 3, 4, 5].map((day) =>
      note({ id: `mem_${day}`, created_at_ms: Date.UTC(2026, 7, day), snippet: `note ${day}` }),
    );
    renderCase({ notes });
    const rendered = screen.getAllByTestId("case-note");
    expect(rendered.map((row) => row.getAttribute("data-note-id"))).toEqual([
      "mem_5",
      "mem_4",
      "mem_3",
    ]);
  });

  it("sorts them itself rather than trusting the payload's order", () => {
    const rows = recentNotes([
      note({ id: "old", created_at_ms: 1 }),
      note({ id: "new", created_at_ms: 3 }),
      note({ id: "mid", created_at_ms: 2 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "mid", "old"]);
  });

  it("puts each note on the model provenance ground with its writer's stamp", () => {
    renderCase({ notes: [note({ created_by_worker: "researcher-4f2a" })] });
    const row = screen.getByTestId("case-note");
    expect(row).toHaveAttribute("data-trust", "untrusted");
    expect(within(row).getByTestId("provenance")).toHaveAttribute("data-provenance", "model");
    expect(within(row).getByTestId("provenance-stamp")).toHaveTextContent("researcher-4f2a");
  });

  it("says the researcher has written nothing rather than showing an empty region", () => {
    renderCase({ notes: [] });
    expect(screen.getByTestId("case-evidence-empty")).toBeInTheDocument();
  });

  it("survives a notes block that is not an array", () => {
    renderCase({ notes: null as unknown as EvidenceRow[] });
    expect(screen.getByTestId("case-evidence-empty")).toBeInTheDocument();
  });
});

describe("the challenge reason", () => {
  it("renders W10's token verbatim, with a gloss", () => {
    renderCase({ challengeReason: "condition_tripped" });
    const line = screen.getByTestId("challenge-reason");
    expect(line).toHaveTextContent("condition_tripped");
    expect(line).toHaveTextContent("a condition tripped");
  });

  it("renders the horizon reason verbatim too", () => {
    renderCase({ challengeReason: "horizon_reached" });
    expect(screen.getByTestId("challenge-reason")).toHaveTextContent("horizon_reached");
  });

  it("renders a reason outside W10's two verbatim rather than dropping it", () => {
    renderCase({ challengeReason: "some_new_reason" });
    expect(screen.getByTestId("challenge-reason")).toHaveTextContent("some_new_reason");
  });

  it("🔴 says the reason is not served rather than DERIVING one from the tripped rows", () => {
    // The payload below has a tripped condition. A component that inferred
    // `condition_tripped` from it would be a second authority for a value the
    // poller already recorded, and it would be wrong for a hypothesis
    // challenged at its horizon whose conditions tripped afterwards.
    renderCase({ challengeReason: undefined });
    const line = screen.getByTestId("challenge-reason");
    // 🔴 The LITERAL sentence, not the imported constant: asserting the
    // constant lets it be emptied to "" and stay green, and "states its
    // absence plainly" is half of what this criterion is worth.
    expect(REASON_NOT_SERVED).toBe(
      "the challenge reason is not carried by this payload — it is recorded on the hypothesis memory",
    );
    expect(line).toHaveTextContent("the challenge reason is not carried by this payload");
    expect(line.textContent).not.toContain("condition_tripped");
    expect(challengeReasonText(null)).toBe(REASON_NOT_SERVED);
    expect(challengeReasonText("  ")).toBe(REASON_NOT_SERVED);
  });
});
