/**
 * The Go Live gate.
 *
 * 🔴 **There is exactly ONE source for this gate, and it is server-side.**
 * `GET /api/hypotheses/:id` carries
 * `spec_validation: { valid, errors: [{ path, message }] }`, computed by the
 * API with W3's validator over the newest
 * `kind=hypothesis-spec-candidate` memory. The button is disabled **iff**
 * `spec_validation.valid === false`.
 *
 * `web/` NEVER imports the spec validator. Putting it in the browser would put
 * the go-live gate in two places, and the two would drift — a spec the browser
 * called valid and the server refused, or worse, the other way round. W1's
 * import boundary would happily permit the import; the rule is a discipline,
 * and this comment plus `src/import-boundary.test.ts` is where it is written
 * down. The server's own `422` on `POST /go-live` is the backstop for the race
 * between reading the validation and clicking, not the UI's source of truth.
 *
 * W24 extends this gate with the accepted-template condition; W13 ships the
 * spec half, and W24 should add a second **prop**, not a second gate.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Severity from "./trust/Severity.js";
import { ApiError, goLive } from "../api/client.js";
import type { SpecValidation } from "../api/types.js";

export interface GoLiveButtonProps {
  hypothesisId: string;
  /** The server's verdict. The ONLY input to the enabled/disabled decision. */
  specValidation: SpecValidation;
  /** Called after a successful go-live, so the page can re-read. */
  onDone?: () => void;
}

export default function GoLiveButton({
  hypothesisId,
  specValidation,
  onDone,
}: GoLiveButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // `=== false`, not `!valid`: the gate is the server's boolean, and an
  // absent/undefined field must not read as "invalid" by accident here — it
  // would be a client-side gate wearing a server-side gate's clothes.
  const blocked = specValidation.valid === false;

  async function submit(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await goLive(hypothesisId);
      onDone?.();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "go-live failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box>
        <Button
          data-testid="go-live-button"
          variant="contained"
          size="small"
          disabled={blocked || busy}
          onClick={() => void submit()}
        >
          Go live
        </Button>
      </Box>

      {blocked ? (
        <Box data-testid="spec-errors" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            The spec candidate does not validate, so this hypothesis cannot go live yet:
          </Typography>
          {specValidation.errors.length === 0 ? (
            <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
              (the server reported no detail — the spec is still refused)
            </Typography>
          ) : (
            specValidation.errors.map((error) => (
              <Typography
                data-testid="spec-error"
                key={`${error.path}:${error.message}`}
                variant="mono"
                sx={{ display: "block", fontSize: 12 }}
              >
                {`${error.path}: ${error.message}`}
              </Typography>
            ))
          )}
        </Box>
      ) : null}

      {failure !== null ? <Severity level="degraded" cause={failure} /> : null}
    </Box>
  );
}
