import { describe, expect, it } from "vitest";
import { detectDrift, hasDrift, type SlotDrift } from "./drift.js";

// design/2026-08-20-agent-wolf.md § W20 ("Drift detection"), graded by its
// acceptance criteria. Every `it` name begins with `drift_` so a later
// `-t drift_` filter can address the whole file.

describe("detectDrift", () => {
  it("drift_orphan_slot_reported_when_tick_fills_undeclared_id", () => {
    const result = detectDrift(["headline-chart"], {
      "headline-chart": "<p>ok</p>",
      "surprise-slot": "<p>not in the template</p>",
    });
    expect(result).not.toBeNull();
    expect(result!.orphanSlotIds).toEqual(["surprise-slot"]);
    expect(result!.unfilledSlotIds).toEqual([]);
  });

  it("drift_unfilled_slot_reported_when_template_declares_and_tick_omits", () => {
    const result = detectDrift(["headline-chart", "risk-table"], {
      "headline-chart": "<p>ok</p>",
    });
    expect(result).not.toBeNull();
    expect(result!.orphanSlotIds).toEqual([]);
    expect(result!.unfilledSlotIds).toEqual(["risk-table"]);
  });

  it("drift_both_directions_at_once_neither_dropped", () => {
    // The template declares `a` and `b`. The tick filled `a` and `c` — `b`
    // is unfilled, `c` is orphaned. Both must appear; neither may be
    // silently absorbed into the other.
    const result = detectDrift(["a", "b"], { a: "<p>a</p>", c: "<p>c</p>" });
    expect(result).toEqual<SlotDrift>({ orphanSlotIds: ["c"], unfilledSlotIds: ["b"] });
  });

  it("drift_no_drift_when_filled_set_exactly_matches_declared_set", () => {
    const result = detectDrift(["a", "b"], { a: "<p>a</p>", b: "<p>b</p>" });
    expect(result).toEqual<SlotDrift>({ orphanSlotIds: [], unfilledSlotIds: [] });
    expect(hasDrift(result)).toBe(false);
  });

  it("drift_unfilled_slot_ids_preserve_template_document_order", () => {
    // slotIds arrives in document order (W16's contract); the unfilled
    // subset must preserve that order, not sort or reverse it.
    const result = detectDrift(["c", "a", "b"], {});
    expect(result!.unfilledSlotIds).toEqual(["c", "a", "b"]);
  });

  it("drift_orphan_slot_ids_preserve_report_key_order", () => {
    const result = detectDrift([], { z: "<p/>", y: "<p/>", x: "<p/>" });
    expect(result!.orphanSlotIds).toEqual(["z", "y", "x"]);
  });

  it("drift_empty_tick_is_not_drift_reportSlots_null_returns_null", () => {
    // No `kind=report` memory at all — the caller passes null, not `{}`.
    const result = detectDrift(["a", "b"], null);
    expect(result).toBeNull();
  });

  it("drift_empty_state_and_all_unfilled_report_are_distinguishable_shapes", () => {
    // The criterion this test exists to pin: "no report" (null) must not
    // collapse into the same shape as "a report exists and every declared
    // slot is unfilled" (a SlotDrift object with unfilledSlotIds === every
    // template slot and orphanSlotIds === []).
    const noReportAtAll = detectDrift(["a", "b"], null);
    const reportExistsButFilledNothing = detectDrift(["a", "b"], {});

    expect(noReportAtAll).toBeNull();
    expect(reportExistsButFilledNothing).not.toBeNull();
    expect(reportExistsButFilledNothing).toEqual<SlotDrift>({
      orphanSlotIds: [],
      unfilledSlotIds: ["a", "b"],
    });

    // Explicitly: the two are not `.toEqual` to one another.
    expect(noReportAtAll).not.toEqual(reportExistsButFilledNothing);

    // And the per-hypothesis indicator differs too: the empty state renders
    // as "no drift, nothing to show" while the empty-slots report renders
    // as "drift, every declared slot missing" — hasDrift() alone would
    // conflate them, which is exactly why the caller must branch on the
    // DriftResult (null vs non-null) before ever calling hasDrift().
    expect(reportExistsButFilledNothing!.unfilledSlotIds.length).toBeGreaterThan(0);
  });

  it("drift_no_template_slots_and_no_report_fills_is_clean_not_drift", () => {
    // Degenerate but legal: a template that declares no slots (all
    // fallback/static content) and a report whose tick filled nothing.
    // This is a real, comparable tick (report exists) with zero drift —
    // distinct from the null "no report at all" case above.
    const result = detectDrift([], {});
    expect(result).toEqual<SlotDrift>({ orphanSlotIds: [], unfilledSlotIds: [] });
    expect(hasDrift(result)).toBe(false);
  });
});

describe("hasDrift", () => {
  it("drift_hasDrift_false_for_null_the_empty_state", () => {
    expect(hasDrift(null)).toBe(false);
  });

  it("drift_hasDrift_true_when_only_orphan_present", () => {
    expect(hasDrift({ orphanSlotIds: ["x"], unfilledSlotIds: [] })).toBe(true);
  });

  it("drift_hasDrift_true_when_only_unfilled_present", () => {
    expect(hasDrift({ orphanSlotIds: [], unfilledSlotIds: ["x"] })).toBe(true);
  });

  it("drift_hasDrift_false_when_both_empty", () => {
    expect(hasDrift({ orphanSlotIds: [], unfilledSlotIds: [] })).toBe(false);
  });
});
