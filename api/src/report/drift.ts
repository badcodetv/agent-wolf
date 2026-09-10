/**
 * Drift detection: comparing a locked template's declared slots against one
 * tick's filled slots.
 *
 * design/2026-08-20-agent-wolf.md § W20 ("Drift detection") is the ticket.
 * `detectDrift` is PURE — it takes the two slot sets already extracted by
 * earlier tickets (W16's `parseTemplate().slotIds`, W15/kinds.ts's
 * `parseReportContent().slots`) and does no I/O, no Bob read, no route
 * work. W22's board integration is the caller: it reads the template and the
 * latest `kind=report` through the store, parses both, and passes the two
 * slot shapes in here.
 *
 * Two directions, both reported, neither dropped:
 *
 *  - **Orphan**: a slot id the tick FILLED but the template does not
 *    DECLARE. The template was relocked (a slot renamed or removed) after
 *    the researcher's prompt was written, or the model invented a key.
 *  - **Unfilled**: a slot the template DECLARES but the tick left EMPTY. The
 *    researcher had nothing to say, or the prompt has not been updated to
 *    cover a slot a template amendment just added.
 *
 * ⚠️ **An empty tick is not drift.** "No `report` memory exists yet" (the
 * first tick has not run, or the hypothesis has no researcher configured
 * yet) is the EMPTY STATE, not a report whose every slot is unfilled. The
 * two are different facts a human needs told apart — one says "nothing has
 * happened", the other says "something happened and it did not match the
 * template" — so this module represents "no report" as `null` and "a report
 * exists" as a `SlotDrift` object, even when that object's `unfilledSlotIds`
 * happens to equal every slot in the template. Collapsing the two into the
 * same empty-looking shape is the mistake this file exists to prevent.
 */

/**
 * One hypothesis's drift for one tick. Both arrays are always present, even
 * when empty — an empty array means "none of that kind", not "not computed".
 */
export interface SlotDrift {
  /** Slot ids the tick filled that the template does not declare, in the order the tick's report listed them. */
  orphanSlotIds: string[];
  /** Slot ids the template declares that the tick left empty, in document order (matching `slotIds`). */
  unfilledSlotIds: string[];
}

/**
 * `null` means no `kind=report` memory exists for this hypothesis at all —
 * the empty state, not drift. A non-null result means a report was found and
 * compared, however many slots either array holds (both may be empty, which
 * means the tick matched the template exactly).
 */
export type DriftResult = SlotDrift | null;

/**
 * Compares a template's declared slot ids (W16's `ParsedTemplate.slotIds`,
 * in document order) against one tick's filled slot ids (the keys of a
 * parsed `kind=report` memory's body, W15/kinds.ts's `ParsedReport.slots`).
 *
 * `reportSlots` is `null` when no `kind=report` memory exists yet for this
 * hypothesis — the caller (W22) passes `null` exactly when its
 * `readLatestReport` call returned `report: null`, never for a report that
 * exists with an empty slot map. Passing `{}` (a report that exists but
 * filled nothing) is a real, comparable tick and returns every template slot
 * as unfilled — that is what distinguishes "nothing has happened yet" from
 * "a report ran and matched nothing".
 */
export function detectDrift(
  templateSlotIds: readonly string[],
  reportSlots: Readonly<Record<string, string>> | null,
): DriftResult {
  if (reportSlots === null) return null;

  const declared = new Set(templateSlotIds);
  const filledIds = Object.keys(reportSlots);
  const filled = new Set(filledIds);

  const orphanSlotIds = filledIds.filter((id) => !declared.has(id));
  const unfilledSlotIds = templateSlotIds.filter((id) => !filled.has(id));

  return { orphanSlotIds, unfilledSlotIds };
}

/**
 * The single per-hypothesis indicator the board and detail page render: true
 * when there is a report and it has any orphan or unfilled slot, false both
 * when there is no report (the empty state) and when a report matched the
 * template exactly. Callers that need to tell "no report" apart from "clean
 * report" must inspect the `DriftResult` itself — this collapses that
 * distinction on purpose, because the UI's drift badge is a single boolean
 * and "nothing to warn about" is the correct answer in both of those cases.
 */
export function hasDrift(result: DriftResult): boolean {
  return result !== null && (result.orphanSlotIds.length > 0 || result.unfilledSlotIds.length > 0);
}
