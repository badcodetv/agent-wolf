/**
 * The report block's notice strip — everything the page says ABOUT the report,
 * as opposed to the report itself.
 *
 * ## Why one file carries four notices
 *
 * The ticket names this file `ReportDrift`, and drift is its largest job. It
 * carries the other three because they belong in the same place on the page:
 * § 5's layout puts every notice **above** the frame, on the model ground,
 * while `ReportPanel` is `ReportFrameHost`'s child and therefore renders
 * *inside* the fixed-height, internally-scrolling box. A notice inside that
 * box would scroll away from the thing it is about.
 *
 * ## Three of the four exist because a field has more states than it looks
 *
 * 🔴 **`stripped_count` has three.** `> 0` is "content was removed"; `0` is
 * "the sanitiser removed nothing"; **`null` is "nobody counted"** — W22 emits
 * it when no producer is wired into the detail router, because `0` is a real
 * answer and reporting a stripped XSS attempt as clean is the failure the
 * field is shaped to prevent. `null > 0` is `false` in JavaScript, so a naive
 * `> 0` renders the third state as the first — silently.
 *
 * What `null` renders as here is a deliberate decision (§ 2's ladder has no
 * rung for it):
 *
 *   - **not the clean state**, because "nobody counted" is not a claim that
 *     nothing was removed, and letting silence stand for a clean bill of
 *     health is precisely what the tri-state exists to stop;
 *   - **not `Severity level="degraded"`**, because `stripped_count: null` is a
 *     property of how the deployment is WIRED, not of this hypothesis's
 *     report. A router built without the report pair answers `null` for every
 *     hypothesis forever, so a warning triangle would fire on every healthy
 *     report on every page — the exact "every research note reads as a
 *     problem" failure D3 exists to prevent, and the thing that would leave a
 *     real `degraded` with no force;
 *   - **a plain sentence on the provenance ground**, in secondary text with no
 *     semantic colour, saying in words that the count was not taken. Channel P
 *     is where a stable property of the content belongs, and this is one.
 *
 * 🔴 **`unreadable` is the third state of `drift: null`** (R185). `{drift:
 * null, unreadable: false}` is "no tick has run yet" — the panel's empty
 * state, and no notice at all. `{drift: null, unreadable: true}` is "a tick
 * ran and its report cannot be read", which is `degraded` with its own
 * sentence. Rendering the second as the first is what W22's verifier proved
 * can hide a cross-hypothesis attack.
 *
 * 🔴 **Tamper survives `unreadable`**, so a block can carry both at once: the
 * store witnesses anomalies while picking the row, BEFORE it reads the body
 * that failed. Neither branch may swallow the other — that swallowing is
 * exactly how a forgery the board named went silent on this page.
 *
 * ## Drift itself
 *
 * `{orphan_slots: [], unfilled_slots: []}` is a tick that matched the template
 * exactly: healthy, and no notice. Anything in either array is `degraded` with
 * the slot names, and the two kinds are named separately because their fixes
 * are opposite — an orphan means the writer filled a slot the template no
 * longer declares, an unfilled one means the template declares a slot the
 * writer skipped.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Severity from "./trust/Severity.js";
import TamperWarning from "./TamperWarning.js";
import type { ReportBlock } from "../api/types.js";

/**
 * `stripped_count > 0`.
 *
 * 🔴 The SIGN is the contract; the MAGNITUDE is not. The number counts
 * DOMPurify *records* — nodes **and** attributes — so a library upgrade moves
 * it with nothing having changed, and `<p onclick="alert(1)">` removes no
 * element at all while still counting. The sentence is therefore written so
 * the reader takes the fact and not the figure: the count is a parenthetical,
 * never the subject, and never phrased as an inventory of the report.
 */
export function strippedCause(count: number): string {
  return `content was removed from this report by the sanitiser (${count} records) — what you are reading is not everything the writer wrote`;
}

/**
 * `stripped_count === null`. Not a severity: see the file header for why this
 * is Channel P and not Channel S.
 */
export const STRIPPED_NOT_COUNTED =
  "the sanitiser's record was not read for this report — this is not a claim that nothing was removed";

/** `unreadable: true`. Both causes — an unparsable report body and a stored template that no longer validates — reach the reader as the same fact. */
export const UNREADABLE_CAUSE =
  "a tick ran but its report cannot be read — the stored report body or the locked template no longer parses";

/** Slot drift, with the two kinds named separately because their fixes are opposite. */
export function driftCause(drift: { orphan_slots: string[]; unfilled_slots: string[] }): string {
  const parts: string[] = [];
  if (drift.orphan_slots.length > 0) {
    parts.push(`filled but not declared by the template: ${drift.orphan_slots.join(", ")}`);
  }
  if (drift.unfilled_slots.length > 0) {
    parts.push(`declared by the template but not filled: ${drift.unfilled_slots.join(", ")}`);
  }
  return `this report does not match its template — ${parts.join("; ")}`;
}

/** The slot ids, defensively: the server re-serves whatever JSON the memory held. */
function slotIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export interface ReportDriftProps {
  /** `null`/absent must cost the notices and never the page (R140). */
  report?: ReportBlock | null;
}

export default function ReportDrift({ report }: ReportDriftProps) {
  if (report === null || report === undefined) return null;

  const stripped = report.stripped_count;
  const drift =
    report.drift === null || report.drift === undefined
      ? null
      : {
          orphan_slots: slotIds(report.drift.orphan_slots),
          unfilled_slots: slotIds(report.drift.unfilled_slots),
        };
  const drifted = drift !== null && drift.orphan_slots.length + drift.unfilled_slots.length > 0;

  return (
    <Box
      data-testid="report-notices"
      sx={{ display: "flex", flexDirection: "column", gap: 0.5, mb: 0.5 }}
    >
      {/* Tamper first, and independent of everything below it: `attacked` is
          the one alarm this product has, and it must not sit under a
          degraded notice that happens to be about the same row. */}
      {(report.tamper ?? []).map((tamper) => (
        <Box
          key={`${tamper.reason}:${tamper.memory_id}`}
          data-testid="report-notice-tamper"
        >
          <TamperWarning tamper={tamper} />
        </Box>
      ))}

      {report.unreadable === true ? (
        <Box data-testid="report-notice-unreadable">
          <Severity level="degraded" cause={UNREADABLE_CAUSE} />
        </Box>
      ) : null}

      {/* 🔴 `> 0`, `=== null` and `=== 0` are three branches, not two. */}
      {typeof stripped === "number" && stripped > 0 ? (
        <Box data-testid="report-notice-stripped">
          <Severity level="degraded" cause={strippedCause(stripped)} />
        </Box>
      ) : null}
      {stripped === null || stripped === undefined ? (
        <Typography
          data-testid="report-stripped-uncounted"
          // Secondary text, no semantic colour: this is Channel P saying what
          // we do and do not know, not Channel S saying something is wrong.
          sx={{ fontSize: 13, color: "text.secondary" }}
        >
          {STRIPPED_NOT_COUNTED}
        </Typography>
      ) : null}

      {drifted && drift !== null ? (
        <Box data-testid="report-notice-drift">
          <Severity level="degraded" cause={driftCause(drift)} />
        </Box>
      ) : null}
    </Box>
  );
}
