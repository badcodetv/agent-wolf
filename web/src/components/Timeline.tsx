/**
 * The timeline — newest first, and every row says whose word it is.
 *
 * 🔴 **The trust boundary is the product, so it is visible.** § "Memory kinds"
 * divides what Wolf writes with its own API key (the `hypothesis` state rows
 * and the `verdict` — trusted) from what a model wrote inside a container
 * (`research-note`, `spec-amendment` — untrusted). This component labels every
 * row on both channels:
 *
 *   - **Channel P**, the treatment: untrusted rows are wrapped in
 *     `<Provenance kind="model">`, which gives them the non-semantic ground,
 *     the 2px rule and the `<writer> · <relative time>` stamp. Trusted rows
 *     get `kind="machine"`, which renders no wrapper at all — machine-authored
 *     content IS the default ground.
 *   - **In words**, because a tint is not a claim: each row carries its kind
 *     and the literal word `trusted` or `untrusted`. A screenshot pasted into
 *     a chat keeps the label; it does not keep the tint.
 *
 * The `model` ground is deliberately NOT a warning colour (§ 2 "Channel P"):
 * a daily research note is the normal, useful, everyday output, and styling it
 * as a problem would leave no headroom for a real tamper alert.
 *
 * ## What is missing, and why it is not invented here
 *
 * The criterion asks for "state changes from the `hypothesis` memories",
 * plural. `GET /api/hypotheses/:id` serves the CURRENT state row only
 * (`detailRow()` projects the newest trusted row and no history), so the
 * timeline carries one state row, not the walk. Fetching the history would
 * mean a second detail read the ownership table forbids; synthesising it from
 * the status alone would mean inventing timestamps. See the ticket report.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Provenance from "./trust/Provenance.js";
import { formatUtcDateTime } from "../format.js";
import type { EvidenceRow, HypothesisDetail, UnixMs } from "../api/types.js";

/** The four kinds a detail payload can put on the timeline. */
export type TimelineKind = "hypothesis" | "verdict" | "research-note" | "spec-amendment";

/**
 * Which kinds are TRUSTED, from § "Memory kinds". Written as a table rather
 * than as a condition so that adding a kind forces a decision about it.
 */
export const TRUSTED_KINDS: Record<TimelineKind, boolean> = {
  hypothesis: true,
  verdict: true,
  "research-note": false,
  "spec-amendment": false,
};

export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  trusted: boolean;
  /** Unix MILLISECONDS. `null` only when the payload carried none. */
  atMs: UnixMs | null;
  heading: string;
  body: string;
  worker: string;
  session: string;
}

/** Sorts newest first; a row with no timestamp sorts last rather than to 1970. */
function byNewestFirst(a: TimelineItem, b: TimelineItem): number {
  const left = a.atMs ?? Number.NEGATIVE_INFINITY;
  const right = b.atMs ?? Number.NEGATIVE_INFINITY;
  return right - left;
}

function evidenceItem(row: EvidenceRow, kind: TimelineKind, heading: string): TimelineItem {
  return {
    key: `${kind}:${row.id}`,
    kind,
    trusted: TRUSTED_KINDS[kind],
    atMs: row.created_at_ms,
    heading: row.status === null || row.status === "" ? heading : `${heading} · ${row.status}`,
    body: row.snippet,
    worker: row.created_by_worker,
    session: row.created_by_session,
  };
}

/**
 * The rows, newest first.
 *
 * Every block is read through `Array.isArray` and every optional field
 * through a default: the detail payload's evaluation-shaped blocks are
 * `unknown` on the wire, and a malformed one must render a shorter timeline
 * rather than unmount the page (R140).
 */
export function buildTimeline(detail: HypothesisDetail): TimelineItem[] {
  const items: TimelineItem[] = [];

  const hypothesis = detail.hypothesis;
  if (hypothesis !== undefined && hypothesis !== null) {
    items.push({
      key: `hypothesis:${hypothesis.status_memory_id ?? hypothesis.id}`,
      kind: "hypothesis",
      trusted: true,
      atMs: hypothesis.updated_at_ms,
      heading: `state · ${hypothesis.status ?? "no state row"}`,
      // No body. The heading already carries the state, and repeating the
      // title here would put the same string on the page twice for no reader
      // who did not already have it three inches above.
      //
      // Wolf writes these rows with its own API key, so there is no writer to
      // name either — which is exactly what `machine` provenance means.
      body: "",
      worker: "",
      session: "",
    });
  }

  const verdict = detail.verdict;
  if (verdict !== undefined && verdict !== null) {
    items.push({
      key: `verdict:${verdict.id}`,
      kind: "verdict",
      trusted: true,
      atMs: verdict.created_at_ms,
      heading: `verdict · ${verdict.status ?? "recorded"}`,
      body: verdict.content,
      worker: "",
      session: "",
    });
  }

  for (const row of Array.isArray(detail.notes) ? detail.notes : []) {
    items.push(evidenceItem(row, "research-note", "research note"));
  }
  for (const row of Array.isArray(detail.amendments) ? detail.amendments : []) {
    items.push(evidenceItem(row, "spec-amendment", "spec amendment"));
  }

  return items.sort(byNewestFirst);
}

/** Said once, above the rows: nothing here may claim to be complete. */
export const SNIPPET_NOTE =
  "research notes and proposals are shown as 500-byte snippets, not in full";

export interface TimelineProps {
  detail: HypothesisDetail;
}

export default function Timeline({ detail }: TimelineProps) {
  const items = buildTimeline(detail);
  const hasSnippets = items.some((item) => !item.trusted);

  if (items.length === 0) {
    return (
      <Typography data-testid="timeline-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
        nothing has happened to this hypothesis yet
      </Typography>
    );
  }

  return (
    <Box data-testid="timeline">
      {hasSnippets ? (
        <Typography data-testid="timeline-snippet-note" sx={{ fontSize: 11, color: "text.secondary", mb: 1 }}>
          {SNIPPET_NOTE}
        </Typography>
      ) : null}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {items.map((item) => (
          <Box
            key={item.key}
            data-testid="timeline-row"
            data-kind={item.kind}
            data-trust={item.trusted ? "trusted" : "untrusted"}
          >
            <Provenance
              kind={item.trusted ? "machine" : "model"}
              worker={item.worker}
              session={item.session}
              atMs={item.atMs}
            >
              <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
                <Typography variant="mono" sx={{ fontSize: 12, fontWeight: 600 }}>
                  {item.heading}
                </Typography>
                {/* In words, not only in treatment. A tint does not survive a
                    screenshot pasted into a chat; this label does. */}
                <Typography
                  data-testid="timeline-trust-label"
                  variant="mono"
                  sx={{ fontSize: 11, color: "text.secondary" }}
                >
                  {item.trusted ? "trusted" : "untrusted"}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
                  {formatUtcDateTime(item.atMs)}
                </Typography>
              </Box>
              {item.body === "" ? null : (
                <Typography sx={{ fontSize: 13, whiteSpace: "pre-wrap", mt: 0.5 }}>
                  {item.body}
                </Typography>
              )}
            </Provenance>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
