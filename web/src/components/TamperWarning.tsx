/**
 * The tamper alert. It is **`Severity level="attacked"`** and nothing else —
 * `design/2026-08-24-agent-wolf-ui.md` § 7 says so in as many words
 * ("`TamperWarning` = full-width `Alert severity="error"` … this **is**
 * `Severity level="attacked"`"). A second severity treatment anywhere in the
 * tree would blunt the one alarm this product has, which is why W28 authored
 * the trust components before any page ticket ran.
 *
 * All this file adds is the SENTENCE. § 2 requires the three reasons be
 * distinguished **in words**, not by an icon and not by a reason slug the
 * reader has to decode:
 *
 *   forged_row              someone wrote a row claiming Wolf's own authority
 *   hostile_retraction      someone tried to withdraw a row Wolf itself wrote
 *   cross_hypothesis_write  someone wrote against a hypothesis that is not theirs
 *
 * The writer is `written_by_worker || written_by_session` — the pinned
 * `Tamper` shape always carries BOTH keys and leaves the unused one as `""`,
 * so this is a fallback between two present strings, never an optional-field
 * check.
 */

import Severity from "./trust/Severity.js";
import { UNKNOWN_WRITER } from "./trust/Provenance.js";
import type { Tamper } from "../api/types.js";

/** The writer, from the two always-present provenance fields. */
export function tamperWriter(tamper: Tamper): string {
  return tamper.written_by_worker.trim() || tamper.written_by_session.trim() || UNKNOWN_WRITER;
}

/**
 * The three reasons, in words. Each names WHAT WAS DONE, so the sentence is
 * still meaningful pasted into a chat with no UI around it.
 *
 * An unrecognised reason falls through to the slug itself rather than to a
 * generic sentence: a tamper kind Wolf does not know about is the last thing
 * that should read as routine.
 */
export function tamperSentence(tamper: Tamper): string {
  const writer = tamperWriter(tamper);
  const memory = tamper.memory_id;
  switch (tamper.reason) {
    case "forged_row":
      return `forged row — ${writer} wrote memory ${memory} claiming the authority Wolf itself writes with`;
    case "hostile_retraction":
      return `hostile retraction — ${writer} tried to withdraw a row Wolf wrote, through memory ${memory}`;
    case "cross_hypothesis_write":
      return `cross-hypothesis write — ${writer} wrote memory ${memory} against a hypothesis it does not belong to`;
    default:
      return `unrecognised tamper "${String(tamper.reason)}" — ${writer} wrote memory ${memory}`;
  }
}

export interface TamperWarningProps {
  tamper: Tamper;
}

export default function TamperWarning({ tamper }: TamperWarningProps) {
  return <Severity level="attacked" cause={tamperSentence(tamper)} />;
}
