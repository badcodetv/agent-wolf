/**
 * `/hypotheses/:id` — the detail page. UI design § 5 (agent-bob repo).
 *
 * ```
 * ┌──────────────────────────────────────────────┬──────────────────────┐
 * │  ← Board   Petrodollar / drone parts    kai  │  Conversation    ⟨⟩  │
 * │  ◉ CHALLENGED — [Confirm] [Invalidate]       │  ┌────────────────┐  │
 * │  THE CASE · tripped rows · 3 research notes  │  │  Bob embed     │  │
 * │  REPORT (fixed height, expand)               │  │  sticky, 100vh │  │
 * │  SCOREBOARD · CONDITIONS · CHARTS            │  │                │  │
 * │  ARTIFACTS · PROPOSALS · TIMELINE  ↓ scroll  │  └────────────────┘  │
 * └──────────────────────────────────────────────┴──────────────────────┘
 *    left: scrolls normally, ~1fr           right: sticky rail, 100vh
 * ```
 *
 * ## The shape, and what W23 inherits
 *
 * 🔴 **The rail is a SIBLING of the scrolling column, not a child of it.**
 * That is the whole of D4's sizing argument: a sticky column's height is the
 * viewport's, known without measuring anything, so `BobChatFrame` gets a
 * meaningful `height: 100%` without anyone trying to measure a cross-origin
 * document from outside it. W13 built `ChatRail` and owns every part of that;
 * this page passes it a bare id and does not re-implement the column.
 *
 * **W23 composed into the TOP of the left column** (2026-08-26): `VerdictBand`
 * above the verdict actions, and `ReportPanel` as the child of
 * `ReportFrameHost`, which replaced W14's placeholder. The report block's
 * notices (`ReportDrift`) sit between the provenance stamp and the frame — see
 * the comment at that seam. The condition table was unchanged by W23.
 *
 * ## One fetch
 *
 * `GET /api/hypotheses/:id` is read here, and handed down as props. There is
 * no second detail fetch and no second detail type.
 *
 * 🔴 **While the hypothesis is a `draft`, that one read is repeated every
 * `DRAFT_POLL_MS`** (2026-09-13). The interview deposits its candidates from
 * inside a container, and nothing pushes that to this page — so a finished
 * interview used to sit beside a page that still showed no next step until
 * someone thought to reload. The poll is the same request, re-run; it stops
 * the moment the status leaves `draft`, skips ticks while the tab is hidden,
 * and a failed poll keeps the page it already has rather than replacing it
 * with an error (the first load still reports failure as before).
 *
 * 🔴 **THREE** blocks make requests of their own, and none of them is a second
 * read of the detail payload:
 *
 *  1. the charts section — one series per metric of the locked spec;
 *  2. (W29) the artifacts panel — `…/artifacts`, a list this page has no other
 *     way to get, since the detail payload does not carry it;
 *  3. **the RAIL** — `ChatRail` (`:60` below) renders `BobChatFrame`
 *     (`ChatRail.tsx:89`), which calls `fetchEmbedToken`
 *     (`BobChatFrame.tsx:106`) on every mount. It is easy to miss because
 *     the rail is a sibling of the scrolling column rather than a block
 *     inside it — but it is on this page, and every page-level test stubs it
 *     as `[TOKEN]`.
 *
 * *(This paragraph said "two" and named the first two. It said "one" before
 * that and named only the charts. Both counts were wrong for the same reason:
 * the writer corrected the sentence without opening what it names. R211's
 * check applies to a correction as much as to the claim it replaces.)*
 *
 * ## It degrades; it does not throw
 *
 * 🔴 Every block of the payload is optional at runtime whatever the interface
 * says: `evaluation` is `null` until the poller has run, `verdict` is `null`
 * until a human decides, `notes` and `amendments` are ordinarily empty, and
 * `spec` and `evaluation` are `unknown` on the wire. W13's fix round found an
 * absent `spec_validation` throwing INSIDE render and unmounting the whole
 * page (R140); a missing optional field must cost a region, never the page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import { Link as RouterLink, useParams } from "react-router";
import Link from "@mui/material/Link";
import Severity from "../components/trust/Severity.js";
import AmendmentList from "../components/AmendmentList.js";
import ArchiveButton from "../components/ArchiveButton.js";
import ArtifactsPanel from "../components/ArtifactsPanel.js";
import ChallengedCase from "../components/ChallengedCase.js";
import ChatRail from "../components/ChatRail.js";
import ConditionTable from "../components/ConditionTable.js";
import GoLiveButton from "../components/GoLiveButton.js";
import MetricCharts from "../components/MetricCharts.js";
import NextStep from "../components/NextStep.js";
import Provenance from "../components/trust/Provenance.js";
import ReportDrift from "../components/ReportDrift.js";
import ReportFrameHost from "../components/ReportFrameHost.js";
import ReportPanel from "../components/ReportPanel.js";
import Scoreboard from "../components/Scoreboard.js";
import StatusChip from "../components/StatusChip.js";
import TamperWarning from "../components/TamperWarning.js";
import Timeline from "../components/Timeline.js";
import VerdictActions from "../components/VerdictActions.js";
import VerdictBand from "../components/VerdictBand.js";
import { ApiError, fetchHypothesis } from "../api/client.js";
import type { HypothesisDetail as Detail, SpecCondition } from "../api/types.js";

/**
 * 🔴 R141 — the `degraded` sentence for a truncated title lives HERE.
 *
 * The board carries only an ellipsis affordance, because a mandatory cause
 * sentence on twenty rows would destroy § 2b principle 4's density. On one
 * hypothesis it costs a line, and the UI must never quietly claim a title is
 * complete when the 500-byte snippet cut it.
 */
