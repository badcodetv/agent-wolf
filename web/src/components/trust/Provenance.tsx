/**
 * Channel P of the trust language — `design/2026-08-24-agent-wolf-ui.md` § 2
 * "Channel P — provenance. Always on. Never alarming." (agent-orange repo).
 *
 * A **stable property** of the content: did Wolf's deterministic evaluator
 * compute this, or did a model in a container write it?
 *
 *   machine  No treatment at all. The default ground.
 *   model    A NON-SEMANTIC ground tint, a 2px left rule, and a stamp
 *            reading `<worker-or-session> · <relative time>`.
 *
 * 🔴 The `model` tint must never be a `warning`, `error` or `info` palette
 * colour. It comes from `theme.palette.provenance`, which § 2b defines as
 * non-semantic by construction. The moment provenance borrows a semantic
 * colour, every research note — the normal, useful, everyday output — reads as
 * a problem, a real tamper alert loses all its force, and D3 has failed.
 * `Provenance.test.tsx` asserts the rendered ground against every shade of
 * `warning`, `error` and `info`, in both modes.
 *
 * Severity is the OTHER channel and composes with this one: a research note is
 * `model` + `none` and looks calm; a tampered report is `model` + `attacked`
 * and screams. See `./Severity.tsx`.
 */
import type { ReactNode } from "react";
import { Box, Typography } from "@mui/material";

export type ProvenanceKind = "machine" | "model";

export interface ProvenanceProps {
  kind: ProvenanceKind;
  /** `written_by_worker`. Preferred over `session` when both are present. */
  worker?: string | null;
  /** `written_by_session`. Used when there is no worker. */
  session?: string | null;
  /** When it was written, unix **milliseconds** (memories and datasets are ms; the `agent_*` tables are seconds — convert at the boundary, not here). */
  atMs?: number | null;
  children?: ReactNode;
}

/** Shown when a `model`-authored row names neither a worker nor a session. Never silently blank: the stamp exists to say who wrote this. */
export const UNKNOWN_WRITER = "unknown writer";

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/**
 * `atMs` as a relative phrase ("3 days ago"). Native `Intl` — the plan pins
 * native `Date` plus explicit helpers and forbids moment and dayjs, because
 * the units are the bug surface and must stay visible.
 *
 * Returns `undefined` for a missing or non-finite timestamp, and the caller
 * then renders the writer alone rather than a stamp that lies about when.
 */
export function relativeTime(atMs: number | null | undefined, nowMs: number = Date.now()): string | undefined {
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return undefined;
  const deltaMs = atMs - nowMs;
  const abs = Math.abs(deltaMs);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return fmt.format(Math.round(deltaMs / size), unit);
  }
  return fmt.format(Math.round(deltaMs / 1000), "second");
}

/** The stamp text: `written_by_worker || written_by_session`, then the relative time when there is one. */
export function provenanceStamp(props: Pick<ProvenanceProps, "worker" | "session" | "atMs">, nowMs?: number): string {
  const writer = (props.worker ?? "").trim() || (props.session ?? "").trim() || UNKNOWN_WRITER;
  const when = relativeTime(props.atMs, nowMs);
  return when ? `${writer} · ${when}` : writer;
}

export default function Provenance({ kind, worker, session, atMs, children }: ProvenanceProps) {
  // "No treatment at all" is literal: no Box, no Fragment-with-styles, nothing
  // that could later grow a border. Machine-authored content IS the default
  // ground, so the component must be indistinguishable from not using it.
  if (kind === "machine") return <>{children}</>;

  return (
    <Box
      data-testid="provenance"
      data-provenance="model"
      sx={(theme) => ({
        backgroundColor: theme.palette.provenance.ground,
        borderLeft: `2px solid ${theme.palette.provenance.rule}`,
        pl: 1.5,
        pr: 1,
        py: 1,
      })}
    >
      <Typography
        data-testid="provenance-stamp"
        variant="mono"
        sx={{ display: "block", color: "text.secondary", fontSize: 11, mb: 0.5 }}
      >
        {provenanceStamp({ worker, session, atMs })}
      </Typography>
      {children}
    </Box>
  );
}
