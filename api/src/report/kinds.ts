/**
 * The report layer's memory vocabulary: the four `kind=` values it uses, the
 * labels each one carries, and the content format on each side of line 1.
 *
 * design/2026-08-20-agent-wolf.md § "Memory kinds (the Wolf vocabulary)" is the
 * authority. The four rows this file implements:
 *
 * | Kind | Labels | Content | Trusted |
 * | --- | --- | --- | --- |
 * | `report-template`  | `kind, name=<id>, status=locked`   | line 1 is the `structureHash`; then the template HTML fragment | **Yes** |
 * | `report-candidate` | `kind, name=<id>`                  | line 1 is a summary; then the proposed template HTML | No |
 * | `report`           | `kind, name=<id>`                  | line 1 is the headline (≤400 characters); then `{slotId: html}` as JSON | No |
 * | `report-amendment` | `kind, name=<id>, status=proposed` | line 1 is a rationale; then the proposed template HTML | No |
 *
 * ⚠️ **This file RE-EXPORTS the trust primitives; it does not redefine them.**
 * `TRUSTED_KINDS`, `isTrusted`, `hasEmptyProvenance` and the two `Tamper`
 * builders are W5's, and live in `../hypothesis/store.ts` (the plan settled
 * their single owner in **R48**: "One must define and the other re-export").
 * A second copy of `TRUSTED_KINDS` anywhere in this tree is how the trust
 * boundary silently widens — if you are tempted, widen W5's list instead.
 *
 * Only ONE of these four kinds is trusted (`report-template`), and only
 * because Wolf's own server credential is what writes it. The other three
 * cross the container boundary by construction: an interview proposes a
 * template (`report-candidate`), a researcher writes a daily report
 * (`report`), a critic proposes a replacement (`report-amendment`). Nothing
 * here may treat any of them as authoritative.
 */

import { WolfError } from "../errors.js";
import {
  HYPOTHESIS_ID_PATTERN,
  LABEL_VALUE_PATTERN,
  MAX_LABEL_VALUE_LENGTH,
  TRUSTED_KINDS,
  TRUSTED_KIND_LIST,
  forgedRowTamper,
  hasEmptyProvenance,
  hostileRetractionTamper,
  isHypothesisId,
  isTrusted,
} from "../hypothesis/store.js";
import type {
  ProvenancedMemory,
  SessionLookup,
  Tamper,
  TrustedKind,
} from "../hypothesis/store.js";

// ── W5's trust primitives, re-exported (NOT redefined) ──────────────────

export {
  HYPOTHESIS_ID_PATTERN,
  LABEL_VALUE_PATTERN,
  MAX_LABEL_VALUE_LENGTH,
  TRUSTED_KINDS,
  TRUSTED_KIND_LIST,
  forgedRowTamper,
  hasEmptyProvenance,
  hostileRetractionTamper,
  isHypothesisId,
  isTrusted,
};
export type { ProvenancedMemory, SessionLookup, Tamper, TrustedKind };

// ── The four report-layer kinds ─────────────────────────────────────────

/** The locked template. The ONE report-layer kind in `TRUSTED_KINDS`. */
export const KIND_REPORT_TEMPLATE = "report-template";
/** An interview's proposed template, crossing the container boundary. */
export const KIND_REPORT_CANDIDATE = "report-candidate";
/** A daily report: a headline plus one HTML fragment per slot. */
export const KIND_REPORT = "report";
/** A proposed replacement template, awaiting a human. */
export const KIND_REPORT_AMENDMENT = "report-amendment";

/**
 * ENUMERATED, NEVER COUNTED — the same rule `TRUSTED_KINDS` is held to, for
 * the same reason. If a fifth report kind ever exists, add it here; do not
 * write down how many there are.
 */
export const REPORT_KIND_LIST = Object.freeze([
  KIND_REPORT_TEMPLATE,
  KIND_REPORT_CANDIDATE,
  KIND_REPORT,
  KIND_REPORT_AMENDMENT,
] as const);

