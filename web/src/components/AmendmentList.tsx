/**
 * Spec amendments — proposals, rendered AS proposals.
 *
 * A `kind=spec-amendment` memory is written from inside a container by a
 * model. It is untrusted by construction (§ "Memory kinds"), and § 2's signal
 * table renders it as `Provenance kind="model"` — the non-semantic ground, the
 * stamp, and **the word Proposal** — with severity `none`. It is not a
 * warning: a model proposing a spec change is the product working. What makes
 * it trusted is a human accepting it, and this component says that in words.
 *
 * 🔴 **The request body is pinned and asserted byte for byte.**
 *
 *     POST /api/hypotheses/:id/amend
 *     { amendment_id, decision: "accept" | "reject", rationale }
 *
 * `amendBody` (`api/src/routes/hypotheses.ts`) is
 * `z.enum(["accept", "reject"])` — present tense. Two executors shipping
 * `"accept"` and `"accepted"` both pass their own mocked tests, and the UI
 * 400s the first time a human clicks Accept. `amendment_id` is the Orange
 * memory id of the amendment row, which is `EvidenceRow.id`.
 *
 * A rationale is required for BOTH decisions, because the server requires one
 * for both (`z.string().trim().min(1)`) — rejecting a proposal without saying
 * why is how the same proposal comes back next week.
 *
 * ⚠️ `snippet` is a **500-byte cut** of the memory, not its content. Nothing
 * here may present it as the whole proposal, and there is no full-content read
 * on the wire for it today.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Provenance from "./trust/Provenance.js";
import Severity from "./trust/Severity.js";
import { ApiError, amendSpec } from "../api/client.js";
import { formatUtcDateTime } from "../format.js";
import type { AmendmentDecision, EvidenceRow } from "../api/types.js";

/** Said on every proposal. Acceptance is what makes a change trusted. */
export const PROPOSAL_NOTE =
  "Proposal — written by the agent and untrusted. Accepting it is what makes the change trusted.";

/** Said once, above the list: the snippet is a cut, not the proposal. */
export const SNIPPET_NOTE = "shown as a 500-byte snippet, not the full proposal";

export const RATIONALE_PROMPT = "rationale required — accepting or rejecting both need one";

export interface AmendmentListProps {
  hypothesisId: string;
  amendments?: EvidenceRow[];
  /** Called after a successful decision so the page can re-read. */
  onDone?: () => void;
}

export default function AmendmentList({ hypothesisId, amendments, onDone }: AmendmentListProps) {
  const rows = Array.isArray(amendments) ? amendments : [];
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <Typography data-testid="amendments-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
        no spec amendments have been proposed
      </Typography>
    );
  }

  async function decide(row: EvidenceRow, decision: AmendmentDecision): Promise<void> {
    const rationale = (rationales[row.id] ?? "").trim();
    // The guard, not the affordance: a forced click with a blank rationale
    // must not reach a route that answers 400 to it.
    if (rationale === "" || busyId !== null) return;
    setBusyId(row.id);
    setFailure(null);
    try {
      await amendSpec(hypothesisId, row.id, decision, rationale);
      setRationales((was) => ({ ...was, [row.id]: "" }));
      onDone?.();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "the decision could not be recorded");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Box data-testid="amendments" sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography data-testid="amendments-snippet-note" sx={{ fontSize: 11, color: "text.secondary" }}>
        {SNIPPET_NOTE}
      </Typography>
      {rows.map((row) => {
        const rationale = rationales[row.id] ?? "";
        const ready = rationale.trim() !== "";
        return (
          <Box key={row.id} data-testid="amendment" data-amendment-id={row.id} data-trust="untrusted">
            <Provenance
              kind="model"
              worker={row.created_by_worker}
              session={row.created_by_session}
              atMs={row.created_at_ms}
            >
              <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
                <Typography variant="mono" sx={{ fontSize: 12, fontWeight: 700 }}>
                  Proposal
                </Typography>
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  untrusted
                </Typography>
                {row.status === null || row.status === "" ? null : (
                  <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                    {row.status}
                  </Typography>
                )}
                <Box sx={{ flex: 1 }} />
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  {formatUtcDateTime(row.created_at_ms)}
                </Typography>
              </Box>
              <Typography data-testid="amendment-note" sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
                {PROPOSAL_NOTE}
              </Typography>
              <Typography sx={{ fontSize: 13, whiteSpace: "pre-wrap", mt: 0.5 }}>
                {row.snippet}
              </Typography>
              <TextField
                data-testid="amendment-rationale"
                label={RATIONALE_PROMPT}
                value={rationale}
                onChange={(event) =>
                  setRationales((was) => ({ ...was, [row.id]: event.target.value }))
                }
                multiline
                minRows={2}
                size="small"
                fullWidth
                sx={{ mt: 1 }}
                slotProps={{ htmlInput: { "aria-label": `rationale for amendment ${row.id}` } }}
              />
              <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                <Button
                  data-testid="amendment-accept"
                  size="small"
                  variant="contained"
                  disabled={!ready || busyId !== null}
                  onClick={() => void decide(row, "accept")}
                >
                  Accept
                </Button>
                <Button
                  data-testid="amendment-reject"
                  size="small"
                  variant="outlined"
                  color="inherit"
                  disabled={!ready || busyId !== null}
                  onClick={() => void decide(row, "reject")}
                >
                  Reject
                </Button>
              </Box>
            </Provenance>
          </Box>
        );
      })}
      {failure === null ? null : (
        <Severity level="degraded" cause={`the decision was not recorded — ${failure}`} />
      )}
    </Box>
  );
}
