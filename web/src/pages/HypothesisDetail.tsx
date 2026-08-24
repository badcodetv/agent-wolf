/**
 * `/hypotheses/:id` — **W14 replaces this page's left column.**
 *
 * What W13 ships here is deliberately the frame and not the content: the
 * two-column layout of UI design § 4/§ 5 (left column scrolls normally at
 * ~1fr, right column is the sticky rail), the rail itself, the tamper alerts,
 * and the Go Live gate. W14 fills the left column in with the verdict band,
 * the case, the scoreboard, the conditions, the charts and the timeline.
 *
 * What W14 should NOT do: re-implement the rail, add a second detail fetch, or
 * introduce a second layout. `ChatRail` takes a bare id and owns its own
 * token; the left column is a plain child of the flex row below.
 */

import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import { Link as RouterLink, useParams } from "react-router";
import Link from "@mui/material/Link";
import Severity from "../components/trust/Severity.js";
import ChatRail from "../components/ChatRail.js";
import GoLiveButton from "../components/GoLiveButton.js";
import StatusChip from "../components/StatusChip.js";
import TamperWarning from "../components/TamperWarning.js";
import { ApiError, fetchHypothesis } from "../api/client.js";
import type { HypothesisDetail as Detail } from "../api/types.js";

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

  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, flexWrap: { xs: "wrap", md: "nowrap" } }}>
      {/* Left column: scrolls normally, ~1fr. W14 owns everything inside it. */}
      <Box sx={{ flex: "1 1 0", minWidth: 0 }}>
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

            {(detail.hypothesis.tamper ?? []).map((tamper) => (
              <TamperWarning key={`${tamper.reason}:${tamper.memory_id}`} tamper={tamper} />
            ))}

            {/* The spec half of the Go Live gate (W24 adds the template half). */}
            <GoLiveButton
              hypothesisId={id}
              specValidation={detail.spec_validation}
              onDone={() => void load()}
            />

            <Typography data-testid="detail-placeholder" sx={{ fontSize: 13, color: "text.secondary" }}>
              The case, scoreboard, conditions, charts and timeline land with W14.
            </Typography>
          </Box>
        )}
      </Box>

      {/* Right column: the rail. Sticky, 100vh, collapsible — never measured. */}
      <ChatRail hypothesisId={id} />
    </Box>
  );
}