export type ReportMemoryKind = (typeof REPORT_KIND_LIST)[number];

export function isReportMemoryKind(value: string): value is ReportMemoryKind {
  return (REPORT_KIND_LIST as readonly string[]).includes(value);
}

// ── Labels ──────────────────────────────────────────────────────────────

/**
 * Every label builder validates the id first. A label VALUE must match
 * `go/agentdb/labels.go:33-34`, and a hypothesis id is 8 bare lowercase hex
 * characters — the `hyp-` prefix belongs to the session name and to nothing
 * else (§ "Vocabulary"). Passing `hyp-<id>` here would produce a `name` label
 * that matches no hypothesis and a memory nothing ever reads again.
 */
function requireBareId(id: string, where: string): string {
  if (!isHypothesisId(id)) {
    throw new WolfError(
      "invalid",
      `${where}: not a bare hypothesis id: ${JSON.stringify(id)} (ids are 8 lowercase hex characters; the "hyp-" prefix belongs to the session name only)`,
      { details: { id } },
    );
  }
  return id;
}

export type ReportLabels = Record<string, string>;

/** `kind=report-template, name=<id>, status=locked`. */
export function reportTemplateLabels(id: string): ReportLabels {
  return {
    kind: KIND_REPORT_TEMPLATE,
    name: requireBareId(id, "reportTemplateLabels"),
    status: "locked",
  };
}

/** `kind=report-candidate, name=<id>`. */
export function reportCandidateLabels(id: string): ReportLabels {
  return { kind: KIND_REPORT_CANDIDATE, name: requireBareId(id, "reportCandidateLabels") };
}

/** `kind=report, name=<id>`. */
export function reportLabels(id: string): ReportLabels {
  return { kind: KIND_REPORT, name: requireBareId(id, "reportLabels") };
}

/** `kind=report-amendment, name=<id>, status=proposed`. */
export function reportAmendmentLabels(id: string): ReportLabels {
  return {
    kind: KIND_REPORT_AMENDMENT,
    name: requireBareId(id, "reportAmendmentLabels"),
    status: "proposed",
  };
}

/**
 * `kind=report-amendment, name=<id>, status=accepted|rejected` — a HUMAN'S
 * DECISION on a proposal (W21, owner ruling 2026-08-26).
 *
 * Memories are append-only, so deciding is appending: the proposal keeps its
 * own row and its own provenance, and the decision is a second row of the same
 * kind carrying the deciding human's rationale as line 1 and an empty body.
 * Without it the accept path kept the MODEL's rationale (the proposal) and
 * discarded the HUMAN's, which inverts "agent proposes, human decides,
 * enforced by provenance".
 *
 * A sibling builder rather than a `status` parameter on
 * `reportAmendmentLabels`: that function's `status: "proposed"` is what the
 * § "Memory kinds" table pins for a PROPOSAL, and a caller able to pass any
 * status through it could mint a proposal-shaped row that never was one.
 *
 * ⚠️ The written row's provenance is EMPTY — Wolf's own credential writes it —
 * which is what distinguishes a decision a human made from anything a
 * container could append. `report-amendment` is not a trusted kind, so nothing
 * reads that automatically; a reader that cares must check it.
 */
export function reportDecisionLabels(
  id: string,
  decision: "accept" | "reject",
  amendmentId: string,
): ReportLabels {
  if (!LABEL_VALUE_PATTERN.test(amendmentId) || amendmentId.length > MAX_LABEL_VALUE_LENGTH) {
    throw new WolfError(
      "invalid",
      `reportDecisionLabels: ${JSON.stringify(amendmentId)} cannot be a label value, so a decision on it cannot be recorded or found again`,
      { details: { amendment_id: amendmentId } },
    );
  }
  return {
    kind: KIND_REPORT_AMENDMENT,
    name: requireBareId(id, "reportDecisionLabels"),
    status: decision === "accept" ? "accepted" : "rejected",
    [AMENDMENT_LABEL]: amendmentId,
  };
}

