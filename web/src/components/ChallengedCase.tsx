/**
 * THE CASE — what a `challenged` hypothesis shows, and no other state does.
 *
 * UI design § 5, "A condition just tripped": the reason, then the tripped
 * condition's row in full (metric, statistic, value, threshold, window,
 * observation count), then the three most recent research notes on the `model`
 * ground **under a heading naming them as the agent's untrusted evidence, not
 * a recommendation**.
 *
 * 🔴 There is no separately generated "the agent's case" artefact and this
 * component must not invent one. No ticket produces one, and nothing wakes the
 * researcher when a condition trips — so what a human reads here is the last
 * three ordinary daily notes, which is exactly why the heading has to say so.
 * A heading reading "the agent's argument" would turn three days of routine
 * prose into a recommendation nobody wrote.
 *
 * ## The challenge reason, and why it may be missing
 *
 * W10's poller records the reason as the state memory's `rationale`
 * (`api/src/hypothesis/poller.ts`: `condition_tripped` | `horizon_reached`),
 * and `GET /api/hypotheses/:id` does **not** carry it — `detailRow()` projects
 * ten fields and the rationale is not one of them.
 *
 * The two ways to fill that hole were both refused:
 *
 *   - **deriving it here** ("any tripped condition ⇒ `condition_tripped`")
 *     would put the reason in two places, and the browser's copy would be
 *     wrong for a hypothesis challenged at its horizon whose conditions later
 *     tripped;
 *   - **guessing a default** would print a reason nobody recorded.
 *
 * So the field is declared optional on `HypothesisDetail`, rendered verbatim
 * when it arrives, and its absence is stated plainly. See the ticket report.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ConditionTable from "./ConditionTable.js";
import Provenance from "./trust/Provenance.js";
import { formatUtcDateTime } from "../format.js";
import type { ConditionResult, EvaluationResult, EvidenceRow } from "../api/types.js";

/** The one state that has a case to answer. */
export const CHALLENGED = "challenged";

/** How many research notes § 5 puts under the case. */
export const RESEARCH_NOTE_COUNT = 3;

/**
 * 🔴 The heading § 5 pins. It says three things on purpose: whose they are,
 * that they are untrusted, and that they are not a recommendation.
 */
export const EVIDENCE_HEADING =
  "the agent's untrusted evidence — not a recommendation";

/** W10's two reasons, in words. The token is always rendered too. */
export const CHALLENGE_REASON_GLOSS: Record<string, string> = {
  condition_tripped: "a condition tripped",
  horizon_reached: "the horizon elapsed",
};

/** Stated rather than guessed. See the file header. */
export const REASON_NOT_SERVED =
  "the challenge reason is not carried by this payload — it is recorded on the hypothesis memory";

export function challengeReasonText(reason: string | null | undefined): string {
  const token = typeof reason === "string" ? reason.trim() : "";
  if (token === "") return REASON_NOT_SERVED;
  const gloss = CHALLENGE_REASON_GLOSS[token];
  return gloss === undefined ? `challenged — ${token}` : `challenged — ${token}: ${gloss}`;
}

/** The tripped rows of an evaluation, tolerating a malformed `conditions` block. */
export function trippedConditions(evaluation: EvaluationResult | null | undefined): ConditionResult[] {
  if (evaluation === null || evaluation === undefined) return [];
  const conditions = Array.isArray(evaluation.conditions) ? evaluation.conditions : [];
  return conditions.filter((c) => c.state === "tripped");
}

/** The `RESEARCH_NOTE_COUNT` newest notes. Sorted here, not trusted to arrive sorted. */
export function recentNotes(notes: EvidenceRow[] | undefined): EvidenceRow[] {
  const rows = Array.isArray(notes) ? [...notes] : [];
  rows.sort((a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0));
  return rows.slice(0, RESEARCH_NOTE_COUNT);
}

export interface ChallengedCaseProps {
  status: string | null | undefined;
  challengeReason?: string | null;
  evaluation?: EvaluationResult | null;
  notes?: EvidenceRow[];
  /** The condition's statistic, from the spec. */
  statFor?: (conditionId: string) => string | undefined;
}

export default function ChallengedCase({
  status,
  challengeReason,
  evaluation,
  notes,
  statFor,
}: ChallengedCaseProps) {
  if (status !== CHALLENGED) return null;

  const tripped = trippedConditions(evaluation);
  const recent = recentNotes(notes);

  return (
    <Box data-testid="challenged-case" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em" }}>
        THE CASE
      </Typography>
      <Typography data-testid="challenge-reason" variant="mono" sx={{ fontSize: 13 }}>
        {challengeReasonText(challengeReason)}
      </Typography>

      <ConditionTable
        conditions={tripped}
        {...(statFor === undefined ? {} : { statFor })}
        testId="case-conditions"
        emptyMessage="no condition is tripped — this hypothesis was challenged at its horizon"
      />

      <Typography
        data-testid="case-evidence-heading"
        sx={{ fontSize: 12, fontWeight: 600, mt: 1 }}
      >
        {EVIDENCE_HEADING}
      </Typography>
      {recent.length === 0 ? (
        <Typography data-testid="case-evidence-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
          the researcher has written no notes on this hypothesis
        </Typography>
      ) : (
        recent.map((note) => (
          <Box key={note.id} data-testid="case-note" data-note-id={note.id} data-trust="untrusted">
            <Provenance
              kind="model"
              worker={note.created_by_worker}
              session={note.created_by_session}
              atMs={note.created_at_ms}
            >
              <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  untrusted
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  {formatUtcDateTime(note.created_at_ms)}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{note.snippet}</Typography>
            </Provenance>
          </Box>
        ))
      )}
    </Box>
  );
}
