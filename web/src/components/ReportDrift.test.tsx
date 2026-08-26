/**
 * W23 — the report block's notice strip.
 *
 * Three of the four notices here exist because a field has MORE STATES than
 * the obvious two, and the failure mode of every one of them is the same:
 * the un-handled state renders as the healthy one. So the tests are written in
 * pairs that differ by a single field, and each pair's assertion lists are
 * deliberately diffed against each other.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import ReportDrift, {
  STRIPPED_NOT_COUNTED,
  UNREADABLE_CAUSE,
  driftCause,
  strippedCause,
} from "./ReportDrift.js";
import { lightTheme } from "../theme.js";
import type { ReportBlock, Tamper } from "../api/types.js";

function block(over: Partial<ReportBlock> = {}): ReportBlock {
  return {
    has_template: true,
    structure_hash: "9f2c",
    stripped_count: 0,
    updated_at_ms: 1_789_000_000_123,
    drift: { orphan_slots: [], unfilled_slots: [] },
    unreadable: false,
    tamper: null,
    ...over,
  };
}

function renderNotices(report: ReportBlock | null | undefined) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <ReportDrift report={report} />
    </ThemeProvider>,
  );
}

// ── The healthy report says nothing at all ──────────────────────────────

describe("a healthy report carries no severity at all", () => {
  it("renders no marker for stripped_count 0, no drift and no tamper", () => {
    renderNotices(block());
    // § 2's Channel S: `none` is the overwhelming majority, and it renders
    // NOTHING. A permanent triangle over every healthy report is how a real
    // one stops meaning anything.
    expect(screen.queryByTestId("severity")).toBeNull();
    expect(screen.queryByTestId("report-stripped-uncounted")).toBeNull();
  });

  it("renders nothing for a payload with no report block", () => {
    renderNotices(undefined);
    expect(screen.queryByTestId("severity")).toBeNull();
  });
});

// ── stripped_count: three states, not two ───────────────────────────────

describe("🔴 stripped_count has THREE states", () => {
  it("> 0 is degraded, with a sentence", () => {
    renderNotices(block({ stripped_count: 3 }));
    const notice = within(screen.getByTestId("report-notice-stripped")).getByTestId("severity");
    expect(notice).toHaveAttribute("data-severity", "degraded");
    // The SIGN is the contract; the magnitude is not. This asserts the
    // sentence, never the number: a DOMPurify upgrade moves the count with
    // nothing having changed, and a test pinning `3` would fail on it.
    expect(notice).toHaveTextContent(/content was removed from this report/i);
  });

  it("> 0 renders the same sentence whatever the magnitude", () => {
    renderNotices(block({ stripped_count: 1 }));
    expect(screen.getByTestId("report-notice-stripped")).toHaveTextContent(
      /content was removed from this report/i,
    );
    renderNotices(block({ stripped_count: 4321 }));
    expect(screen.getAllByTestId("report-notice-stripped").length).toBe(2);
  });

  it("0 is the CLEAN state and renders nothing", () => {
    renderNotices(block({ stripped_count: 0 }));
    expect(screen.queryByTestId("report-notice-stripped")).toBeNull();
    expect(screen.queryByTestId("report-stripped-uncounted")).toBeNull();
  });

  it("🔴 null is NEITHER — nobody counted, and it says so in words", () => {
    renderNotices(block({ stripped_count: null }));
    // `null > 0` is `false` in JavaScript, so a `> 0` test alone renders this
    // as the clean state — i.e. as a claim that the sanitiser removed
    // nothing. It is not a claim we can make, and it is not a degraded
    // report either: nothing is known to be wrong with it.
    expect(screen.queryByTestId("report-notice-stripped")).toBeNull();
    const uncounted = screen.getByTestId("report-stripped-uncounted");
    expect(uncounted).toHaveTextContent(STRIPPED_NOT_COUNTED);
    expect(STRIPPED_NOT_COUNTED).toMatch(/not.*claim that nothing was removed/i);
    // Deliberately NOT Channel S. `stripped_count: null` is a property of how
    // this deployment is wired, not of this hypothesis's report, so a warning
    // triangle here would fire on every report on every page of a stack whose
    // detail router was built without the report pair.
    expect(screen.queryByTestId("severity")).toBeNull();
  });

  it("distinguishes null from 0 — the pair differs by one field and by its whole rendering", () => {
    const { unmount } = renderNotices(block({ stripped_count: 0 }));
    expect(screen.queryByTestId("report-stripped-uncounted")).toBeNull();
    unmount();
    renderNotices(block({ stripped_count: null }));
    expect(screen.getByTestId("report-stripped-uncounted")).toBeInTheDocument();
  });
});

describe("strippedCause", () => {
  it("does not read as an inventory of the report's contents", () => {
    // It counts DOMPurify RECORDS — nodes and attributes alike — so
    // "3 items removed" would state something about the report that is not
    // true. `<p onclick="alert(1)">` removes no element and still counts.
    const sentence = strippedCause(3);
    expect(sentence).toMatch(/^content was removed from this report/);
    expect(sentence).toContain("3");
    expect(sentence).not.toMatch(/^3/);
  });
});

// ── unreadable ──────────────────────────────────────────────────────────

describe("🔴 unreadable is degraded, and it is not drift's business", () => {
  it("renders a degraded notice naming the cause", () => {
    renderNotices(block({ drift: null, unreadable: true }));
    const notice = within(screen.getByTestId("report-notice-unreadable")).getByTestId("severity");
    expect(notice).toHaveAttribute("data-severity", "degraded");
    expect(notice).toHaveTextContent(UNREADABLE_CAUSE);
    // A distinctive phrase, and one that carries the fact that a tick DID
    // run — which is the whole difference between this and the empty state.
    expect(UNREADABLE_CAUSE).toMatch(/tick ran[\s\S]*cannot be read/i);
  });

  it("🔴 renders NOTHING for {drift: null, unreadable: false} — the empty state is the panel's", () => {
    renderNotices(block({ drift: null, unreadable: false }));
    expect(screen.queryByTestId("report-notice-unreadable")).toBeNull();
    expect(screen.queryByTestId("severity")).toBeNull();
  });
});

// ── unreadable and tamper coexist ───────────────────────────────────────

describe("🔴 unreadable and tamper do not swallow each other", () => {
  const tamper: Tamper = {
    reason: "cross_hypothesis_write",
    written_by_worker: "",
    written_by_session: "sess_18ab",
    memory_id: "mem_99",
  };

  it("renders BOTH when the block carries both", () => {
    renderNotices(block({ drift: null, unreadable: true, tamper: [tamper] }));
    // The store witnesses tamper BEFORE it reads the body that failed, so
    // this pair is reachable — and a page that showed only one of them is how
    // a forgery the board named went silent here.
    expect(screen.getByTestId("report-notice-unreadable")).toBeInTheDocument();
    const attacked = within(screen.getByTestId("report-notice-tamper")).getByTestId("severity");
    expect(attacked).toHaveAttribute("data-severity", "attacked");
    expect(attacked).toHaveTextContent(/cross-hypothesis write/i);
  });

  it("renders every tamper row, not just the first", () => {
    renderNotices(
      block({
        tamper: [tamper, { ...tamper, reason: "forged_row", memory_id: "mem_100" }],
      }),
    );
    const rows = screen.getAllByTestId("report-notice-tamper");
    expect(rows.length).toBe(2);
    // Counting two is not the same as rendering two DIFFERENT ones: § 2
    // requires the three reasons be distinguished in words, and a component
    // that rendered the first row twice would pass a bare count.
    expect(rows[0]).toHaveTextContent(/cross-hypothesis write/i);
    expect(rows[1]).toHaveTextContent(/forged row/i);
    expect(rows[1]).toHaveTextContent("mem_100");
  });

  it("renders tamper on an otherwise healthy report", () => {
    renderNotices(block({ tamper: [tamper] }));
    expect(screen.getByTestId("report-notice-tamper")).toBeInTheDocument();
    expect(screen.queryByTestId("report-notice-unreadable")).toBeNull();
  });
});

// ── drift ───────────────────────────────────────────────────────────────

describe("drift is degraded and names the slots", () => {
  it("names the orphan slots", () => {
    renderNotices(block({ drift: { orphan_slots: ["stale-slot"], unfilled_slots: [] } }));
    const notice = within(screen.getByTestId("report-notice-drift")).getByTestId("severity");
    expect(notice).toHaveAttribute("data-severity", "degraded");
    expect(notice).toHaveTextContent("stale-slot");
    // The rendered sentence, not just the id inside it.
    expect(notice).toHaveTextContent(/does not match its template/);
  });

  it("names the unfilled slots", () => {
    renderNotices(block({ drift: { orphan_slots: [], unfilled_slots: ["conclusion"] } }));
    // The same assertion list as the orphan case above — that one checked the
    // severity level and the sentence, this one checked only the slot name.
    const notice = within(screen.getByTestId("report-notice-drift")).getByTestId("severity");
    expect(notice).toHaveAttribute("data-severity", "degraded");
    expect(notice).toHaveTextContent("conclusion");
    expect(notice).toHaveTextContent(/does not match its template/);
    expect(notice).toHaveTextContent(/declared by the template but not filled/);
  });

  it("names both kinds, distinguishably, in one sentence", () => {
    renderNotices(
      block({ drift: { orphan_slots: ["gone"], unfilled_slots: ["missing"] } }),
    );
    const text = screen.getByTestId("report-notice-drift").textContent ?? "";
    expect(text).toContain("gone");
    expect(text).toContain("missing");
    // A reader has to be able to tell which is which: an orphan means the
    // writer filled a slot the template no longer declares, an unfilled one
    // means the template declares a slot the writer skipped, and the fixes
    // are opposite.
    expect(text.indexOf("gone")).not.toBe(text.indexOf("missing"));

    // 🔴 The slot names alone are not the sentence. Pinned as literals — not
    // through the builder — because the two LABELS are what tell the reader
    // which name is which, and the whole sentence still contains both names
    // with the labels stripped out.
    const sentence = driftCause({ orphan_slots: ["gone"], unfilled_slots: ["missing"] });
    expect(sentence).toMatch(/does not match its template/);
    expect(sentence).toMatch(/filled but not declared[^;]*gone/);
    expect(sentence).toMatch(/declared by the template but not filled[^;]*missing/);
  });

  it("🔴 renders nothing for a tick that matched the template exactly", () => {
    renderNotices(block({ drift: { orphan_slots: [], unfilled_slots: [] } }));
    // `{orphan_slots: [], unfilled_slots: []}` is a REPORT that matched, and
    // it is a different thing from `drift: null`. Neither is a notice, and
    // for opposite reasons.
    expect(screen.queryByTestId("report-notice-drift")).toBeNull();
  });

  it("renders nothing for drift null", () => {
    renderNotices(block({ drift: null }));
    expect(screen.queryByTestId("report-notice-drift")).toBeNull();
  });

  it("survives a drift object whose arrays are not arrays", () => {
    // The wire types the memory's contents `unknown` and the server re-serves
    // whatever JSON it held; a malformed block must cost a notice, not the
    // page (R140).
    renderNotices(
      block({
        drift: { orphan_slots: "nope", unfilled_slots: null } as unknown as ReportBlock["drift"],
      }),
    );
    expect(screen.queryByTestId("report-notice-drift")).toBeNull();
  });
});

// ── every notice carries its sentence ───────────────────────────────────

describe("every notice carries a non-empty cause", () => {
  it("renders four notices at once, each with words", () => {
    renderNotices(
      block({
        stripped_count: 2,
        drift: { orphan_slots: ["gone"], unfilled_slots: [] },
        unreadable: true,
        tamper: [
          {
            reason: "forged_row",
            written_by_worker: "researcher-9c1b",
            written_by_session: "",
            memory_id: "mem_7f3a",
          },
        ],
      }),
    );
    // `Severity` THROWS in development without a non-empty cause, so a
    // notice built from a missing field takes the page down rather than
    // rendering a bare triangle. Rendering all four at once is what proves
    // none of the four builders can produce an empty one.
    const markers = screen.getAllByTestId("severity");
    expect(markers.length).toBe(4);
    for (const marker of markers) {
      expect((marker.textContent ?? "").trim().length).toBeGreaterThan(10);
    }
  });
});