export const TITLE_TRUNCATED_CAUSE =
  "this title is cut — the memory list returns a 500-byte snippet and line 1 ran past it";

/** A section heading. Density over air: a label, not a card. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box component="section" data-testid={`section-${title.toLowerCase()}`}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** How often a draft re-reads its detail, so the interview's finish shows up by itself. */
export const DRAFT_POLL_MS = 5_000;

/**
 * How often a LIVE hypothesis re-reads its detail. A researcher tick takes a
 * few minutes and nothing pushes its result to the browser, so a page left
 * open on go-live sat on "no report yet" until a reload (2026-09-13, the first
 * real-model walk). Slower than the draft poll: a live hypothesis changes at
 * most once a tick, and one detail read fans out into many Bob reads.
 */
export const LIVE_POLL_MS = 60_000;

/** The poll interval for a status, or `null` for a status that does not change by itself. */
export function pollIntervalFor(status: string | null | undefined): number | null {
  if (status === "draft") return DRAFT_POLL_MS;
  if (status === "live") return LIVE_POLL_MS;
  return null;
}

export default function HypothesisDetail() {
  const params = useParams();
  const id = params["id"] ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (options: { quiet?: boolean } = {}): Promise<void> => {
    try {
      setDetail(await fetchHypothesis(id));
      setFailure(null);
    } catch (err) {
      // A background poll that fails once must not blank a page that rendered.
      if (options.quiet === true) return;
      setFailure(err instanceof ApiError ? err.message : "could not read this hypothesis");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pollMs = pollIntervalFor(detail?.hypothesis.status);
  const pollInFlight = useRef(false);
  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => {
      // Never stack requests behind a slow API, and never poll a hidden tab.
      if (pollInFlight.current || document.hidden) return;
      pollInFlight.current = true;
      void load({ quiet: true }).finally(() => {
        pollInFlight.current = false;
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  // The condition's STATISTIC lives on the spec, not on the evaluation. Built
  // here because this is where the spec is; `undefined` for anything the spec
  // does not name, which the table renders as a dash rather than as a guess.
  const statFor = useMemo(() => {
    const conditions = Array.isArray(detail?.spec?.invalidation)
      ? (detail?.spec?.invalidation as SpecCondition[])
      : [];
    const byId = new Map(conditions.map((c) => [c.id, typeof c.stat === "string" ? c.stat : undefined]));
    return (conditionId: string): string | undefined => byId.get(conditionId);
  }, [detail]);

  // Both are DRAFT-only, and both are about layout, never about truth: nothing
  // that carries information is hidden by either. A draft is the one state in
  // which every analysis block is empty by definition — the spec is not locked,
  // so there is no series, no condition and no reading to have.
  const isDraft = detail?.hypothesis.status === "draft";
  const reportFrameSuppressed = isDraft && detail?.report?.has_template !== true;
  const analysisEmpty =
    isDraft &&
    (detail?.evaluation === null || detail?.evaluation === undefined) &&
    (detail?.amendments ?? []).length === 0;

  return (
    // 🔴 At `md` and up this page IS the viewport below the app bar, and its
    // two columns scroll independently. `overflow: hidden` here is what stops
    // the shell's scroll region from also producing a scrollbar, so there is
    // exactly one scrollbar per column and the rail's input is always on
    // screen. Below `md` the rail becomes a tab in the flow and the page goes
    // back to being a normal document — a fixed-height wrapper there would
    // trap the content in a box with no way to reach its bottom.
    <Box
      sx={{
        display: "flex",
        alignItems: { xs: "flex-start", md: "stretch" },
        gap: 2,
        flexWrap: { xs: "wrap", md: "nowrap" },
        height: { md: "100%" },
        minHeight: 0,
        overflow: { md: "hidden" },
      }}
    >
      {/* Left column: its OWN scroller at `md` and up, ~1fr. */}
      <Box
        data-testid="detail-column"
        sx={{
          flex: "1 1 0",
          minWidth: 0,
          height: { md: "100%" },
          overflowY: { md: "auto" },
          // Room for the scrollbar so it does not sit on the text.
          pr: { md: 1 },
        }}
      >
        <Link component={RouterLink} to="/" underline="hover" sx={{ fontSize: 13 }}>
          ← Board
        </Link>

        {failure !== null ? (
          <Box sx={{ mt: 2 }}>
            <Severity level="degraded" cause={`this hypothesis could not be read — ${failure}`} />
          </Box>
        ) : detail === null ? (
          <Skeleton data-testid="detail-loading" variant="rectangular" height={160} sx={{ mt: 2 }} />
        ) : (
          <Box sx={{ mt: 2, display: "flex", flexDirection: "column", gap: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
              <Typography sx={{ fontSize: 18, fontWeight: 600 }}>
                {detail.hypothesis.title ?? "(no title — no trusted state row)"}
              </Typography>
              <StatusChip status={detail.hypothesis.status} />
              <Typography variant="mono" sx={{ fontSize: 12, color: "text.secondary" }}>
                {detail.hypothesis.owner ?? "—"}
              </Typography>
              {/* Pushed to the far end: it is the one destructive-looking
                  control on the page and it must not sit beside Go Live.
                  Renders nothing where `→ archived` is not a legal
                  transition. */}
              <Box sx={{ ml: "auto" }}>
                <ArchiveButton
                  hypothesisId={id}
                  status={detail.hypothesis.status}
                  onDone={() => void load()}
                />
              </Box>
            </Box>

            {/* 🔴 FIRST, above every refusal sentence. The blocking reasons
                below say why an action is unavailable; this says which action
                to take instead, and a reader who only reads one line must get
                that one. */}
            <NextStep
              hypothesisId={id}
              status={detail.hypothesis.status}
              specValidation={detail.spec_validation}
              templateAccepted={detail.report?.has_template}
            />

            {/* R141: the board shows an ellipsis, the detail page says why. */}
            {detail.hypothesis.title_truncated === true ? (
              <Severity level="degraded" cause={TITLE_TRUNCATED_CAUSE} />
            ) : null}

            {(detail.hypothesis.tamper ?? []).map((tamper) => (
              <TamperWarning key={`${tamper.reason}:${tamper.memory_id}`} tamper={tamper} />
            ))}

            {/* 🔴 BOTH halves of the Go Live gate — § 6b: enabled iff the spec
                validates AND a report template has been accepted, and neither
                condition alone enables it.

                W24 built the second prop and wired it on the go-live REVIEW
                screen; this page kept passing `specValidation` alone, so the
                button here offered an action W22's server-side `422` would
                refuse (R219). `report` is optional on the wire, and
                `templateAccepted` is `undefined` when the block is absent —
                which blocks nothing, exactly as an absent `spec_validation`
                does. Silence from the server is not a refusal. */}
            {/* Draft only. On a live hypothesis it rendered ENABLED — both
                halves of the gate are still true after go-live — offering a
                launch the server refuses (2026-09-13, seen on the real walk). */}
            {detail.hypothesis.status === "draft" ? (
              <GoLiveButton
                hypothesisId={id}
                specValidation={detail.spec_validation}
                templateAccepted={detail.report?.has_template}
                onDone={() => void load()}
              />
            ) : null}

            <VerdictBand
              status={detail.hypothesis.status}
              evaluation={detail.evaluation ?? null}
            />

            <VerdictActions
              hypothesisId={id}
              status={detail.hypothesis.status}
              onDone={() => void load()}
            />

            <ChallengedCase
              status={detail.hypothesis.status}
              challengeReason={detail.challenge_reason ?? null}
              evaluation={detail.evaluation ?? null}
              notes={detail.notes ?? []}
              statFor={statFor}
            />

            {/* The report block, § 5's layout exactly: the model ground and
                its stamp wrap everything, the notices sit ABOVE the frame so
                they cannot scroll away from what they are about, and the
                frame is `ReportFrameHost`'s child inside the fixed box.

                🔴 `kind` is `machine` when no template has been locked: with
                nothing model-authored on screen, the tinted ground and the
                stamp would be claiming an author for an empty state.
                `Provenance kind="machine"` renders no wrapper at all, which
                is exactly what that case wants. */}
            {/* 🔴 THE FRAME IS NOT RENDERED BEFORE THERE IS A TEMPLATE.
                `ReportFrameHost` is `clamp(480px, 70vh, 900px)` by design —
                an explicit height, never a negotiated one — and on a fresh
                draft that is 480–900px of empty box between the top of the
                page and everything below it. It pushed the whole page off the
                first screen to say one sentence, which is now the sentence
                itself. Once a template exists, or once the hypothesis has left
                draft, the frame is back and unchanged: an empty report on a
                LIVE hypothesis is a real finding and keeps its full box. */}
            {reportFrameSuppressed ? (
              <Box data-testid="report-section" data-report-frame="suppressed">
                <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", mb: 0.5 }}>
                  REPORT
                </Typography>
                <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                  No report template yet — one is written during the interview and locked when the
                  hypothesis goes live.
                </Typography>
              </Box>
            ) : (
            <Box data-testid="report-section" data-report-frame="shown">
              <Provenance
                kind={detail.report?.has_template === true ? "model" : "machine"}
                // ⚠️ The pinned report block carries NO writer — not
                // `written_by_worker`, not `written_by_session` — so the stamp
                // falls back to `UNKNOWN_WRITER` rather than borrowing a
                // writer from a neighbouring row it cannot vouch for.
                atMs={detail.report?.updated_at_ms ?? null}
              >
                <ReportDrift report={detail.report ?? null} />
                <ReportFrameHost>
                  <ReportPanel hypothesisId={id} report={detail.report ?? null} />
                </ReportFrameHost>
              </Provenance>
            </Box>
            )}

            {/* 🔴 Collapsed to ONE line while nothing has ever been measured.
                Four headings each saying "not evaluated yet" is four times the
                noise of saying it once, and it buried the two things on a
                draft that do matter. This is a DRAFT-only collapse: the moment
                a hypothesis goes live, every section renders whether or not it
                has content, because an empty section on a live hypothesis is
                itself the finding. */}
            {analysisEmpty ? (
              <Typography data-testid="analysis-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
                No scoreboard, conditions or charts yet — they appear once the spec is locked at
                go-live and the researcher has produced its first reading.
              </Typography>
            ) : (
              <>
            <Section title="SCOREBOARD">
              <Scoreboard evaluation={detail.evaluation ?? null} />
            </Section>

            <Section title="CONDITIONS">
              <ConditionTable
                conditions={
                  Array.isArray(detail.evaluation?.conditions) ? detail.evaluation.conditions : []
                }
                statFor={statFor}
              />
            </Section>

            <Section title="CHARTS">
              <MetricCharts
                hypothesisId={id}
                spec={detail.spec ?? null}
                specSource={detail.spec_source}
                refreshKey={detail.evaluation?.evaluated_at_ms ?? null}
              />
            </Section>

              </>
            )}

            {/* W29. § 2 maps artifact METADATA to `machine`: it is Bob's
                record of what a container wrote, not model prose — so the
                panel carries no tint and no stamp. The panel itself is
                Bob's own `ArtifactPanel`, under WOLF's ThemeProvider. */}
            <Section title="ARTIFACTS">
              <ArtifactsPanel hypothesisId={id} />
            </Section>

            <Section title="PROPOSALS">
              <AmendmentList
                hypothesisId={id}
                amendments={detail.amendments ?? []}
                onDone={() => void load()}
              />
            </Section>

            <Section title="TIMELINE">
              <Timeline detail={detail} />
            </Section>
          </Box>
        )}
      </Box>

      {/* Right column: the rail. A SIBLING of the column above, never a child
          of it — sticky, 100vh, collapsible, and never measured. */}
      <ChatRail hypothesisId={id} />
    </Box>
  );
}
