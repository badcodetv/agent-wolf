/**
 * The report panel's HOST — the box the report frame lives in.
 *
 * ## Why this is a separate component from the panel
 *
 * W23 ships `ReportPanel`: the sandboxed iframe, `sandbox="allow-scripts"`
 * with **no** `allow-same-origin`, and the CSP that goes with it. W14 ships
 * the box it sits in, because the two rules the box enforces are W14's
 * criteria and they must be testable before W23 exists. This mirrors the
 * `ChatRail` / `OrangeChatFrame` split W13 already made, for the same reason:
 * a container whose height is decided by the PARENT means the child never has
 * to measure a cross-origin document, which is not possible from outside it.
 *
 * ## The two rules
 *
 * 1. **An explicit height, never a negotiated one.** `clamp(480px, 70vh,
 *    900px)` with internal scroll, plus an **expand** control that opens a
 *    full-viewport dialog rendering **the same child** — same component, same
 *    CSP, same sandbox, because it IS the same element.
 *
 *    🔴 **Exactly ONE copy of the child is mounted at a time.** The first cut
 *    of this file left the boxed copy mounted while the dialog was open, so an
 *    expanded report was two live frames: two `srcdoc` loads of the same
 *    report, two lots of work for anything that runs script, and two
 *    independent scroll positions for one document — a reader who scrolled the
 *    box and then expanded would land back at the top. Both copies carried the
 *    identical sandbox, so it was never a security problem; it was a
 *    correctness one, and W23 would have inherited it. `ReportFrameHost.test
 *    .tsx` counts the instances in both states.
 *
 * 2. 🔴 **No `postMessage`-driven resize.** An iframe with
 *    `sandbox="allow-scripts"` and no `allow-same-origin` can still
 *    `postMessage` its parent. Honouring a height from it would let
 *    model-authored content set Wolf's layout, and a report asking for
 *    `40000px` pushes the verdict buttons off the screen. **Layout is not
 *    negotiable by untrusted content.** This component therefore registers no
 *    `message` listener at all — and `ReportFrameHost.test.tsx` asserts that
 *    by spying on `window.addEventListener`, so adding one later goes red
 *    rather than quietly working.
 *
 * The panel sits on the `model` provenance ground with a stamp above it (§ 2's
 * signal table). That wrapper is the CALLER's, not this component's: W23's
 * panel knows the report's writer and this box does not.
 */

import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import Typography from "@mui/material/Typography";

/** UI design § 5, "The report panel's height". Not a suggestion and not measured. */
export const REPORT_PANEL_HEIGHT = "clamp(480px, 70vh, 900px)";

export interface ReportFrameHostProps {
  /** W23's `ReportPanel`. Rendered inside the box, and again inside the dialog. */
  children: ReactNode;
  /** Shown beside the expand control. */
  heading?: ReactNode;
}

export default function ReportFrameHost({ children, heading = "Report" }: ReportFrameHostProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Box data-testid="report-frame-host-root">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <Typography variant="mono" sx={{ fontSize: 12, fontWeight: 600 }}>
          {heading}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          data-testid="report-expand"
          size="small"
          onClick={() => setExpanded(true)}
          sx={{ minWidth: 0, px: 1, fontSize: 12 }}
        >
          expand
        </Button>
      </Box>

      <Box
        data-testid="report-frame-host"
        sx={{
          // Fixed by US. The frame inside fills it; nothing inside it is asked
          // how tall it would like to be.
          height: REPORT_PANEL_HEIGHT,
          overflow: "auto",
          border: (theme) => `1px solid ${theme.palette.divider}`,
        }}
      >
        {/* One copy at a time — see the file header. The box keeps its height
            while the dialog is open so nothing below it jumps. */}
        {expanded ? null : children}
      </Box>

      <Dialog
        data-testid="report-dialog"
        open={expanded}
        onClose={() => setExpanded(false)}
        fullScreen
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, p: 1 }}>
          <Typography variant="mono" sx={{ fontSize: 12, fontWeight: 600 }}>
            {heading}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button data-testid="report-collapse" size="small" onClick={() => setExpanded(false)}>
            close
          </Button>
        </Box>
        {/* The SAME child element — same component, same CSP, same sandbox —
            and the only mounted copy while this dialog is open. */}
        <DialogContent data-testid="report-frame-host-expanded" sx={{ p: 0, height: "100%" }}>
          {expanded ? children : null}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
