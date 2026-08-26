/**
 * The artifact surface — the files this hypothesis's session container wrote,
 * rendered with **Orange's own** `ArtifactPanel` (W29).
 *
 * ## Why this component is the argument for revision 5
 *
 * This is the concrete case that motivated importing Orange's presentational
 * components rather than iframing everything
 * (`design/2026-08-24-agent-wolf-ui.md` § 6: *"the artifact list — the surface
 * that prompted this whole review"*). The panel is Orange's, the palette is
 * **Wolf's**, and the two meet at Wolf's `ThemeProvider`. An iframe could
 * never do that: a cross-origin document cannot be reached by the host's CSS,
 * which is why the Orange chat rail follows `prefers-color-scheme` and takes
 * no theme prop at all.
 *
 * `ArtifactsPanel.test.tsx` asserts a `live` artifact's status dot against
 * Wolf's `success.main` **as a literal colour**, in both modes — the same
 * assertion `verify-package.sh` makes inside agent-orange, made again here at
 * the point of use, because that is what proves the shared component is themed
 * by its host rather than carrying Orange's palette with it.
 *
 * ## Channel P: `machine`
 *
 * 🔴 Artifact **metadata** is Orange's record of what a container wrote — an
 * id, a path, a size, a status. It is not model prose, so it gets
 * `Provenance kind="machine"`, which by § 2 renders **no treatment at all**.
 * Tinting it as `model` would say a model authored the file list, which is
 * false, and would spend the provenance ground on something that is not
 * untrusted. Artifact *contents* are a different question and are out of W29's
 * scope.
 *
 * ## Nothing here holds a URL
 *
 * `toArtifactInfo` sets no `downloadUrl`, and there is no route in `web/` that
 * could produce one: the bytes live behind Orange's project API key and are
 * fetched server-side or not at all.
 */

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
// R136: the DEEP subpath, not the `./components` barrel — the barrel is 46
// re-exports and importing one pulls all of them (~36s of module resolution
// per suite). NOTE the default import: a deep subpath gives the module's own
// export shape, and each component module default-exports itself.
import ArtifactPanel from "@agentkit/chat-ui/components/ArtifactPanel";
import type { ArtifactInfo } from "@agentkit/chat-ui/pure";
import Provenance from "./trust/Provenance.js";
import Severity from "./trust/Severity.js";
import { ApiError, fetchArtifacts, sessionNameForHypothesis } from "../api/client.js";
import type { ArtifactRow } from "../api/types.js";

/** Day one for every hypothesis: the container has written nothing yet. Never a bare blank. */
export const NO_ARTIFACTS =
  "No artifacts yet — nothing has been written to this session's workspace.";

/**
 * The last segment of a stored path. Orange's rows disagree about the leading
 * slash (the capture path stores `/report.md`, an upload stores what the query
 * said), so empty segments are dropped rather than trusted.
 *
 * A path that is nothing but slashes falls back to the path itself: a blank
 * row in the list would be worse than an odd-looking one.
 */
export function fileNameFor(filePath: string): string {
  const segments = filePath.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? filePath;
}

/**
 * Wolf's wire row → Orange's `ArtifactInfo`, the tier-1 type Wolf shares
 * rather than restates.
 *
 * 🔴 **`downloadUrl` is deliberately absent.** It is optional on `ArtifactInfo`
 * and it is the one field that would put an Orange URL — and the credential
 * that opens it — into the page.
 *
 * Two casts, both narrowing an open string onto a closed union that Orange's
 * own Go source says is extensible (`artifactType` is commented "extensible";
 * `status` has four values today). They are safe because every consumer of
 * both fields inside `ArtifactPanel` is TOTAL — `STATUS_DOT_COLORS[a.status] ||
 * 'text.disabled'` and `a.status === 'lost'` — so an unrecognised value
 * renders as "unknown", which is the honest treatment. Inventing a known value
 * to satisfy the union would be a lie in the one direction that matters.
 *
 * `source` has no honest passthrough: Orange's Go values are `tool | auto |
 * upload` and the TS type's are `auto | registered`, which is a genuine
 * mismatch between the two halves of the same package. Nothing in
 * `ArtifactPanel` reads it, so `auto` is preserved and everything else maps to
 * `registered` — recorded here because the mismatch is a finding, not a
 * decision.
 */
export function toArtifactInfo(row: ArtifactRow): ArtifactInfo {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: fileNameFor(row.file_path),
    fileSize: row.file_size_bytes,
    mimeType: row.mime_type,
    label: row.label,
    description: row.description,
    artifactType: row.artifact_type as ArtifactInfo["artifactType"],
    source: row.source === "auto" ? "auto" : "registered",
    status: row.status as ArtifactInfo["status"],
    isDir: row.is_dir,
  };
}

export interface ArtifactsPanelProps {
  /** The BARE 8-hex id. The `hyp-` prefix is added by `sessionNameForHypothesis` and nowhere else. */
  hypothesisId: string;
}

export default function ArtifactsPanel({ hypothesisId }: ArtifactsPanelProps) {
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetchArtifacts(hypothesisId);
        if (!live) return;
        setRows(response.artifacts ?? []);
        setFailure(null);
      } catch (err) {
        if (!live) return;
        setFailure(err instanceof ApiError ? err.message : "could not read this session's artifacts");
      }
    })();
    return () => {
      live = false;
    };
  }, [hypothesisId]);

  // A missing region, never a missing page (R140): every failure below costs
  // this block and nothing else.
  if (failure !== null) {
    return <Severity level="degraded" cause={`the artifact list could not be read — ${failure}`} />;
  }

  if (rows === null) {
    return <Skeleton data-testid="artifacts-loading" variant="rectangular" height={80} />;
  }

  // `ArtifactPanel` renders NOTHING for an empty list (it returns null with no
  // artifacts and no todos), so the explicit empty state has to be ours.
  if (rows.length === 0) {
    return (
      <Provenance kind="machine">
        <Typography data-testid="artifacts-empty" sx={{ fontSize: 13, color: "text.secondary" }}>
          {NO_ARTIFACTS}
        </Typography>
      </Provenance>
    );
  }

  return (
    <Provenance kind="machine">
      <Box data-testid="artifacts-panel" sx={{ display: "flex" }}>
        <ArtifactPanel
          artifacts={rows.map(toArtifactInfo)}
          // The session NAME, not Orange's uuid — Wolf addresses a session by
          // the name it chose, and the API's projection never sends the uuid.
          sessionId={sessionNameForHypothesis(hypothesisId)}
        />
      </Box>
    </Provenance>
  );
}
