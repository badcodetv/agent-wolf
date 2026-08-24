/**
 * The lifecycle chip. All SIX states render a distinct, labelled chip, and an
 * unknown value renders VERBATIM — never throwing, never falling back to
 * `draft`. A chip that quietly said "draft" for a value it did not recognise
 * would be the UI inventing state, which is the one thing this product must
 * never do.
 *
 * The chip appears on the board AND on `/archive` (§ 3), which is why all six
 * states live here even though three of them never appear on the board.
 *
 * ## Colour discipline (§ 2b "The palette")
 *
 * Colour is scarce and mostly spent on severity, so a lifecycle chip may only
 * be neutral, the accent, or `success`:
 *
 *   - `challenged` is the **accent**, because a challenge is a tripped
 *     condition and § 2b assigns `tripped` to the accent. It is emphatically
 *     NOT `error` red: red means "something wrote what it had no right to
 *     write" and nothing else in this product.
 *   - `confirmed` is `success` — § 2b permits that colour for "a `confirmed`
 *     verdict only".
 *   - `invalidated` is **neutral**, not red. An invalidated thesis is the
 *     system working: the evidence went against it and Wolf said so. Colouring
 *     it as an attack would blunt the one alarm that matters.
 *
 * Every state is therefore distinguished by more than colour — the label is
 * always present, and the border style, weight and opacity differ too.
 */

import Chip from "@mui/material/Chip";
import type { HypothesisStatus } from "../api/types.js";
import { isHypothesisStatus } from "../api/types.js";

/** The visual spec for one state. Exported so a test can assert the six are pairwise distinct. */
export interface StatusChipSpec {
  /** MUI `Chip` variant. */
  variant: "filled" | "outlined";
  /** MUI `Chip` colour — constrained to the three § 2b permits here. */
  color: "default" | "primary" | "success";
  /** Border style: `dashed` reads as "not locked yet" without spending a colour. */
  borderStyle: "solid" | "dashed";
  fontWeight: number;
  opacity: number;
  /** A struck-through label says "this line of enquiry is closed" in the glyph channel. */
  strikeThrough: boolean;
}

export const STATUS_CHIP_SPECS: Record<HypothesisStatus, StatusChipSpec> = {
  // Nothing is locked yet: dashed, quiet.
  draft: { variant: "outlined", color: "default", borderStyle: "dashed", fontWeight: 400, opacity: 1, strikeThrough: false },
  // Running. Solid ground, no colour spent.
  live: { variant: "filled", color: "default", borderStyle: "solid", fontWeight: 500, opacity: 1, strikeThrough: false },
  // A condition tripped — the accent, exactly as `tripped` is in § 2b.
  challenged: { variant: "filled", color: "primary", borderStyle: "solid", fontWeight: 700, opacity: 1, strikeThrough: false },
  // The one place `success` is permitted.
  confirmed: { variant: "filled", color: "success", borderStyle: "solid", fontWeight: 700, opacity: 1, strikeThrough: false },
  // Closed, and not an alarm: neutral, struck through.
  invalidated: { variant: "outlined", color: "default", borderStyle: "solid", fontWeight: 500, opacity: 1, strikeThrough: true },
  // Retired by a human. Lowest emphasis on the page.
  archived: { variant: "outlined", color: "default", borderStyle: "solid", fontWeight: 400, opacity: 0.6, strikeThrough: false },
};

/**
 * The spec for a value the six-state table does not contain. Deliberately its
 * own object — a test asserts an unknown value gets THIS and not `draft`'s.
 */
export const UNKNOWN_STATUS_SPEC: StatusChipSpec = {
  variant: "outlined",
  color: "default",
  borderStyle: "dashed",
  fontWeight: 700,
  opacity: 1,
  strikeThrough: false,
};

/** Shown when no trusted state row survives at all. An anomaly is rendered, never dropped. */
export const NO_STATE_LABEL = "no state row";

export function chipSpecFor(status: string | null | undefined): StatusChipSpec {
  return isHypothesisStatus(status) ? STATUS_CHIP_SPECS[status] : UNKNOWN_STATUS_SPEC;
}

export interface StatusChipProps {
  status: string | null | undefined;
}

export default function StatusChip({ status }: StatusChipProps) {
  const known = isHypothesisStatus(status);
  const spec = chipSpecFor(status);
  // The label is the server's own string. Uppercasing is a CSS transform, not
  // a JS one, so `textContent` stays verbatim and a test can prove it.
  const label = typeof status === "string" && status !== "" ? status : NO_STATE_LABEL;

  return (
    <Chip
      data-testid="status-chip"
      data-status={typeof status === "string" ? status : "null"}
      data-status-known={known ? "true" : "false"}
      label={label}
      size="small"
      variant={spec.variant}
      color={spec.color}
      sx={{
        borderStyle: spec.borderStyle,
        // An outlined MUI chip carries a border already; a filled one does
        // not, so give it one of its own colour so `borderStyle` is never a
        // no-op affordance.
        borderWidth: 1,
        ...(spec.variant === "filled" ? { borderColor: "transparent" } : {}),
        opacity: spec.opacity,
        letterSpacing: "0.04em",
        "& .MuiChip-label": {
          textTransform: "uppercase",
          fontWeight: spec.fontWeight,
          fontSize: 11,
          ...(spec.strikeThrough ? { textDecoration: "line-through" } : {}),
        },
      }}
    />
  );
}
