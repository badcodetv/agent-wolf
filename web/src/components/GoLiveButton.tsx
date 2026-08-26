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
 *
 * ## The template half (W24)
 *
 * 🔴 **Enabled iff `spec_validation.valid && report.has_template`** — UI
 * design § 6b. **Neither condition alone enables it**, which is why both
 * blocking reasons are rendered independently: a human whose spec is fine and
 * whose template is missing must be told about the template, not sent back to
 * re-read a spec that validates.
 *
 * `templateAccepted` is OPTIONAL and `undefined` does not block, exactly as
 * an absent `spec_validation` does not. That is the same rule, not a
 * loophole: silence from the server is not a refusal, W22 built the
 * server-side `422` backstop with a `path` of `report.has_template`, and a
 * browser that refused to launch on a field the payload never carried would
 * be a second gate decided here. A caller that KNOWS the answer passes the
 * boolean; today the go-live review screen does.
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
  /** The server's verdict on the spec. Half of the enabled/disabled decision. */
  specValidation: SpecValidation;
  /**
   * `report.has_template` from `GET /api/hypotheses/:id` — the other half.
   *
   * `false` blocks and says so. `undefined` means the caller has not read the
   * report block and blocks nothing; see the file header for why that is the
   * same rule the spec half already holds to and not a widening of it.
   */
  templateAccepted?: boolean;
  /** Called after a successful go-live, so the page can re-read. */
  onDone?: () => void;
}

/** The blocking reason for the template half, in words. § 2: never a bare marker. */
export const NO_TEMPLATE_ACCEPTED =
  "No report template has been accepted yet, so this hypothesis cannot go live: " +
  "review the candidate and accept it first.";

export default function GoLiveButton({
  hypothesisId,
  specValidation,
  templateAccepted,
  onDone,
}: GoLiveButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // `=== false`, not `!valid`: the gate is the server's boolean, and an
  // absent/undefined field must not read as "invalid" by accident here — it
  // would be a client-side gate wearing a server-side gate's clothes.
  //
  // The `?.` is defensive, not a widening of the contract: `spec_validation`
  // is declared non-optional and the server always sends it. But the shape
  // arrives over the wire, and reading `.valid` off an absent object throws
  // during render — which does not "fail closed", it takes the whole detail
  // page down. Silence from the server is not a refusal, and W9's 422 on the
  // POST is the real backstop.
  const specBlocked = specValidation?.valid === false;
  const errors = specValidation?.errors ?? [];

  // `=== false` for the same reason, and read INDEPENDENTLY of the spec half:
  // an `&&` between the two would enable the button whenever either was
  // satisfied, which is the one thing § 6b forbids.
  const templateBlocked = templateAccepted === false;
  const blocked = specBlocked || templateBlocked;

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

      {templateBlocked ? (
        <Typography data-testid="template-blocked" sx={{ fontSize: 13, color: "text.secondary" }}>
          {NO_TEMPLATE_ACCEPTED}
        </Typography>
      ) : null}

      {specBlocked ? (
        <Box data-testid="spec-errors" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            The spec candidate does not validate, so this hypothesis cannot go live yet:
          </Typography>
          {errors.length === 0 ? (
            <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
              (the server reported no detail — the spec is still refused)
            </Typography>
          ) : (
            errors.map((error) => (
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
