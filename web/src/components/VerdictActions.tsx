/**
 * Confirm / Invalidate — the two buttons that end a hypothesis.
 *
 * 🔴 **They exist in `challenged` and in no other state.** A hypothesis that
 * is still `live` has not been challenged by anything, and a `draft` has no
 * evidence at all; offering a verdict there would be offering a human the
 * chance to score their own thesis on a whim, which is the exact bias this
 * product exists to remove. The server enforces the same rule (W5's state
 * machine refuses the transition), and this is not a second gate — it is the
 * affordance matching the gate.
 *
 * 🔴 **A rationale is required, and whitespace is not a rationale.** Both
 * buttons stay disabled until non-whitespace text is entered. `verdictBody`
 * (`api/src/routes/hypotheses.ts`) is `z.string().trim().min(1)`, so a blank
 * one is a 400 — and a 400 in front of a human who has just decided the fate
 * of a three-month thesis is the worst possible moment to discover it.
 *
 * The rationale is sent TRIMMED, so what the UI shows and what the memory
 * stores are the same bytes: the server trims on its side either way, and a
 * record that differs from what was typed by two invisible spaces is a record
 * nobody can diff.
 *
 * Colour: `confirmed` is the one place § 2b permits `success`, so the Confirm
 * button carries it. `Invalidate` is NEUTRAL, not red — an invalidated thesis
 * is the system working, and red means something wrote what it had no right
 * to write.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Severity from "./trust/Severity.js";
import { ApiError, submitVerdict } from "../api/client.js";
import type { HumanVerdict } from "../api/types.js";

/** The one state in which a human may record a verdict. */
export const VERDICT_STATE = "challenged";

export const RATIONALE_PROMPT = "rationale required — say why, in your own words";

export interface VerdictActionsProps {
  hypothesisId: string;
  /** The lifecycle state from the trusted `hypothesis` memory. */
  status: string | null | undefined;
  /** Called after a successful verdict so the page can re-read. */
  onDone?: () => void;
}

export default function VerdictActions({ hypothesisId, status, onDone }: VerdictActionsProps) {
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (status !== VERDICT_STATE) return null;

  const ready = rationale.trim() !== "";

  async function submit(verdict: HumanVerdict): Promise<void> {
    // Belt to the disabled attribute's braces: a keyboard or a test can fire
    // a click on a disabled-looking control, and the empty rationale must not
    // reach the wire.
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await submitVerdict(hypothesisId, verdict, rationale.trim());
      setRationale("");
      onDone?.();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "the verdict could not be recorded");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box data-testid="verdict-actions" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <TextField
        data-testid="verdict-rationale"
        label={RATIONALE_PROMPT}
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        multiline
        minRows={2}
        size="small"
        fullWidth
        slotProps={{ htmlInput: { "aria-label": "verdict rationale" } }}
      />
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <Button
          data-testid="verdict-confirm"
          size="small"
          variant="contained"
          color="success"
          disabled={!ready || busy}
          onClick={() => void submit("confirmed")}
        >
          Confirm
        </Button>
        <Button
          data-testid="verdict-invalidate"
          size="small"
          variant="outlined"
          // Neutral, not red. See the file header.
          color="inherit"
          disabled={!ready || busy}
          onClick={() => void submit("invalidated")}
        >
          Invalidate
        </Button>
        {ready ? null : (
          <Typography data-testid="verdict-blocked" sx={{ fontSize: 12, color: "text.secondary" }}>
            {RATIONALE_PROMPT}
          </Typography>
        )}
      </Box>
      {failure === null ? null : (
        <Severity level="degraded" cause={`the verdict was not recorded — ${failure}`} />
      )}
    </Box>
  );
}
