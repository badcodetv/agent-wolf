/**
 * NEXT STEP — the one thing to do, in words, at the top of the detail page.
 *
 * ## Why this exists
 *
 * 🔴 A `draft` detail page used to open on a title, a disabled GO LIVE, two
 * sentences of refusal, eight empty sections and a 480–900px empty report box.
 * Everything on it was *true*; none of it said what to do, and the one control
 * that worked — the conversation rail — was the only thing not labelled as the
 * next action. A first-time reader's report was "I'm not sure what to do", and
 * they were right: the page described state and never intent.
 *
 * ## It is NOT a gate
 *
 * 🔴 **This component decides nothing.** It reads the same two server-computed
 * booleans `GoLiveButton` reads — `spec_validation.valid` and
 * `report.has_template` — and turns them into a sentence. It must never
 * disagree with that button, which is why it derives from the same fields with
 * the same `=== false` / `=== true` discipline rather than re-deriving
 * readiness from the spec, and why it renders no control of its own except a
 * button linking to a screen that already exists.
 *
 * `undefined` is not `false` here either. An absent field means "the server
 * did not say", and the wording falls back to the interview step — the step
 * that is always safe to be on — rather than claiming a blocker the payload
 * never carried.
 *
 * ## The finish line is a button (2026-09-13)
 *
 * A first real interview ended with a valid spec and nothing on the page
 * saying so: the detail was fetched once, and the step it would have shown was
 * a quiet link. The page now polls while in draft (`HypothesisDetail.tsx`),
 * this component says the interview is working while there is no valid spec,
 * and the moment one lands the step is a primary **Review and go live**
 * button — the words the interviewer prompt tells the user to look for
 * (`prompts/interviewer.md` § "The closing message"; a test pins the pair).
 */

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import type { SpecValidation } from "../api/types.js";

export interface NextStepProps {
  hypothesisId: string;
  /** The lifecycle state from the trusted `hypothesis` memory. */
  status: string | null | undefined;
  /** The server's verdict on the newest spec candidate. */
  specValidation?: SpecValidation;
  /** `report.has_template` from the detail payload. */
  templateAccepted?: boolean;
}

/** The primary button's label. `prompts/interviewer.md` quotes it verbatim. */
export const REVIEW_AND_GO_LIVE = "Review and go live";

interface Step {
  /** What to do, in one sentence. */
  say: string;
  /** Where, when there is a screen for it. */
  goTo?: { label: string; to: string };
  /** Work is happening elsewhere (the interview); show that it is. */
  working?: boolean;
}

/**
 * The step, derived from status and the two booleans. Exported so a test can
 * assert the mapping without rendering — the mapping is the whole component.
 */
export function nextStepFor(
  hypothesisId: string,
  status: string | null | undefined,
  specValid: boolean | undefined,
  templateAccepted: boolean | undefined,
): Step | null {
  switch (status) {
    case "draft": {
      // Both halves satisfied: the same condition that enables Go Live.
      if (specValid === true && templateAccepted === true) {
        return {
          say: "The spec validates and a report template has been accepted. Review it once more and take this hypothesis live — that locks the scoreboard and starts the daily researcher.",
          goTo: { label: REVIEW_AND_GO_LIVE, to: `/hypotheses/${hypothesisId}/golive` },
        };
      }
      // A valid spec is the finish line of the interview: the interviewer
      // deposits the report candidate BEFORE the spec, so by now there is a
      // template to review on the same screen. One button, one label.
      if (specValid === true) {
        return {
          say: "Your hypothesis is ready for review. Check the scoreboard and the report, accept the report template, then take it live.",
          goTo: { label: REVIEW_AND_GO_LIVE, to: `/hypotheses/${hypothesisId}/golive` },
        };
      }
      // Still interviewing. This used to render NOTHING (2026-09-07), on the
      // grounds that the conversation beside it was visibly running. But a
      // silent page with a long tool-call loop beside it read as stuck, and
      // nothing told the reader the page would change by itself when the
      // interview finished. Not a refusal — no blocker is claimed.
      return {
        say: "The interview is shaping your hypothesis — answer in the conversation panel. This page updates by itself when it is ready for review.",
        working: true,
      };
    }
    case "live":
      return {
        say: "Live. The researcher runs on its schedule, fetches the numbers and files evidence. Nothing needs you until a condition trips.",
      };
    case "challenged":
      return {
        say: "A condition tripped. Read the case below, then confirm or invalidate the thesis — that decision is yours, not the model's.",
      };
    // Terminal. There is no next step, and inventing one would be worse than
    // silence: `confirmed`, `invalidated` and `archived` are all finished.
    default:
      return null;
  }
}

export default function NextStep({
  hypothesisId,
  status,
  specValidation,
  templateAccepted,
}: NextStepProps) {
  const step = nextStepFor(hypothesisId, status, specValidation?.valid, templateAccepted);
  if (step === null) return null;

  return (
    <Box
      data-testid="next-step"
      data-status={status ?? ""}
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderLeft: `3px solid ${theme.palette.primary.main}`,
        borderRadius: 1,
        px: 1.5,
        py: 1.25,
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
      })}
    >
      <Typography
        sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary" }}
      >
        NEXT STEP
      </Typography>
      <Typography data-testid="next-step-say" sx={{ fontSize: 13 }}>
        {step.say}
      </Typography>
      {step.working === true ? (
        <LinearProgress data-testid="next-step-working" sx={{ height: 2, borderRadius: 1 }} />
      ) : null}
      {step.goTo === undefined ? null : (
        <Box>
          <Button
            data-testid="next-step-link"
            component={RouterLink}
            to={step.goTo.to}
            variant="contained"
            size="small"
          >
            {step.goTo.label}
          </Button>
        </Box>
      )}
    </Box>
  );
}