/**
 * The label naming WHICH proposal a decision decided.
 *
 * 🔴 **A label, not a line in the content, and that is the whole point.** The
 * question a route has to answer is "does a decision already exist for this
 * proposal", which is a QUERY — `kind=report-amendment,name=<id>,amendment=<memory-id>`
 * — and a selector can only see labels. Line 2 of a body is not selectable, so
 * a decision recorded there would be unfindable and a decided proposal could
 * be decided again for ever: accept B, accept C, re-accept B, and the frame
 * silently reverts to B's template with a fresh `status: accepted` row
 * asserting the human chose it (owner ruling 2026-08-26, fix round 2).
 *
 * The value is an Orange memory id. It must satisfy the K8s label charset —
 * `reportDecisionLabels` refuses one that does not, rather than writing a row
 * nothing can find.
 */
export const AMENDMENT_LABEL = "amendment";

/** The `status` label a row must carry to be DECIDABLE: it is a proposal and nothing else. */
export const AMENDMENT_STATUS_PROPOSED = "proposed";

/**
 * The selector for one hypothesis's rows of one kind.
 *
 * Kubernetes selector semantics exactly: `k=v` terms, comma means AND, no OR
 * and no nesting (§ "Environment facts"). `status=` is deliberately NOT part
 * of it: a selector that pins `status=locked` cannot see a row whose status
 * label was written differently, and "there is no template" would then be
 * indistinguishable from "the template is labelled oddly".
 */
export function reportSelector(kind: ReportMemoryKind, id: string): string {
  return `kind=${kind},name=${requireBareId(id, "reportSelector")}`;
}

// ── Line 1, and the character-boundary truncation ───────────────────────

/**
 * The headline cap. Note what it is NOT: the 500-character snippet cap.
 *
 * `GET /agent/memories` returns `substring(content, 1, 500)` on a `text`
 * column, which in Postgres is CHARACTER-based, not byte-based
 * (`go/agentdb/memories.go:451-452`), so the server cannot produce a
 * mid-multibyte split and nothing here defends against one. 400 is Wolf's own
 * headline limit, applied ON READ so that a researcher writing a 4KB first
 * line cannot push a wall of text into the board.
 */
export const HEADLINE_MAX_CHARS = 400;

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * Truncates to at most `HEADLINE_MAX_CHARS` **characters**, never splitting
 * one. `String.prototype.slice` counts UTF-16 code units, so slicing at 400
 * can cut a surrogate pair in half and yield a lone surrogate — an unpaired
 * `\uD83D` that JSON-encodes, reaches a browser, and renders as a replacement
 * character. `Array.from` iterates by code point, which is also the unit
 * Postgres counts in, so this measures the same thing the server does.
 */
