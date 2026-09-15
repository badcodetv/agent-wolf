/**
 * The researcher, in one strip: when it runs, when it runs next, how the last
 * run went — and a **Run now** button.
 *
 * Kai, 2026-09-15: "It's very hard to see what schedule it has … it would be
 * really useful to have a big button that says run, so we could observe a
 * single agent run that would happen on its schedule."
 *
 * 🔴 Run now is Bob's own firing of the SAME schedule (`POST /agent/schedules
 * /{id}/run` behind Wolf's route): the scheduled run still happens, and a
 * double press inside one minute is `already_fired`, not a second run. The
 * button asks for nothing a human could not already get by waiting.
 *
 * 🔴 A progress signal only, like `research` itself: nothing is decided from
 * it. While a run is queued or running the page polls every 10 seconds
 * (`RESEARCH_POLL_MS`), so the result lands without a reload.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import { ApiError, runResearch } from "../api/client.js";
import { relativeTime } from "./trust/Provenance.js";
import { formatUtcDateTime } from "../format.js";
import { describeCron, untilText } from "../standing.js";
import type { ResearchStatus } from "../api/types.js";

export const RUN_NOW = "Run now";

/** What Bob's outcome means to the person who pressed the button. */
export function runOutcomeSay(outcome: string, reason: string): string | null {
  switch (outcome) {
    case "requested":
      return null;
    case "already_fired":
      return "A run was already started this minute, so it was not started twice.";
    case "busy":
      return "The researcher is busy. Try again when the current run finishes.";
    case "target_missing":
      return "The researcher could not be found, so its schedule was switched off.";
    default:
      return reason.trim() !== "" ? `${outcome}: ${reason}` : `Bob answered "${outcome}".`;
  }
}

export interface ResearchStripProps {
  hypothesisId: string;
  research: ResearchStatus | null;
  /** Re-read the detail, so the strip flips to "running" straight away. */
  onStarted: () => void;
  nowMs?: number;
}

export default function ResearchStrip({ hypothesisId, research, onStarted, nowMs = Date.now() }: ResearchStripProps) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (research === null) {
    return (
      <Box
        data-testid="research-strip"
        data-state="unknown"
        sx={(theme) => ({ border: `1px solid ${theme.palette.divider}`, borderRadius: 1, px: 2, py: 1.5 })}
      >
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          The researcher&apos;s schedule could not be read just now.
        </Typography>
      </Box>
    );
  }

  const working = research.state === "running" || research.state === "queued";
  const cadence = describeCron(research.cron);
  const title = cadence === null ? "The researcher runs on a schedule" : `Researcher runs ${cadence}`;

  let detail: string;
  if (working) {
    const since = relativeTime(research.started_at_ms, nowMs);
    detail =
      research.state === "queued"
        ? "A run is starting. Results appear on this page by themselves."
        : `Researching now${since === undefined ? "" : `, started ${since}`}. Results appear on this page by themselves.`;
  } else {
    const parts: string[] = [];
    const until = untilText(research.next_run_at_ms, nowMs);
    if (research.next_run_at_ms !== null && until !== null) {
      parts.push(`Next run ${until} (${formatUtcDateTime(research.next_run_at_ms)})`);
    }
    if (research.last_finished_at_ms !== null) {
      const ok = research.last_outcome === "ok" || research.last_outcome === null;
      parts.push(
        `last run ${relativeTime(research.last_finished_at_ms, nowMs) ?? formatUtcDateTime(research.last_finished_at_ms)}, ${
          ok ? "finished OK" : `did not finish cleanly (${research.last_outcome})`
        }`,
      );
    } else {
      parts.push("no run has finished yet");
    }
    detail = parts.join(" · ");
  }

  async function run() {
    setPending(true);
    setNotice(null);
    try {
      const result = await runResearch(hypothesisId);
      setNotice(runOutcomeSay(result.outcome, result.reason ?? ""));
      onStarted();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "The run could not be started.");
    } finally {
      setPending(false);
    }
  }

  const firstRun = research.last_finished_at_ms === null && !working;

  return (
    <Box
      data-testid="research-strip"
      data-state={research.state}
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
        backgroundColor: "background.paper",
        overflow: "hidden",
      })}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 2, py: 1.5, flexWrap: "wrap" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, flex: "1 1 320px", minWidth: 0 }}>
          <Typography data-testid="research-strip-title" sx={{ fontSize: 15, fontWeight: 600 }}>
            {title}
          </Typography>
          <Typography data-testid="research-strip-detail" sx={{ fontSize: 13, color: "text.secondary" }}>
            {detail}
          </Typography>
        </Box>
        <Button
          data-testid="research-run-now"
          variant="contained"
          disableElevation
          size="large"
          disabled={pending || working}
          onClick={() => void run()}
          sx={{ px: 3, fontWeight: 600, textTransform: "none", fontSize: 15 }}
        >
          {working ? "Running…" : pending ? "Starting…" : firstRun ? "Run the first research now" : RUN_NOW}
        </Button>
      </Box>
      {working ? <LinearProgress data-testid="research-strip-progress" /> : null}
      {notice !== null ? (
        <Typography data-testid="research-run-notice" sx={{ fontSize: 13, px: 2, pb: 1.5 }}>
          {notice}
        </Typography>
      ) : null}
    </Box>
  );
}
