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
 * link to a screen that already exists.
 *
 * `undefined` is not `false` here either. An absent field means "the server
 * did not say", and the wording falls back to the interview step — the step
 * that is always safe to be on — rather than claiming a blocker the payload
 * never carried.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import Link from "@mui/material/Link";
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

interface Step {
  /** What to do, in one sentence. */
  say: string;
  /** Where, when there is a screen for it. */
  goTo?: { label: string; to: string };
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
          goTo: { label: "Review and go live", to: `/hypotheses/${hypothesisId}/golive` },
        };
      }
      if (specValid === true) {
        return {
          say: "The spec validates. Next, accept a report template — the layout the daily researcher writes its findings into. Nothing goes live without one.",
          goTo: { label: "Review the template", to: `/hypotheses/${hypothesisId}/golive` },
        };
      }
      // 🔴 NOTHING. Removed 2026-09-07, and deliberately.
      //
      // This used to say "talk to the interviewer in the Conversation panel",
      // which was the right advice for about a day — while the thesis was a
      // field nothing read and the interview genuinely had to be started by
      // hand. Now the create route seeds the interview with the thesis and
      // waits for the turn to be in flight before answering, so by the time
      // this page renders the interviewer is already replying. A banner
      // telling the reader to start a conversation that is visibly underway
      // beside it is noise at the top of the page, and noise in the one slot
      // reserved for the thing that actually needs doing.
      //
      // The next real step is the template, and it appears the moment the spec
      // validates. Until then the conversation IS the next step and it is
      // already on screen.
      return null;
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
      {step.goTo === undefined ? null : (
        <Link
          data-testid="next-step-link"
          component={RouterLink}
          to={step.goTo.to}
          underline="hover"
          sx={{ fontSize: 13, fontWeight: 600 }}
        >
          {step.goTo.label} →
        </Link>
      )}
    </Box>
  );
}
