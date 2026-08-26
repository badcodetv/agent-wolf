/**
 * `/hypotheses/:id` — the detail page. UI design § 5 (agent-orange repo).
 *
 * ```
 * ┌──────────────────────────────────────────────┬──────────────────────┐
 * │  ← Board   Petrodollar / drone parts    kai  │  Conversation    ⟨⟩  │
 * │  ◉ CHALLENGED — [Confirm] [Invalidate]       │  ┌────────────────┐  │
 * │  THE CASE · tripped rows · 3 research notes  │  │  Orange embed  │  │
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
 * viewport's, known without measuring anything, so `OrangeChatFrame` gets a
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
 * `GET /api/hypotheses/:id` is read once, here, and handed down as props.
 * There is no second detail fetch and no second detail type.
 *
 * 🔴 **THREE** blocks make requests of their own, and none of them is a second
 * read of the detail payload:
 *
 *  1. the charts section — one series per metric of the locked spec;
 *  2. (W29) the artifacts panel — `…/artifacts`, a list this page has no other
 *     way to get, since the detail payload does not carry it;
 *  3. **the RAIL** — `ChatRail` (`:60` below) renders `OrangeChatFrame`
 *     (`ChatRail.tsx:89`), which calls `fetchEmbedToken`
 *     (`OrangeChatFrame.tsx:106`) on every mount. It is easy to miss because
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

import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import { Link as RouterLink, useParams } from "react-router";
import Link from "@mui/material/Link";
import Severity from "../components/trust/Severity.js";
import AmendmentList from "../components/AmendmentList.js";
import ArtifactsPanel from "../components/ArtifactsPanel.js";
import ChallengedCase from "../components/ChallengedCase.js";
import ChatRail from "../components/ChatRail.js";
import ConditionTable from "../components/ConditionTable.js";
import GoLiveButton from "../components/GoLiveButton.js";
import MetricCharts from "../components/MetricCharts.js";
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

export default function HypothesisDetail() {
  const params = useParams();
  const id = params["id"] ?? "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await fetchHypothesis(id));
      setFailure(null);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "could not read this hypothesis");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, flexWrap: { xs: "wrap", md: "nowrap" } }}>
      {/* Left column: scrolls normally, ~1fr. */}
      <Box data-testid="detail-column" sx={{ flex: "1 1 0", minWidth: 0 }}>
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
            </Box>

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
            <GoLiveButton
              hypothesisId={id}
              specValidation={detail.spec_validation}
              templateAccepted={detail.report?.has_template}
              onDone={() => void load()}
            />

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
            <Box data-testid="report-section">
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
              />
            </Section>

            {/* W29. § 2 maps artifact METADATA to `machine`: it is Orange's
                record of what a container wrote, not model prose — so the
                panel carries no tint and no stamp. The panel itself is
                Orange's own `ArtifactPanel`, under WOLF's ThemeProvider. */}
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
