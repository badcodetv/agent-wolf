/**
 * The report frame — the one place model-authored HTML is rendered, and the
 * only reason it is safe to render it at all.
 *
 * ## The sandbox, and why it is the highest-value line in the feature
 *
 * 🔴 `sandbox="allow-scripts"` **and nothing else**. Never
 * `allow-same-origin`.
 *
 * Those two tokens together are not "two permissions": they are **no
 * sandbox**. `allow-scripts` alone leaves the framed document in an OPAQUE
 * origin, so the script a model wrote can run, and can reach neither this
 * page's DOM, nor Wolf's session cookie, nor any signed-in API route on this
 * host. Add `allow-same-origin` and the document regains Wolf's origin: the
 * same script now reads the cookie, calls every route as the signed-in human,
 * and reaches into the parent document. A bounded risk becomes a session
 * compromise — Bob's hazard H3, and `ReportPanel.test.tsx` asserts the
 * rendered attribute string rather than a prop, because an `allow-same-origin`
 * arriving through any route at all lands in that same string.
 *
 * The report still needs script: W19's templates draw their own charts from
 * the injected series payload. Removing `allow-scripts` is not the mitigation;
 * withholding `allow-same-origin` is.
 *
 * ## The document arrives as a URL, never as data
 *
 * 🔴 The composed report leaves the API through
 * `GET /api/hypotheses/:id/report/frame` and nowhere else. This component
 * asks for no HTML, accepts none as a prop, and never uses `srcdoc`.
 *
 * The bytes are safe only inside the frame that route's **CSP header** applies
 * to, and a header can only apply to a document the browser fetched. HTML
 * handed to the SPA as JSON would have no sandbox, no `frame-ancestors` and no
 * opaque origin however carefully it were inserted — which is why W21's
 * `composeReportStats` deliberately does not return `html`, and why this file
 * must never ask it to.
 *
 * ## Height
 *
 * Not ours. `ReportFrameHost` (W14) owns `clamp(480px, 70vh, 900px)`, the
 * internal scroll, the expand dialog, and the rule that a `postMessage` from
 * the framed content is ignored. This component is its CHILD and takes 100% of
 * whatever box it is given — boxed or expanded, one live frame at a time.
 *
 * ## The three states that are not a frame
 *
 * `has_template: false`   nobody has authored and locked a template.
 * `drift: null` + `!unreadable`   a template exists; no tick has filled it.
 * `unreadable: true`   Wolf cannot read what it stored.
 *
 * The first two are empty states with different sentences, because "run the
 * interview" and "wait for tomorrow" are different instructions. The third is
 * **not** an empty state: `GET …/report/frame` fails for that same condition,
 * so a frame mounted there would display the API's error body inside the
 * report panel — and rendering it as "no tick yet" is what W22's verifier
 * proved can hide a cross-hypothesis attack. The degraded sentence for it is
 * `ReportDrift`'s; this file's job is to withhold the frame and say so.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReportBlock } from "../api/types.js";

/** The route that serves the composed document, with its CSP header. The ONLY door. */
export function reportFrameSrc(hypothesisId: string): string {
  return `/api/hypotheses/${encodeURIComponent(hypothesisId)}/report/frame`;
}

/**
 * 🔴 The sandbox token list, written once.
 *
 * A single token. See the file header for what the second one would cost.
 */
export const REPORT_SANDBOX = "allow-scripts";

/** No template has been authored and locked. The interview writes one; go-live locks it. */
export const NO_REPORT_TEMPLATE =
  "no report template yet — one is written in the interview and locked when the hypothesis goes live";

/** A template exists and nothing has filled it. Day one for every hypothesis that just went live. */
export const NO_REPORT_YET = "no report yet — the first tick has not run";

/** `unreadable: true`. The frame route fails for this state, so the frame is not mounted. */
export const REPORT_WITHHELD =
  "this report is not being shown — Wolf could not read what it stored, so the frame would carry the failure instead of the report";

export interface ReportPanelProps {
  hypothesisId: string;
  /**
   * The pinned report block. `null`/absent must cost the panel and never the
   * page (R140) — an older server or a fixture can omit it.
   */
  report?: ReportBlock | null;
}

/** The empty and withheld states share a shape: one sentence, inside the host's box. */
function Stated({ testId, children }: { testId: string; children: string }) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography data-testid={testId} sx={{ fontSize: 13, color: "text.secondary" }}>
        {children}
      </Typography>
    </Box>
  );
}

export default function ReportPanel({ hypothesisId, report }: ReportPanelProps) {
  // Ordered deliberately. `unreadable` is checked FIRST because it is the one
  // state a model inside a container can cause at will, and the empty state
  // is what it would otherwise hide behind.
  if (report === null || report === undefined) {
    return <Stated testId="report-empty">{NO_REPORT_TEMPLATE}</Stated>;
  }
  if (report.unreadable === true) {
    return <Stated testId="report-withheld">{REPORT_WITHHELD}</Stated>;
  }
  if (report.has_template !== true) {
    return <Stated testId="report-empty">{NO_REPORT_TEMPLATE}</Stated>;
  }
  if (report.drift === null || report.drift === undefined) {
    return <Stated testId="report-empty">{NO_REPORT_YET}</Stated>;
  }

  return (
    <iframe
      data-testid="report-frame"
      title="Report"
      // A URL. Never `srcdoc`, never a string this application has held.
      src={reportFrameSrc(hypothesisId)}
      // 🔴 One token. Adding `allow-same-origin` here cancels the sandbox
      // outright — see the file header.
      sandbox={REPORT_SANDBOX}
      // 100% of the host's box and nothing else: no pixel height, nothing
      // derived from content, nothing the framed document can influence.
      style={{ width: "100%", height: "100%", border: "0", display: "block" }}
    />
  );
}
