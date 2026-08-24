/**
 * `/new` — the whole of starting a hypothesis: a title.
 *
 * `POST /api/hypotheses` takes `{ title }` and answers **201 `{ id }`**. It is
 * a slow route by construction: Orange's session create is asynchronous, so
 * the API polls the by-name route until the `hyp-<id>` session leaves
 * `creating` before it writes anything. Nothing is written to memory until the
 * session is real, which is why a failure here leaves no half-made hypothesis
 * behind — and why this form must say it is working rather than look stuck.
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
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useNavigate } from "react-router";
import Severity from "../components/trust/Severity.js";
import { ApiError, createHypothesis } from "../api/client.js";

export default function NewHypothesis() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [thesis, setThesis] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmed = title.trim();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { id } = await createHypothesis(trimmed, thesis);
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
        A title is enough to start. The interview turns it into a spec you approve before anything
        goes live.
      </Typography>

      <TextField
        data-testid="new-title"
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        fullWidth
        size="small"
        autoFocus
        inputProps={{ maxLength: 500 }}
        sx={{ mb: 2 }}
      />

      <TextField
        data-testid="new-thesis"
        label="Thesis (optional)"
        value={thesis}
        onChange={(e) => setThesis(e.target.value)}
        fullWidth
        size="small"
        multiline
        minRows={3}
        sx={{ mb: 2 }}
      />

      <Button data-testid="new-submit" type="submit" variant="contained" disabled={trimmed === "" || busy}>
        {busy ? "Creating the session…" : "Create"}
      </Button>

      {failure !== null ? (
        <Box sx={{ mt: 2 }}>
          {/* The server's sentence, unmodified. */}
          <Severity level="degraded" cause={failure} />
        </Box>
      ) : null}
    </Box>
  );
}