export function truncateHeadline(raw: string, max: number = HEADLINE_MAX_CHARS): TruncatedText {
  const points = Array.from(raw);
  if (points.length <= max) return { text: raw, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}

/**
 * Splits a memory content into line 1 and everything after it. `\r\n` is
 * handled because an HTML fragment authored on Windows, or pasted through a
 * browser, arrives with CRLF and a stray `\r` on the end of a structure hash
 * makes the lock compare unequal for a reason nobody can see.
 */
export function splitFirstLine(content: string): { first: string; rest: string } {
  const newline = content.indexOf("\n");
  if (newline < 0) return { first: content.replace(/\r$/, ""), rest: "" };
  return {
    first: content.slice(0, newline).replace(/\r$/, ""),
    rest: content.slice(newline + 1),
  };
}

// ── `report-template` / `report-candidate` / `report-amendment` content ──

export interface TemplateContent {
  /** Line 1: the `structureHash` for a template, the summary for a candidate, the rationale for an amendment. */
  first: string;
  /** Everything after line 1: the template HTML fragment. */
  html: string;
}

function buildLineAndBody(first: string, body: string, where: string): string {
  const line = first.replace(/\r?\n[\s\S]*$/, "").trim();
  if (line === "") {
    throw new WolfError("invalid", `${where}: line 1 must not be empty`, { details: { first } });
  }
  return `${line}\n${body}`;
}

/** Line 1 is the `structureHash`; then the template HTML fragment. */
export function buildReportTemplateContent(input: { structureHash: string; html: string }): string {
  return buildLineAndBody(input.structureHash, input.html, "buildReportTemplateContent");
}

/** Line 1 is a summary; then the proposed template HTML. */
export function buildReportCandidateContent(input: { summary: string; html: string }): string {
  return buildLineAndBody(input.summary, input.html, "buildReportCandidateContent");
}

/** Line 1 is a rationale; then the proposed template HTML. */
export function buildReportAmendmentContent(input: { rationale: string; html: string }): string {
  return buildLineAndBody(input.rationale, input.html, "buildReportAmendmentContent");
}

/**
 * The inverse of the three builders above. It never throws on an empty body:
 * a template row whose HTML is missing is a real thing a human has to see and
 * fix, and refusing to parse it would surface as "no template" — which is the
 * one answer W21 must not give for a row that exists.
 */
export function parseTemplateContent(content: string): TemplateContent {
  const { first, rest } = splitFirstLine(content);
  return { first: first.trim(), html: rest };
}

// ── `report` content: a headline and a flat slot map ────────────────────

export interface ParsedReport {
  /** Line 1, truncated to `HEADLINE_MAX_CHARS` characters on READ. */
  headline: string;
  /** True when line 1 was longer than the cap — the UI must not claim it is complete. */
  headlineTruncated: boolean;
  /** `{slotId: html}`. Flat, and every value a string. */
  slots: Record<string, string>;
}

/** Line 1 is the headline; then `{slotId: html}` as JSON. */
export function buildReportContent(input: {
  headline: string;
  slots: Record<string, string>;
}): string {
  return buildLineAndBody(
    input.headline,
    JSON.stringify(input.slots, null, 2),
    "buildReportContent",
  );
}

function invalidBody(why: string, details: Record<string, unknown>): WolfError {
  return new WolfError("invalid", `report body: ${why}`, { details });
}

/**
 * Parses a `kind=report` memory's content.
 *
 * The body must be a **flat `Record<string, string>`** — one HTML fragment per
 * slot id and nothing else. Anything else is a typed `invalid` error NAMING
 * THE OFFENDING KEY, because the writer is a model: "the body is malformed"
 * sends a human reading the log looking through a 40KB JSON blob, while
 * "slot `chart-main` is an object, not a string" says what to fix.
 *
 * A `null` value is an error like any other non-string. R62's "explicit null
 * means ABSENT" rule is scoped to a `Spec`, `Metric`, `Method` or `Condition`
 * and does not reach here; a slot the researcher had nothing to say about is
 * omitted, and W20's drift detection is what reports it as unfilled.
 */
export function parseReportContent(content: string): ParsedReport {
  const { first, rest } = splitFirstLine(content);
  const headline = truncateHeadline(first.trim());

  const body = rest.trim();
  if (body === "") {
    throw invalidBody("empty — line 1 is the headline and the rest must be the slot JSON", {
      headline: headline.text,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new WolfError("invalid", "report body: not valid JSON", {
      details: { headline: headline.text },
      cause: err,
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidBody(
      `expected a flat {slotId: html} object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
      { headline: headline.text },
    );
  }

  const slots: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      const got = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
      throw invalidBody(
        `slot ${JSON.stringify(key)} is ${got}, not a string — the body must be a flat {slotId: html} map`,
        { key, headline: headline.text },
      );
    }
    slots[key] = value;
  }

  return { headline: headline.text, headlineTruncated: headline.truncated, slots };
}
