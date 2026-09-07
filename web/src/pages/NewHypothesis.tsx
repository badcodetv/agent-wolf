/**
 * `/new` — starting a hypothesis: a title, and the thesis itself.
 *
 * ## The thesis is the conversation's first message, not a description
 *
 * 🔴 **It used to be optional and labelled "Thesis (optional)", and that was
 * the single most confusing thing in the product.** A user who typed their
 * whole thesis into it landed on a detail page with eight empty sections and
 * an interviewer in the rail asking them to state a thesis — which they had
 * just done, into a field nothing read. Fixed on both sides on 2026-09-07: the
 * server now requires it (`createBody`) and sends it into the new session as
 * the interview's first message, and this form says so before you type.
 *
 * ## Why it is slow, and why that must be visible
 *
 * `POST /api/hypotheses` is slow BY CONSTRUCTION and the first create of a
 * session image is the slowest of all: Orange's session create is
 * asynchronous, so the API polls the by-name route until the `hyp-<id>`
 * session leaves `creating` before it writes anything — and on a cold host
 * that wait includes pulling the session image from the registry. Nothing is
 * written to memory until the session is real, which is why a failure leaves
 * no half-made hypothesis behind, and why this form must SHOW that it is
 * working. A disabled button with changed text is not enough; a form that
 * looks frozen for ninety seconds reads as a bug and gets clicked again.
 *
 * 🔴 **Orange's create error is surfaced VERBATIM.** "host port pool is
 * exhausted" is operational and actionable — it tells the reader to delete a
 * finished session, and it clears on its own — and flattening it into "could
 * not create hypothesis" throws away the only useful part. That rule is in the
 * plan's § "Shared error taxonomy" and it is the whole reason `ApiError`
 * carries the server's own sentence.
 */

import { useState, type FormEvent } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useNavigate } from "react-router";
import Severity from "../components/trust/Severity.js";
import { ApiError, createHypothesis } from "../api/client.js";

/** What the form says while the session is being provisioned. */
export const CREATING_CAPTION =
  "Provisioning a container for the interview. The first one on a cold host also pulls the session image, which can take a minute — this is normal, and nothing is written until it succeeds.";

/** The helper under the thesis field. It has to say what the field DOES. */
export const THESIS_HELPER =
  "This is sent straight into the interview as your first message. Rough is fine — the interviewer's job is to sharpen it into a scoreboard.";

export const THESIS_PLACEHOLDER =
  "e.g. Hard assets like Bitcoin and gold will rise over the next five years because of currency debasement.";

export default function NewHypothesis() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [thesis, setThesis] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const trimmedThesis = thesis.trim();
  // BOTH are required. The server requires both too; this is the affordance
  // matching that gate, not a second one.
  const ready = trimmedTitle !== "" && trimmedThesis !== "";

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { id } = await createHypothesis(trimmedTitle, trimmedThesis);
      navigate(`/hypotheses/${id}`);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "could not create the hypothesis");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box component="form" onSubmit={(e) => void submit(e)} sx={{ maxWidth: 640 }}>
      <Typography sx={{ fontSize: 18, fontWeight: 600, mb: 1 }}>New hypothesis</Typography>
      <Typography sx={{ fontSize: 13, color: "text.secondary", mb: 2 }}>
        Give it a short name and state the thesis. An interviewer then works with you in the
        conversation panel to turn it into a spec — the scoreboard that gets tracked — which you
        approve before anything goes live.
      </Typography>

      <TextField
        data-testid="new-title"
        label="Name"
        placeholder="e.g. Debasement trade"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        fullWidth
        size="small"
        autoFocus
        required
        disabled={busy}
        helperText="A short label for the board. Not the thesis."
        inputProps={{ maxLength: 500 }}
        sx={{ mb: 2 }}
      />

      <TextField
        data-testid="new-thesis"
        label="Thesis"
        placeholder={THESIS_PLACEHOLDER}
        value={thesis}
        onChange={(e) => setThesis(e.target.value)}
        fullWidth
        size="small"
        multiline
        minRows={4}
        required
        disabled={busy}
        helperText={THESIS_HELPER}
        inputProps={{ maxLength: 20_000 }}
        sx={{ mb: 2 }}
      />

      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Button
          data-testid="new-submit"
          type="submit"
          variant="contained"
          disabled={!ready || busy}
          startIcon={
            busy ? (
              <CircularProgress data-testid="new-spinner" size={14} color="inherit" />
            ) : undefined
          }
        >
          {busy ? "Creating…" : "Create and start the interview"}
        </Button>
      </Box>

      {busy ? (
        <Typography data-testid="new-progress" sx={{ fontSize: 12, color: "text.secondary", mt: 1.5 }}>
          {CREATING_CAPTION}
        </Typography>
      ) : null}

      {failure !== null ? (
        <Box sx={{ mt: 2 }}>
          {/* The server's sentence, unmodified. */}
          <Severity level="degraded" cause={failure} />
        </Box>
      ) : null}
    </Box>
  );
}
