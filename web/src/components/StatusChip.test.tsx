import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { lightTheme } from "../theme.js";
import { HYPOTHESIS_STATES } from "../api/types.js";
import StatusChip, { STATUS_CHIP_SPECS, UNKNOWN_STATUS_SPEC, chipSpecFor } from "./StatusChip.js";

function renderChip(status: string | null) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <StatusChip status={status} />
    </ThemeProvider>,
  );
}

describe("StatusChip", () => {
  // The six-state table test W13 names. Each state must render a chip that is
  // both LABELLED (its own word) and DISTINCT (a different visual spec) —
  // distinct by label alone would let two states share every other affordance,
  // and distinct by colour alone would fail § 2b's "never colour-alone" floor.
  it.each(HYPOTHESIS_STATES)("renders a labelled chip for %s", (status) => {
    const { unmount } = renderChip(status);
    const chip = screen.getByTestId("status-chip");
    // The label is the status string itself — uppercasing is CSS, never JS, so
    // the DOM text stays exactly what the server said.
    expect(chip).toHaveTextContent(status);
    expect(chip).toHaveAttribute("data-status", status);
    unmount();
  });

  it("gives all six states pairwise-distinct visual specs", () => {
    const seen = HYPOTHESIS_STATES.map((status) => JSON.stringify(STATUS_CHIP_SPECS[status]));
    expect(new Set(seen).size).toBe(HYPOTHESIS_STATES.length);
  });

  it("spends no colour outside the palette § 2b permits a lifecycle chip", () => {
    // `error` red means exactly one thing in this product (severity
    // `attacked`), and `warning` belongs to `indeterminate`/`degraded`. A
    // lifecycle chip may only be neutral, the accent (a trip is the accent),
    // or `success` for a CONFIRMED verdict.
    for (const status of HYPOTHESIS_STATES) {
      expect(["default", "primary", "success"]).toContain(STATUS_CHIP_SPECS[status].color);
    }
    expect(STATUS_CHIP_SPECS.confirmed.color).toBe("success");
    expect(STATUS_CHIP_SPECS.challenged.color).toBe("primary");
    expect(STATUS_CHIP_SPECS.invalidated.color).toBe("default");
  });

  it("renders an UNKNOWN status verbatim rather than throwing or falling back to draft", () => {
    renderChip("banana");
    const chip = screen.getByTestId("status-chip");
    expect(chip).toHaveTextContent("banana");
    expect(chip).not.toHaveTextContent("draft");
    expect(chip).toHaveAttribute("data-status", "banana");
    expect(chip).toHaveAttribute("data-status-known", "false");
    expect(chipSpecFor("banana")).toBe(UNKNOWN_STATUS_SPEC);
  });

  it("renders a null status as an explicit anomaly, not as draft and not as nothing", () => {
    renderChip(null);
    const chip = screen.getByTestId("status-chip");
    expect(chip).toHaveTextContent(/no state row/i);
    expect(chip).not.toHaveTextContent("draft");
    expect(chip).toHaveAttribute("data-status-known", "false");
  });
});
