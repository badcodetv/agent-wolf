/**
 * Archive — the one way a hypothesis leaves the board.
 *
 * 🔴 **It is called Archive, not Delete, because nothing is deleted.** The
 * memory bus is append-only: `POST /api/hypotheses/:id/retire` writes a
 * `status=archived` state row, which takes the hypothesis off the attention
 * queue (`partitionBoard`) and puts it on `/archive`, still readable, with its
 * whole history intact. A control labelled "Delete" would promise something no
 * route in this product can do, and would make a reader who wanted the record
 * gone believe it was.
 *
 * 🔴 **Two steps, and a rationale.** The rationale is required by the server
 * (`retireBody` is `z.string().trim().min(1)`) and it is also the confirm
 * step: there is no separate "are you sure?" dialog because typing a reason is
 * a better one — it cannot be dismissed by reflex, and it leaves a record of
 * why on the memory that ends the hypothesis. The same argument as
 * `VerdictActions`, for the same reason.
 *
 * 🔴 **Offered only where the transition is legal** — `draft`, `live` and
 * `challenged` (W5's `LEGAL_TRANSITIONS`). This is not a second gate; the
 * server enforces the state machine. It is the affordance matching the gate,
 * so a button is never shown for something the server would refuse.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Severity from "./trust/Severity.js";
import { ApiError, archiveHypothesis } from "../api/client.js";

/** The statuses `draft → archived`, `live → archived` and `challenged → archived` cover. */
export const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(["draft", "live", "challenged"]);

export const ARCHIVE_RATIONALE_PROMPT = "why is this being archived?";

export const ARCHIVE_EXPLANATION =
  "Archiving takes it off the board. Nothing is deleted — it stays readable under Archive.";

export interface ArchiveButtonProps {
  hypothesisId: string;
  /** The lifecycle state from the trusted `hypothesis` memory. */
  status: string | null | undefined;
  /** Called after a successful archive so the caller can re-read. */
  onDone?: () => void;
  /** `text` on a dense board row; `outlined` on the detail page. */
  variant?: "text" | "outlined";
}

export default function ArchiveButton({
  hypothesisId,
  status,
  onDone,
  variant = "text",
}: ArchiveButtonProps) {
  const [open, setOpen] = useState(false);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (typeof status !== "string" || !ARCHIVABLE_STATUSES.has(status)) return null;

  const ready = rationale.trim() !== "";

  async function submit(): Promise<void> {
    // Belt to the disabled attribute's braces: a keyboard or a test can fire a
    // click on a disabled-looking control, and a blank rationale must not
    // reach the wire — it is a 400 in front of someone who has already decided.
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await archiveHypothesis(hypothesisId, rationale.trim());
      setRationale("");
      setOpen(false);
      onDone?.();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "this hypothesis was not archived");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        data-testid="archive-open"
        size="small"
        variant={variant}
        color="inherit"
        onClick={() => setOpen(true)}
        sx={{ fontSize: 12, minWidth: 0 }}
      >
        Archive
      </Button>
    );
  }

  return (
    <Box
      data-testid="archive-form"
      sx={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 520, my: 1 }}
    >
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{ARCHIVE_EXPLANATION}</Typography>
      <TextField
        data-testid="archive-rationale"
        label={ARCHIVE_RATIONALE_PROMPT}
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        size="small"
        fullWidth
        autoFocus
        multiline
        minRows={2}
        slotProps={{ htmlInput: { "aria-label": "archive rationale" } }}
      />
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <Button
          data-testid="archive-confirm"
          size="small"
          variant="contained"
          color="inherit"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          {busy ? "Archiving…" : "Archive"}
        </Button>
        <Button
          data-testid="archive-cancel"
          size="small"
          color="inherit"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setRationale("");
            setFailure(null);
          }}
        >
          Cancel
        </Button>
        {ready ? null : (
          <Typography data-testid="archive-blocked" sx={{ fontSize: 12, color: "text.secondary" }}>
            {ARCHIVE_RATIONALE_PROMPT}
          </Typography>
        )}
      </Box>
      {failure === null ? null : (
        <Severity level="degraded" cause={`this hypothesis was not archived — ${failure}`} />
      )}
    </Box>
  );
}
