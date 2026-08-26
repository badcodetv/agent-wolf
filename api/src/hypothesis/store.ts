/**
 * The trusted store: how Agent Wolf reads and writes hypothesis state without
 * letting anything inside a container decide it.
 *
 * This file owns the trust primitives the rest of the product is graded
 * against — `TRUSTED_KINDS`, `isTrusted`, the session index, the retraction
 * rule and the `Tamper` shape. design/2026-08-20-agent-wolf.md § "The trust
 * model" (agent-orange repo) is the authority; the short version is:
 *
 *   Orange's memory is a genuine shared bus. It is project-scoped and
 *   append-only, there is no per-worker permission and no origin check, and
 *   labels are chosen entirely by the caller. A chat session holding the core
 *   MCP tools may do everything a worker may do — which includes appending
 *   `kind=hypothesis, status=confirmed`. Deep research on adversarial web
 *   content is this product's core activity, so "a prompt-injected page ends
 *   its own trial" is a live threat, not a thought experiment.
 *
 * Three clauses, all of which must hold, make a memory authoritative:
 *
 *   1. **Empty provenance.** `created_by_worker === "" && created_by_session === ""`.
 *      Provenance is stamped by the server from the caller's credential and a
 *      request body that tries to supply it is rejected 400 (O7), so this is
 *      unforgeable from inside a container.
 *   2. **A kind in `TRUSTED_KINDS`.** Necessary because empty provenance alone
 *      is not sufficient: `agentdb.ApplyTopology` also writes provenance-free
 *      seeds and is reachable by any API-class credential (R24).
 *   3. **A `name` that matches an existing `hyp-<id>` session.** This is the
 *      clause that cannot be forged from inside a container at all — creating
 *      a named session requires an API key or a console JWT.
 *
 * And two things that are NOT obvious:
 *
 * - **The authoritative index of hypotheses is the SESSION LIST, not memory.**
 *   Retraction is a stronger attack than forgery. `retracts` is an ordinary
 *   label and `notRetractedSQL` (`go/agentdb/memories.go:342-346`) correlates
 *   on the retracted row's id and project only — it never checks who wrote the
 *   retraction. So a session can hide Wolf's own state row from every default
 *   search path, and the hypothesis would simply vanish from a memory-derived
 *   board. The session list cannot be written from inside a container, so that
 *   is what Wolf enumerates.
 * - **Every read of hypothesis state carries `include_retracted=1`** — the
 *   board's one-request fast path included. Orange applies its retraction
 *   filter BEFORE the `latest_per` reduction, so without the flag a hostile
 *   retraction of Wolf's newest row does not hide the hypothesis: it promotes
 *   the OLDER trusted row beneath it, and the board silently rolls back to a
 *   status Wolf had already moved on from. See `readBoard` for the recorded
 *   proof (`__fixtures__/board-resurrection-*.json`, the same query with and
 *   without the flag).
 * - **A row counts as retracted iff AT LEAST ONE retraction of it has empty
 *   provenance** (owner decision B5). Reading only the newest retraction lets
 *   an attacker RESURRECT state Wolf legitimately withdrew, by appending their
 *   own retraction on top of Wolf's: the reader discards that single untrusted
 *   retractor and the withdrawn row comes back. O11 returns every retraction
 *   for exactly this reason.
 *
 * Ids are the **bare** 8 lowercase hex characters. The `hyp-` prefix belongs to
 * the session name and to nothing else (§ "Vocabulary"); an earlier draft
 * produced `hyp-hyp-<id>`, under which clause 3 never matches and every
 * hypothesis reads as untrusted.
 */

import { createHash, randomBytes } from "node:crypto";

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type {
  DeliveryRecord,
  MemoryRecord,
  MemoryRetraction,
  MemorySearchResultRow,
  SessionListRow,
  UnixMs,
  UnixSec,
} from "../orange/types.js";
import type { ListMemoriesParams, ListSessionsParams, OrangeClient } from "../orange/client.js";
// The ONE sanctioned plain-number -> UnixMs conversion. W4's `EvaluationResult`
// types its own timestamps with a plain `number` alias, so every value that
// crosses from an evaluation into this module's branded `UnixMs` goes through
// here rather than through a cast.
import { toMs } from "../orange/types.js";
import type { EvaluationResult, Reason } from "./evaluate.js";
import {
  KeyedMutex,
  createTransitioner,
  type HypothesisStatus,
  type TransitionOutcome,
  type Transitioner,
  isHypothesisStatus,
} from "./lifecycle.js";
// ⚠️ `../report/kinds.ts` imports the trust primitives FROM this file, so these
// two modules form an import cycle. It is safe and it is deliberate — R48
// settled that W5 defines the trust primitives and W15's `kinds.ts` re-exports
// them rather than declaring a second `TRUSTED_KINDS` — but it holds only
// while NEITHER side reads a value from the other at module-evaluation time.
// Everything imported here is used inside a function body; nothing below is a
// top-level `const x = KIND_REPORT`. Keep it that way: a top-level read is a
// TDZ crash whose stack blames whichever module the test runner happened to
// load first, which is the worst kind of bug to inherit.
import {
  KIND_REPORT,
  KIND_REPORT_TEMPLATE,
  parseReportContent,
  parseTemplateContent,
  reportSelector,
  truncateHeadline,
  type ParsedReport,
} from "../report/kinds.js";
// ⚠️ The SECOND deliberate cycle, on exactly the same terms (W22).
// `./provision.ts` imports the trust primitives from this file; this file
// imports one pure string function back. `researcherWorkerFor` is an
// `export function`, so it is HOISTED and available even when provision.ts is
// the module that loaded first and this one is still evaluating — a
// `const` would be in its temporal dead zone there and crash. It is called
// only inside function bodies below, never at module evaluation.
//
// The alternative was a second `"researcher-"` literal here, and the worker
// name is the first clause of the cross-hypothesis rule: two copies that
// drift make every report look forged, or none.
import { researcherWorkerFor } from "./provision.js";

// ── The trusted-kind set ────────────────────────────────────────────────

/**
 * ENUMERATED, NEVER COUNTED. An earlier draft of the plan said "the five
 * kinds" while its own vocabulary listed six; an executor enumerating the
 * wrong set makes every memory the poller writes untrusted, the board silently
 * shows no `support_score`, and no test anywhere fails. If you add a kind,
 * add it to this list — do not write down how many there are.
 */
export const TRUSTED_KIND_LIST = Object.freeze([
  "hypothesis",
  "hypothesis-spec",
  "verdict",
  "evaluation",
  "report-template",
] as const);

export type TrustedKind = (typeof TRUSTED_KIND_LIST)[number];

/**
 * `Object.freeze` on a `Set` does not stop `.add()` — freezing affects
 * properties, and a Set's members live in an internal slot. So the mutators
 * are shadowed with own properties that throw, and THEN the object is frozen.
 * The `ReadonlySet` type is the compile-time half; this is the runtime half.
 */
function frozenSet<T>(values: readonly T[]): ReadonlySet<T> {
  const set = new Set<T>(values);
  const refuse = (op: string) => () => {
    throw new TypeError(`this set is frozen (${op} is not available)`);
  };
  Object.defineProperties(set, {
    add: { value: refuse("add") },
    delete: { value: refuse("delete") },
    clear: { value: refuse("clear") },
  });
  return Object.freeze(set);
}

/** The five kinds only Wolf itself may write. See the file header, clause 2. */
export const TRUSTED_KINDS: ReadonlySet<string> = frozenSet<string>(TRUSTED_KIND_LIST);

// ── Tamper ──────────────────────────────────────────────────────────────

/**
 * Pinned byte for byte by § "Shared shapes that four or more tickets must
 * agree on". Snake_case because W8's board, W13's banner, W14's detail page
 * and X1's `tamper-resistance.spec.ts` all read it off the wire.
 *
 * `memory_id` is the **offending** row — the forged state row, or the hostile
 * retraction — never the trusted one it attacked.
 *
 * ⚠️ The plan says "exactly one of the two provenance fields is non-empty".
 * Orange does not produce that, and the recorded fixtures show it: the MCP
 * caller's `SessionID` is always set for anything written from inside a
 * container, and `Worker` is set as well whenever that session HAS a worker
 * (`go/cmd/agentd/mcpserver.go:534`) — which covers every researcher tick AND
 * every interview session, since those are created with `worker: "interviewer"`.
 * `__fixtures__/detail-2b3c4d5e-include-retracted.json` carries
 * `created_by_worker: "researcher-2b3c4d5e"` and
 * `created_by_session: "sess-b31f0c9a"` on the same row. The invariant that
 * holds is **at least one** non-empty, which is all a reader needs: non-empty
 * provenance is what "not the application's own word" means. A UI rendering
 * this must be prepared to name both.
 */
export interface Tamper {
  reason: "forged_row" | "hostile_retraction" | "cross_hypothesis_write";
  written_by_worker: string;
  written_by_session: string;
  memory_id: string;
}

// ── Ids and session names ───────────────────────────────────────────────

/** A hypothesis id is 8 lowercase hex characters, and is never prefixed. */
export const HYPOTHESIS_ID_PATTERN = /^[0-9a-f]{8}$/;

/** The prefix, written down exactly once in this codebase. */
export const SESSION_NAME_PREFIX = "hyp-";

/** A session name for a hypothesis: the prefix plus a bare id. */
export const SESSION_NAME_PATTERN = /^hyp-[0-9a-f]{8}$/;

/** Generated, never derived from user text. */
export function newHypothesisId(): string {
  return randomBytes(4).toString("hex");
}

export function isHypothesisId(value: string): boolean {
  return HYPOTHESIS_ID_PATTERN.test(value);
}

/**
 * The ONE place the prefix is added. It refuses an already-prefixed id rather
 * than producing `hyp-hyp-…`, which is the failure that makes the trust rule's
 * session clause never match and every hypothesis read as untrusted.
 */
export function sessionNameForHypothesis(id: string): string {
  if (id.startsWith(SESSION_NAME_PREFIX)) {
    throw new WolfError(
      "invalid",
      `hypothesis id ${JSON.stringify(id)} is already prefixed — ids are bare 8-hex and the "${SESSION_NAME_PREFIX}" prefix belongs to the session name only`,
      { details: { id } },
    );
  }
  if (!isHypothesisId(id)) {
    throw new WolfError("invalid", `not a hypothesis id: ${JSON.stringify(id)}`, {
      details: { id },
    });
  }
  return SESSION_NAME_PREFIX + id;
}

/** The inverse. Returns null for any name that is not a hypothesis session. */
export function hypothesisIdFromSessionName(name: string | undefined): string | null {
  if (name === undefined) return null;
  if (!SESSION_NAME_PATTERN.test(name)) return null;
  return name.slice(SESSION_NAME_PREFIX.length);
}

// ── The owner slug ──────────────────────────────────────────────────────

/** `go/agentdb/labels.go:33-34`. Every label value must match this. */
export const LABEL_VALUE_PATTERN = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
export const MAX_LABEL_VALUE_LENGTH = 63;

/**
 * Email address → legal Orange label value. **Total**: every possible input
 * yields a legal label, because a mapping with a hole is a 500 on somebody's
 * first login.
 *
 * The steps are the plan's, in the plan's order: lowercase, `@` → `-at-`,
 * every remaining character outside `[a-z0-9._-]` → `-`, collapse runs of `-`,
 * trim to 63, strip leading/trailing non-alphanumerics — and if what is left is
 * empty or does not begin with `[a-z0-9]`, prefix `u-` and append the first 8
 * hex characters of the SHA-256 of the lowercased address, which is both legal
 * and stable for that address.
 *
 * The FULL address is never in a label; it lives in the memory content.
 */
export function slugifyOwner(email: string): string {
  const lower = email.toLowerCase();
  let slug = lower
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, MAX_LABEL_VALUE_LENGTH)
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (slug === "" || !/^[a-z0-9]/.test(slug)) {
    const digest = createHash("sha256").update(lower).digest("hex").slice(0, 8);
    slug = `u-${slug}${digest}`.slice(0, MAX_LABEL_VALUE_LENGTH).replace(/[^a-z0-9]+$/, "");
  }
  return slug;
}

// ── Snippets and titles ─────────────────────────────────────────────────

/**
 * `GET /agent/memories` returns `substring(content, 1, 500)` on a `text`
 * column, which in Postgres is **character**-based, not byte-based
 * (`go/agentdb/memories.go:35,451-452`). So a snippet is at most 500
 * CHARACTERS and may be well over 500 bytes of UTF-8 — the captured fixture
 * `__fixtures__/snippet-truncation.json` has a body of 500 characters and 1500
 * bytes. A mid-character split is not constructible: the server cannot produce
 * one, so nothing here defends against it.
 */
export const SNIPPET_MAX_CHARS = 500;

export interface ParsedTitle {
  /** Line 1 of the content, as far as the snippet reaches. */
  title: string;
  /**
   * True when line 1 was cut by the snippet, so the UI must not present the
   * title as complete.
   */
  truncated: boolean;
}

/**
 * Line 1 of the content is the title (§ "Memory kinds"). It is parsed back out
 * of the 500-character snippet, because the board read returns labels and a
 * snippet and no `content` field at all — rendering the board any other way
 * costs one full read per hypothesis.
 */
export function parseTitleFromSnippet(snippet: string): ParsedTitle {
  const newline = snippet.indexOf("\n");
  if (newline >= 0) {
    // The snippet reached the end of line 1, so the title is complete however
    // long the rest of the content is.
    return { title: snippet.slice(0, newline), truncated: false };
  }
  // No newline: either the content is one short line, or line 1 ran past the
  // snippet's 500 characters and was cut.
  return { title: snippet, truncated: snippet.length >= SNIPPET_MAX_CHARS };
}

// ── Memory content ──────────────────────────────────────────────────────

/**
 * A `kind=hypothesis` memory's content: line 1 is the title, then the prose
 * thesis, then — for `challenged` and terminal rows — the evaluation snapshot
 * as fenced JSON (§ "Memory kinds", § "Snapshotting, because the reaper will
 * delete the evidence": the memory is the permanent record, the dataset is
 * working storage).
 *
 * The fenced block also carries `owner_email`, because the full address may
 * never be a label value and this is the only other place a row can hold it.
 */
export interface HypothesisContent {
  title: string;
  thesis: string;
  ownerEmail: string | null;
  evaluation: EvaluationResult | null;
  /** Free text a human gave with a verdict, an amendment or a retirement. */
  rationale: string | null;
}

interface HypothesisContentBlock {
  owner_email?: string;
  rationale?: string;
  evaluation?: EvaluationResult;
}

const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

export function buildHypothesisContent(input: {
  title: string;
  thesis?: string;
  ownerEmail?: string;
  evaluation?: EvaluationResult | null;
  rationale?: string | null;
}): string {
  const title = input.title.replace(/\r?\n[\s\S]*$/, "").trim();
  if (title === "") {
    throw new WolfError("invalid", "a hypothesis needs a title: line 1 of the memory content");
  }
  const block: HypothesisContentBlock = {};
  if (input.ownerEmail !== undefined && input.ownerEmail !== "") block.owner_email = input.ownerEmail;
  if (input.rationale !== undefined && input.rationale !== null && input.rationale !== "") {
    block.rationale = input.rationale;
  }
  if (input.evaluation !== undefined && input.evaluation !== null) block.evaluation = input.evaluation;

  const parts = [title];
  const thesis = (input.thesis ?? "").trim();
  if (thesis !== "") parts.push(thesis);
  if (Object.keys(block).length > 0) {
    parts.push(`${FENCE_OPEN}\n${JSON.stringify(block, null, 2)}\n${FENCE_CLOSE}`);
  }
  return parts.join("\n\n");
}

/**
 * The inverse of `buildHypothesisContent`, and deliberately forgiving: a row
 * whose fenced block is absent or unparseable still yields a title and a
 * thesis. A state row that cannot be READ is a hypothesis that cannot be
 * transitioned, so this never throws on shape.
 */
export function parseHypothesisContent(content: string): HypothesisContent {
  const lines = content.split("\n");
  const title = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n");
  let ownerEmail: string | null = null;
  let evaluation: EvaluationResult | null = null;
  let rationale: string | null = null;
  let thesis = rest;

  const fenceStart = rest.indexOf(FENCE_OPEN);
  if (fenceStart >= 0) {
    const bodyStart = fenceStart + FENCE_OPEN.length;
    const fenceEnd = rest.indexOf(FENCE_CLOSE, bodyStart);
    const body = fenceEnd >= 0 ? rest.slice(bodyStart, fenceEnd) : rest.slice(bodyStart);
    thesis = rest.slice(0, fenceStart);
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object") {
        const block = parsed as HypothesisContentBlock;
        if (typeof block.owner_email === "string") ownerEmail = block.owner_email;
        if (typeof block.rationale === "string") rationale = block.rationale;
        if (block.evaluation !== undefined) evaluation = block.evaluation;
      }
    } catch {
      // A malformed block is evidence, not a crash: the title and thesis above
      // it are still readable and still what the UI renders.
    }
  }
  return { title, thesis: thesis.trim(), ownerEmail, evaluation, rationale };
}

// ── The evaluation summary line ─────────────────────────────────────────

/**
 * `kind=evaluation`'s FIRST LINE, parsed. There is exactly ONE parser for it
 * and it lives here (a W8 acceptance criterion): W10's poller writes the line
 * and W8's board reads it, and a second copy in `routes/hypotheses.ts` is how
 * the two silently drift apart.
 *
 * Why the board reads a line of text at all, rather than a number on the
 * hypothesis row: `support_score` cannot live on the state memory (a `live`
 * hypothesis's newest trusted row is its go-live row, and the board read
 * returns labels plus a 500-byte snippet and no content), it cannot be a
 * label (`support_score=-0.42` is an ILLEGAL label value — values must begin
 * alphanumeric — and a poller rewriting the row every 5 minutes would drown
 * `latest_per`), and reading each hypothesis's dataset from the board route
 * is N×M fetches to paint one page. See § "Where the board's numbers come
 * from".
 */
export interface EvaluationSummaryLine {
  /** −1 … +1. Displayed; it never trips anything — only conditions do. */
  supportScore: number;
  tripped: number;
  holding: number;
  indeterminate: number;
  /** `evaluated=<RFC3339>` converted to unix ms. */
  evaluatedAtMs: UnixMs;
}

/** One board row's evaluation, with the memory it was read from. */
export interface EvaluationSummary extends EvaluationSummaryLine {
  memoryId: string;
  /** When the memory was appended (unix ms) — NOT `evaluated=`, which is the
   * moment the evaluator ran. They differ whenever the poller suppresses a
   * duplicate row. */
  createdAtMs: UnixMs;
}

/** The five keys the line must carry. Enumerated, never counted. */
const EVALUATION_SUMMARY_KEYS = ["score", "tripped", "holding", "indeterminate", "evaluated"] as const;

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parses `score=-0.42 tripped=1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z`.
 *
 * All five keys are REQUIRED; **unrecognised `key=value` tokens are ignored
 * rather than rejected**, so W10 can extend the line without breaking the
 * board. A line that does not parse yields `null` — the caller renders
 * `support_score: null` and no conditions summary — and this function NEVER
 * throws: a row Wolf cannot read is a hypothesis that still has to appear on
 * the board.
 *
 * The first occurrence of a key wins, so a second `score=` appended after the
 * fact cannot override the leading one.
 */
export function parseEvaluationSummaryLine(line: string): EvaluationSummaryLine | null {
  const found = new Map<string, string>();
  for (const token of line.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (found.has(key)) continue;
    found.set(key, token.slice(eq + 1));
  }
  for (const key of EVALUATION_SUMMARY_KEYS) {
    if (!found.has(key)) return null;
  }
  const score = Number(found.get("score"));
  if (!Number.isFinite(score)) return null;
  const tripped = parseCount(found.get("tripped"));
  const holding = parseCount(found.get("holding"));
  const indeterminate = parseCount(found.get("indeterminate"));
  if (tripped === null || holding === null || indeterminate === null) return null;
  const evaluatedAtMs = Date.parse(found.get("evaluated") ?? "");
  if (!Number.isFinite(evaluatedAtMs)) return null;
  return {
    supportScore: score,
    tripped,
    holding,
    indeterminate,
    evaluatedAtMs: evaluatedAtMs as UnixMs,
  };
}

// ── Writing the evaluation memory (W10) ─────────────────────────────────

/**
 * One derived attention entry (W10). Raised when the SAME condition id has
 * been `indeterminate` in three consecutive `kind=evaluation` memories.
 *
 * There is deliberately no counter field anywhere: the run length is derived
 * from the last three memories on every tick, which is what makes a restart
 * not reset it.
 */
export interface AttentionEntry {
  condition_id: string;
  /** W4's closed `Reason` vocabulary, never a free string. `null` is legal. */
  reason: Reason | null;
  /** When the run started — the first evaluation in it. Unix MILLISECONDS. */
  since_ms: UnixMs;
}

/**
 * The JSON body of a `kind=evaluation` memory: W4's `EvaluationResult`
 * verbatim, plus `attention` when — and only when — the poller derived some.
 *
 * `attention` is an ADDITION to the pinned shape, not a change to it: W8's
 * summary-line parser ignores unrecognised `key=value` tokens and W4's own
 * consumers read named fields, so an absent key and an empty array must not
 * both be written. Absent means "nothing to raise".
 */
export interface EvaluationSnapshot extends EvaluationResult {
  attention?: AttentionEntry[];
}

/** The condition-state tally the summary line carries. */
export interface ConditionTally {
  tripped: number;
  holding: number;
  indeterminate: number;
}

export function tallyConditions(evaluation: EvaluationResult): ConditionTally {
  const tally: ConditionTally = { tripped: 0, holding: 0, indeterminate: 0 };
  for (const condition of evaluation.conditions) {
    if (condition.state === "tripped") tally.tripped += 1;
    else if (condition.state === "holding") tally.holding += 1;
    else tally.indeterminate += 1;
  }
  return tally;
}

/** RFC3339 in UTC with whole seconds — the spelling § "Where the board's
 * numbers come from" prints in the summary line, and the one the canonical
 * dataset CSV uses. `toISOString()` alone would append `.000`. */
export function toRfc3339Seconds(ms: UnixMs): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** How many decimals `score=` carries. Two, as § "Where the board's numbers
 * come from" prints it — and deliberately fewer than the JSON body's exact
 * value, so float noise in the last bits cannot make an unchanged evaluation
 * look like a changed one and append a memory every five minutes. */
const SCORE_DECIMALS = 2;

/**
 * Line 1 of a `kind=evaluation` memory:
 *
 * ```
 * score=-0.42 tripped=1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z
 * ```
 *
 * ...with ` attention=<n>` APPENDED when the poller derived attention, `<n>`
 * being the number of conditions raising it. Appending to line 1 is not
 * cosmetic: the memory is written only when this line changes, so if
 * attention did not alter the line, the write that carries the attention
 * would be suppressed by the very rule that keeps a quiet hypothesis to one
 * row a day.
 *
 * `parseEvaluationSummaryLine` (above) is the only reader, and it ignores
 * unrecognised tokens — which is what makes this extension safe.
 */
export function formatEvaluationSummaryLine(input: {
  supportScore: number;
  tripped: number;
  holding: number;
  indeterminate: number;
  evaluatedAtMs: UnixMs;
  /** Omitted, or 0, when nothing is raised: no token is emitted. */
  attention?: number;
}): string {
  // `-0` prints as "0.00" through toFixed, which is what we want: a score of
  // negative zero is zero, and the JSON body carries the exact value anyway.
  const score = input.supportScore.toFixed(SCORE_DECIMALS);
  const parts = [
    `score=${score}`,
    `tripped=${input.tripped}`,
    `holding=${input.holding}`,
    `indeterminate=${input.indeterminate}`,
    `evaluated=${toRfc3339Seconds(input.evaluatedAtMs)}`,
  ];
  if (input.attention !== undefined && input.attention > 0) {
    parts.push(`attention=${input.attention}`);
  }
  return parts.join(" ");
}

/** The summary line for a whole snapshot — the one call site both the writer
 * and its tests use, so the tally and the line cannot disagree. */
export function evaluationSummaryLine(snapshot: EvaluationSnapshot): string {
  const tally = tallyConditions(snapshot);
  return formatEvaluationSummaryLine({
    supportScore: snapshot.support_score,
    ...tally,
    evaluatedAtMs: toMs(snapshot.evaluated_at_ms),
    attention: snapshot.attention?.length ?? 0,
  });
}

/**
 * The summary line with its `evaluated=` token removed — the part that
 * carries MEANING rather than the clock.
 *
 * This is the comparison the "append only when the summary line differs"
 * rule actually uses, and it has to be: `evaluated=` is `Date.now()` on every
 * tick, so comparing whole lines would make every tick a change and append
 * 288 rows a day for a hypothesis nothing happened to — the exact outcome the
 * rule exists to prevent (§ "Where the board's numbers come from": "a quiet
 * hypothesis produces one row a day, not 288").
 */
export function evaluationLineWithoutTimestamp(line: string): string {
  return line
    .trim()
    .split(/\s+/)
    .filter((token) => !token.startsWith("evaluated="))
    .join(" ");
}

/**
 * A `kind=evaluation` memory's content: the summary line, then the full
 * snapshot as JSON (§ "Memory kinds": "Line 1 is the summary line ... then the
 * full evaluation snapshot as JSON").
 */
export function buildEvaluationContent(snapshot: EvaluationSnapshot): string {
  return `${evaluationSummaryLine(snapshot)}\n${JSON.stringify(snapshot, null, 2)}`;
}

/**
 * The inverse, and deliberately forgiving in the same way
 * `parseHypothesisContent` is: a body that does not parse still yields line 1,
 * because a row Wolf cannot fully read is still a row the board has to render.
 */
export function parseEvaluationContent(content: string): {
  line: string;
  snapshot: EvaluationSnapshot | null;
} {
  const newline = content.indexOf("\n");
  const line = (newline < 0 ? content : content.slice(0, newline)).trim();
  const rest = newline < 0 ? "" : content.slice(newline + 1);
  const start = rest.indexOf("{");
  const end = rest.lastIndexOf("}");
  if (start < 0 || end <= start) return { line, snapshot: null };
  try {
    const parsed: unknown = JSON.parse(rest.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object") return { line, snapshot: null };
    return { line, snapshot: parsed as EvaluationSnapshot };
  } catch {
    return { line, snapshot: null };
  }
}

// ── The in-flight exclusion (R112) ──────────────────────────────────────

/**
 * The two delivery statuses that mean "a container may be running right now".
 *
 * `pending` is queued-but-not-dispatched and `running` is executing; every
 * other status is terminal history. Enumerated, never expressed as
 * `!isTerminal(...)`: a new status added to Orange must be classified
 * deliberately rather than inherited as "in flight" or "safe to delete"
 * depending on which way the negation happened to fall.
 */
export const IN_FLIGHT_DELIVERY_STATUSES: readonly string[] = Object.freeze([
  "pending",
  "running",
]);

/**
 * **The ONE in-flight exclusion, shared by W10's tick-session sweep and W9's
 * teardown step 4 (R112).**
 *
 * The rule: *never delete a session that is the `session_id` of a delivery
 * currently `pending` or `running` for that worker.*
 *
 * Both callers need it for the same reason. Orange has no "completed" session
 * status — a finished tick session reads `running`/`active` for up to the
 * 30-minute idle timeout and `archived` only afterwards — so a status filter
 * either sweeps nothing on a stack with a long idle timeout or deletes a
 * session that is at that moment mid-`dataset_put`. The delivery log is the
 * only place that says whether a container is actually working.
 *
 * W9 shipped teardown step 4 literally ("delete every row it returns")
 * because it was never given this predicate, which contradicted its own
 * neighbouring rule that "a tick session still in flight is allowed to
 * finish": a `/verdict` or `/retire` issued while a tick is running could
 * delete that tick's session row out from under it. W10 has to write the
 * predicate anyway, so it lands here — once — and both call sites import it.
 *
 * `worker` filtering is CLIENT-SIDE by necessity: `agentdb.DeliveryQuery` has
 * no `worker` field (`go/agentdb/events.go:296-307`) although the row itself
 * does (`EventDelivery.Worker`, `go/agentdb/events.go:263`).
 */
export function inFlightSessionIds(
  deliveries: readonly DeliveryRecord[],
  worker: string,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const delivery of deliveries) {
    if (delivery.worker !== worker) continue;
    if (!IN_FLIGHT_DELIVERY_STATUSES.includes(delivery.status)) continue;
    // A pending delivery has not started a session yet and carries "";
    // adding it would exclude every session whose id is the empty string,
    // which is none, but it would also make the set's size lie.
    if (delivery.sessionId === "") continue;
    out.add(delivery.sessionId);
  }
  return out;
}

// ── The session index ───────────────────────────────────────────────────

export interface SessionIndexEntry {
  /** The bare 8-hex hypothesis id. */
  id: string;
  /** The Orange session id (a uuid-ish hex string), for W8's `atoms`. */
  sessionId: string;
  /** The session name — always `hyp-<id>`. */
  sessionName: string;
  status: string;
  createdAtSec: UnixSec;
  updatedAtSec: UnixSec;
}

/** Keyed by BARE id, which is also the `name` label on every memory. */
export type SessionIndex = ReadonlyMap<string, SessionIndexEntry>;

/** The worker every hypothesis chat session is created with (§ "Orange atoms"). */
export const INTERVIEWER_WORKER = "interviewer";

/** One page of the session walk. Orange's own default is 50, its cap is higher. */
export const SESSION_PAGE_SIZE = 200;

// ── isTrusted ───────────────────────────────────────────────────────────

/** The provenance-bearing subset of a memory row, in either shape. */
export interface ProvenancedMemory {
  labels: Record<string, string>;
  createdByWorker: string;
  createdBySession: string;
}

/** Anything that can answer "is there a session for this hypothesis id". */
export interface SessionLookup {
  has(id: string): boolean;
}

/** Clause 1 on its own — exported because the retraction rule needs it too. */
export function hasEmptyProvenance(row: {
  createdByWorker: string;
  createdBySession: string;
}): boolean {
  return row.createdByWorker === "" && row.createdBySession === "";
}

/**
 * All three clauses of § "The trust model". A memory passing only the first
 * two is NOT trusted: that is the `ApplyTopology` forgery path (R24), and the
 * session clause is the one that cannot be forged from inside a container.
 */
export function isTrusted(memory: ProvenancedMemory, sessions: SessionLookup): boolean {
  if (!hasEmptyProvenance(memory)) return false;
  const kind = memory.labels["kind"];
  if (kind === undefined || !TRUSTED_KINDS.has(kind)) return false;
  const name = memory.labels["name"];
  if (name === undefined) return false;
  return sessions.has(name);
}

/** The `Tamper` for a row something inside a container wrote. */
export function forgedRowTamper(row: {
  id: string;
  createdByWorker: string;
  createdBySession: string;
}): Tamper {
  return {
    reason: "forged_row",
    written_by_worker: row.createdByWorker,
    written_by_session: row.createdBySession,
    memory_id: row.id,
  };
}

/** The `Tamper` for a retraction something inside a container wrote. */
export function hostileRetractionTamper(retraction: MemoryRetraction): Tamper {
  return {
    reason: "hostile_retraction",
    written_by_worker: retraction.createdByWorker,
    written_by_session: retraction.createdBySession,
    memory_id: retraction.memoryId,
  };
}

/**
 * The newest row that is trusted AND that Wolf itself has not withdrawn.
 *
 * A retraction whose own provenance is NON-empty is ignored: an untrusted
 * actor cannot withdraw server-written state (§ "Retraction"). Exported so
 * the provisioner and the poller share one definition of "the current
 * trusted row of this kind" — two copies is how the two tickets end up
 * disagreeing about whether a hostile retraction hid a locked spec.
 */
export function newestTrustedRow(
  rows: readonly MemorySearchResultRow[],
  sessions: SessionLookup,
): MemorySearchResultRow | undefined {
  for (const row of rows) {
    if (!isTrusted(row, sessions)) continue;
    if ((row.retractedBy ?? []).some(hasEmptyProvenance)) continue;
    return row;
  }
  return undefined;
}

// ── Cross-hypothesis defence (W22) ──────────────────────────────────────

/**
 * `kind=report` is UNTRUSTED BY CONSTRUCTION — a researcher inside a container
 * is what writes it — so `isTrusted` cannot be the rule for it: every
 * legitimate report has non-empty provenance and would fail clause 1.
 *
 * The rule that CAN be applied is a different one, and it is the whole reason
 * W22 exists. **Labels are chosen entirely by the caller.** A prompt-injected
 * researcher session running for hypothesis A may append
 * `kind=report, name=B` — a perfectly well-formed row, in the right kind, with
 * another hypothesis's name on it — and own B's headline and B's report panel.
 * Nothing in the trust model as W5 left it says otherwise, because the trust
 * model is about rows Wolf itself writes and this is not one.
 *
 * So a report is *this* hypothesis's own when its provenance names one of the
 * two things that only this hypothesis has:
 *
 *   1. its own daily researcher worker, `researcher-<id>`; or
 *   2. its own `hyp-<id>` interview session, by Orange session id.
 *
 * Both are stamped by the server from the caller's credential (O7) and neither
 * is settable from a request body, so neither is forgeable from inside a
 * container. Anything else is IGNORED for state and reported as
 * `cross_hypothesis_write` — never rendered, never silently dropped.
 */
export interface ReportOwner {
  /** `researcher-<id>` — the worker this hypothesis's daily tick runs as. */
  worker: string;
  /**
   * The `hyp-<id>` session's Orange id, or `null` when the lookup in hand
   * cannot say. `null` does not weaken clause 1; it removes clause 2, which
   * is why every caller here passes a lookup that can answer.
   */
  sessionId: string | null;
}

/**
 * The `hyp-<id>` session's Orange id, out of whatever session lookup the
 * caller supplied.
 *
 * Three shapes legitimately reach the report reads and all three are handled
 * here rather than at three call sites:
 *
 *   - a full `SessionIndex` (`Map<string, SessionIndexEntry>`) — what
 *     `readSessionIndex` returns and what `routes/report.ts` passes;
 *   - a `Map<string, string | null>` of session ids — what the board and the
 *     detail route build, since a `HypothesisRecord` already carries
 *     `sessionId` and re-walking the session list for it would be a second
 *     index read per request;
 *   - a bare `Set<string>` — which knows only that the hypothesis exists.
 *
 * `null` means "this lookup cannot say", never "there is no session".
 * `Set.prototype` has no `get`, which is what makes the duck-type safe.
 */
export function sessionIdFrom(sessions: SessionLookup, id: string): string | null {
  const get = (sessions as { get?: (key: string) => unknown }).get;
  if (typeof get !== "function") return null;
  const value: unknown = get.call(sessions, id);
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "object" && value !== null && "sessionId" in value) {
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
  }
  return null;
}

/** The two clauses, resolved once per hypothesis rather than once per row. */
export function reportOwnerFor(id: string, sessions: SessionLookup): ReportOwner {
  return { worker: researcherWorkerFor(id), sessionId: sessionIdFrom(sessions, id) };
}

/**
 * Clause 1 OR clause 2. An empty provenance field never matches: `""` is what
 * Orange stamps when there is no worker or no session, so comparing it to a
 * `null`/absent owner value would make an unattributed row look owned.
 */
export function isOwnReport(memory: ProvenancedMemory, owner: ReportOwner): boolean {
  if (memory.createdByWorker !== "" && memory.createdByWorker === owner.worker) return true;
  if (
    owner.sessionId !== null &&
    memory.createdBySession !== "" &&
    memory.createdBySession === owner.sessionId
  ) {
    return true;
  }
  return false;
}

/**
 * The key under which a failed report-body parse carries the anomalies that
 * were witnessed BEFORE the body was read. See `reportTamperFrom`.
 */
const TAMPER_DETAIL_KEY = "tamper";

/**
 * The anomalies a `readLatestReport` failure witnessed on its way to failing.
 *
 * 🔴 This exists because of a real defect, and the defect was invisible from
 * either side alone. `readLatestReport` picks the surviving row FIRST —
 * reporting every forged, foreign or hostilely-retracted row it stepped over
 * — and only then fetches and parses the winner's body. A body a model wrote
 * badly throws `invalid`. A caller that degrades on that throw (the detail
 * route must, or untrusted content takes the verdict buttons away) would
 * otherwise discard a `cross_hypothesis_write` it had ALREADY found: the
 * board would warn and the detail page would show a benign empty state, and
 * the two surfaces would disagree in the direction that hides an attack.
 *
 * Defensive on every step because it reads a `details` bag: `[]` for an error
 * that carries none, for a non-`WolfError`, and for anything whose `tamper`
 * is not an array.
 */
export function reportTamperFrom(err: unknown): Tamper[] {
  if (!(err instanceof WolfError)) return [];
  const details = err.details;
  if (typeof details !== "object" || details === null) return [];
  const carried = (details as Record<string, unknown>)[TAMPER_DETAIL_KEY];
  return Array.isArray(carried) ? (carried as Tamper[]) : [];
}

/**
 * Re-throws `err` with `tamper` attached, preserving its kind, status,
 * message and existing details.
 *
 * A new error rather than a mutation: `WolfError`'s fields are `readonly`,
 * and an error object that grew a property between two catch sites is exactly
 * the kind of action at a distance this file exists to avoid.
 */
function withReportTamper(err: unknown, tamper: readonly Tamper[]): unknown {
  if (!(err instanceof WolfError) || tamper.length === 0) return err;
  const existing = typeof err.details === "object" && err.details !== null ? err.details : {};
  return new WolfError(err.kind, err.message, {
    status: err.status,
    details: { ...existing, [TAMPER_DETAIL_KEY]: [...tamper] },
    cause: err,
  });
}

/**
 * The `Tamper` for a report row belonging to some other hypothesis — or to
 * nothing at all, which is the same answer: its provenance does not name this
 * hypothesis's researcher or its session, so it is not evidence about this
 * hypothesis and must not be rendered as if it were.
 */
export function crossHypothesisTamper(row: {
  id: string;
  createdByWorker: string;
  createdBySession: string;
}): Tamper {
  return {
    reason: "cross_hypothesis_write",
    written_by_worker: row.createdByWorker,
    written_by_session: row.createdBySession,
    memory_id: row.id,
  };
}

// ── The hypothesis record ───────────────────────────────────────────────

export interface HypothesisRecord {
  /** The bare 8-hex id. */
  id: string;
  /** `hyp-<id>`; the prefix appears here and nowhere else. */
  sessionName: string;
  sessionId: string | null;
  /** Line 1 of the trusted state row's content, from its snippet. */
  title: string | null;
  /** True when the snippet cut line 1 — the UI must not claim it is complete. */
  titleTruncated: boolean;
  /** The owner SLUG from the label; the full address lives in the content. */
  owner: string | null;
  /** null when no trusted state row survives — an anomaly, never a drop. */
  status: HypothesisStatus | null;
  /** The trusted state row's memory id, for a full-content read. */
  statusMemoryId: string | null;
  updatedAtMs: UnixMs | null;
  /** Optional label carried forward across a re-roll (§ "Memory kinds"). */
  restatedFrom: string | null;
  /** Present only when something was detected; W8 passes it through unmodified. */
  tamper?: Tamper[];
}

// ── The report layer's reads (W15) ──────────────────────────────────────

/**
 * One `kind=report-template` row, read in FULL. `html` is the template
 * fragment, which routinely runs to tens of kilobytes — far past the
 * 500-character snippet the list route returns — so this always costs a
 * second request (`GET /agent/memories/{id}`).
 */
export interface ReportTemplateRecord {
  /** The memory id, not the hypothesis id. */
  memoryId: string;
  hypothesisId: string;
  /** Line 1: the structure hash W16 computes and W20 compares drift against. */
  structureHash: string;
  /** Everything after line 1: the template HTML fragment. */
  html: string;
  createdAtMs: UnixMs;
}

/** One `kind=report` row, read in full: a headline and a flat slot map. */
export interface ReportRecord extends ParsedReport {
  memoryId: string;
  hypothesisId: string;
  createdAtMs: UnixMs;
  /**
   * Provenance, carried through UNMODIFIED. `kind=report` is NOT a trusted
   * kind — a researcher inside a container is what writes it — so this read
   * makes no trust judgement about the writer at all. W22 is the ticket that
   * checks the writer is *this* hypothesis's own researcher or session, and it
   * needs these two fields to do it.
   */
  createdByWorker: string;
  createdBySession: string;
}

/**
 * Both report reads answer with the row AND the anomalies, never one or the
 * other. `null` means "nothing to show"; a non-empty `tamper` with a non-null
 * row means "here it is, and something attacked it".
 *
 * The shape exists because "absent" and "attacked" are different answers and
 * W21 renders them differently: no template is a 404 the UI explains as "not
 * authored yet", while a template somebody tried to retract is served WITH a
 * warning. Collapsing the two — returning `null` for a hidden template — is
 * exactly the failure the retraction defence exists to prevent.
 */
export interface TemplateRead {
  template: ReportTemplateRecord | null;
  tamper: Tamper[];
}

export interface ReportRead {
  report: ReportRecord | null;
  tamper: Tamper[];
}

/**
 * The board's THIRD `latest_per` read, reduced to what a board row renders:
 * one hypothesis's newest OWN `kind=report`, by headline alone.
 *
 * It is a snippet read, never a full one — the board must stay O(1) in the
 * hypothesis count, and line 1 is all it draws.
 */
export interface ReportSummary {
  /**
   * Line 1 of the newest own `kind=report` snippet.
   *
   * 🔴 `null` means **no report exists**; `""` means **the report's line 1 was
   * empty**. The two must stay distinguishable — "nothing yet" and "said
   * nothing" are different facts and `web/src/api/types.ts` pins the same
   * distinction — so neither is ever defaulted into the other.
   */
  headline: string | null;
  /** That row's memory id; `null` when no own report survived. */
  memoryId: string | null;
  /** That row's `created_at`, unix MILLISECONDS (the memory table's unit). */
  createdAtMs: UnixMs | null;
  /** Cross-hypothesis writes and hostile retractions found while reading. */
  tamper: Tamper[];
}

// ── The store ───────────────────────────────────────────────────────────

export interface AppendStateParams {
  id: string;
  status: HypothesisStatus;
  title: string;
  thesis?: string;
  ownerEmail: string;
  evaluation?: EvaluationResult | null;
  rationale?: string | null;
  restatedFrom?: string;
}

export interface AppendEvaluationParams {
  id: string;
  snapshot: EvaluationSnapshot;
}

export interface TransitionParams {
  id: string;
  to: HypothesisStatus;
  /** Written into the new row's fenced block, and the permanent record of it. */
  evaluation?: EvaluationResult | null;
  rationale?: string | null;
}

export interface ReadOptions {
  /** Override the session-index page size; the walk pages on `offset`. */
  sessionPageSize?: number;
}

export interface ReportReadOptions extends ReadOptions {
  /**
   * A session index already in hand. Supplying it skips the session-list walk
   * — which is one HTTP request per page, and W22's board already holds the
   * answer. Omit it and the read pays for its own index.
   */
  sessions?: SessionLookup;
}

export interface HypothesisStore {
  newId(): string;
  /** The authoritative index: the session list, never memory. */
  readSessionIndex(options?: ReadOptions): Promise<SessionIndex>;
  /** The board's two-step read (§ "Reading the board without giving up the fast path"). */
  readBoard(options?: ReadOptions): Promise<HypothesisRecord[]>;
  /** One hypothesis, always with `include_retracted=1`. */
  readHypothesis(id: string, options?: ReadOptions): Promise<HypothesisRecord>;
  /**
   * The board's SECOND `latest_per` request: the newest trusted
   * `kind=evaluation` row per hypothesis, reduced to its summary line. One
   * request for the whole board, whatever the hypothesis count.
   *
   * `sessions` is the trust rule's third clause — pass the board's own id
   * set (a `Set<string>` satisfies `SessionLookup`), not a fresh index read.
   */
  readEvaluationSummaries(sessions: SessionLookup): Promise<Map<string, EvaluationSummary>>;
  /**
   * The board's THIRD `latest_per` request: the newest OWN `kind=report` row
   * per hypothesis, reduced to its headline. One request for the whole board,
   * whatever the hypothesis count — twelve hypotheses cost the same three
   * `latest_per` reads as one.
   *
   * A row whose provenance names neither this hypothesis's researcher worker
   * nor its `hyp-<id>` session is IGNORED and reported as
   * `cross_hypothesis_write` (see `isOwnReport`). Because `latest_per` hands
   * back only the newest row per name, a rejected newest row costs ONE
   * per-name follow-up for that hypothesis alone — the same audit path
   * `readBoard` uses — so an attacker who appends a forged report to B does
   * not erase B's real headline, which is exactly what the criterion "B's
   * headline is unchanged" means.
   *
   * `sessions` must be able to answer clause 2 (`sessionIdFrom`); the board
   * passes a `Map<id, sessionId>` built from the records it already holds.
   */
  readReportSummaries(sessions: SessionLookup): Promise<Map<string, ReportSummary>>;
  /**
   * The locked `kind=report-template` for one hypothesis, in full — the ONLY
   * path by which any later ticket obtains one.
   *
   * Read with `include_retracted=1`, and a retraction whose own provenance is
   * non-empty is IGNORED for state and surfaced as `hostile_retraction`,
   * exactly as the hypothesis reads do. A template hidden by a hostile
   * retraction therefore comes back served-and-flagged, never as absence.
   */
  readTemplate(id: string, options?: ReportReadOptions): Promise<TemplateRead>;
  /**
   * The newest `kind=report` for one hypothesis, in full — the ONLY path by
   * which any later ticket obtains one. Same retraction rule as
   * `readTemplate`.
   */
  readLatestReport(id: string, options?: ReportReadOptions): Promise<ReportRead>;
  /** Appends a trusted `kind=hypothesis` row through `POST /agent/memories`. */
  appendState(params: AppendStateParams): Promise<MemoryRecord>;
  /**
   * Appends the trusted `kind=evaluation, name=<id>` row W10's poller writes:
   * line 1 is the summary line the board parses, the rest is the full
   * snapshot as JSON. The ONLY writer of that kind.
   */
  appendEvaluation(params: AppendEvaluationParams): Promise<MemoryRecord>;
  /**
   * The newest trusted `kind=evaluation` rows for ONE hypothesis, newest
   * first — snippets, so line 1 and `created_at` are available for the
   * change/20-hour test without paying a full read per row.
   *
   * `include_retracted=1` for the same reason every other read here carries
   * it: without it Orange applies `notRetractedSQL` before the reduction, so
   * a hostile retraction of the newest row silently hands back an older one.
   * A retraction WOLF wrote (empty provenance) is honoured; one written from
   * inside a container is ignored.
   */
  readEvaluationRows(id: string, limit?: number): Promise<MemorySearchResultRow[]>;
  /**
   * One evaluation memory's full JSON body — the per-condition detail the
   * 500-character snippet cannot carry, and therefore the only way to derive
   * the attention run. `null` when the body does not parse.
   */
  readEvaluationSnapshot(memoryId: string): Promise<EvaluationSnapshot | null>;
  /** The serialised state machine; re-reads the current state under the lock. */
  transition(params: TransitionParams): Promise<TransitionOutcome>;
}

export interface CreateHypothesisStoreOptions {
  client: OrangeClient;
  logger?: Logger;
}

/** The board's one-request fast path. `limit=100` is the plan's number. */
const BOARD_LIMIT = 100;
/** The per-name follow-up. */
const DETAIL_LIMIT = 50;

/**
 * The session walk's two budgets (W32).
 *
 * The walk's only exit was ever a short page (`page.length < limit`), so a
 * server that keeps answering with page zero is not an error to it — it is an
 * infinite loop with no timeout, no error and no log. 🔴 **Orange does exactly
 * that**: `go/httpapi/history.go:107-125` parses `offset` with `strconv.Atoi`
 * and falls back to `0` on ANY parse error rather than rejecting the request,
 * so one regression, a proxy that strips a query parameter, or a route change
 * turns every board read, every detail read and the poller's enumeration into
 * an unbounded request flood against the dependency. W31 reproduced it at
 * 2.8 GB RSS before it was killed.
 *
 * BOTH bounds are needed and neither subsumes the other: at the default page
 * size the pages run out first, while a caller with a large page size exhausts
 * rows five times over before reaching fifty pages — which is also the shape a
 * server returning a full page of DUPLICATES produces. Rows are counted as
 * RECEIVED, never as indexed, for that second reason: a duplicate-returning
 * server leaves `index.size` constant forever.
 *
 * 49 full pages plus a short one is the largest walk that converges; at the
 * default page size of 200 that is 9 999 sessions, two orders of magnitude
 * past anything Wolf can produce (Orange's host port pool caps concurrent
 * sessions at 100 by default). Reaching either budget is therefore OUR
 * invariant breaking, which is why it is `internal` rather than `invalid`.
 */
const SESSION_INDEX_MAX_PAGES = 50;
const SESSION_INDEX_MAX_ROWS = 20_000;

const KIND_HYPOTHESIS = "hypothesis";
const KIND_EVALUATION = "evaluation";

/** How many `kind=evaluation` rows one hypothesis's history read pulls back.
 * Three is what the attention rule needs and nothing reads more. */
export const EVALUATION_HISTORY_LIMIT = 3;

/**
 * The ONE transition mutex for this process. See `createTransitioner`'s
 * `mutex` argument below for why it is module-scoped rather than per store.
 */
const SHARED_TRANSITION_MUTEX = new KeyedMutex();

type MutableRecord = HypothesisRecord & { tamper?: Tamper[] };

export function createHypothesisStore(options: CreateHypothesisStoreOptions): HypothesisStore {
  const { client } = options;
  const logger = options.logger;

  async function readSessionIndex(opts?: ReadOptions): Promise<SessionIndex> {
    const limit = opts?.sessionPageSize ?? SESSION_PAGE_SIZE;
    // Refused at the EDGE, before a single request. A non-positive page size is
    // the same non-termination wearing a caller's clothes: with `limit = 0`
    // every page comes back empty, `0 < 0` is false, and the walk pages forever
    // against an offset that never moves. `internal` and not `invalid` because
    // no HTTP caller can reach this option — only Wolf code sets it, so a bad
    // value here is a bug of ours.
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new WolfError(
        "internal",
        `readSessionIndex: sessionPageSize must be a positive integer, got ${String(limit)} — ` +
          `a non-positive page size makes the GET /agent/sessions walk unable to reach a short page`,
        { details: { route: "GET /agent/sessions", sessionPageSize: limit } },
      );
    }
    const index = new Map<string, SessionIndexEntry>();
    let offset = 0;
    let pages = 0;
    let rows = 0;
    // Both filters are load-bearing and both are server-side. `user_email=*`
    // because an API key's synthetic email (`api-key:<project>`) matches no
    // session row; `worker=interviewer` because the list is ordered
    // `updated_at DESC` and the daily tick sessions (worker
    // `researcher-<id>`) would otherwise push idle `draft` hypotheses off the
    // "authoritative" index entirely — the exact failure the trust model
    // exists to prevent.
    for (;;) {
      const params: ListSessionsParams = { worker: INTERVIEWER_WORKER, limit, offset };
      const page: SessionListRow[] = await client.listSessions(params);
      pages += 1;
      rows += page.length;
      for (const row of page) {
        const id = hypothesisIdFromSessionName(row.name);
        if (id === null) continue; // e.g. a project-level chat session
        if (index.has(id)) continue; // names are unique in Orange; be defensive anyway
        index.set(id, {
          id,
          sessionId: row.id,
          sessionName: row.name ?? sessionNameForHypothesis(id),
          status: row.status,
          createdAtSec: row.createdAtSec,
          updatedAtSec: row.updatedAtSec,
        });
      }
      // A short page is the end of the walk. A full page is not proof there is
      // another, so one extra request at the boundary is the price.
      //
      // Checked BEFORE the budgets so a walk that converges on its fiftieth
      // request is never refused for reaching the page budget on it.
      if (page.length < limit) break;
      if (pages >= SESSION_INDEX_MAX_PAGES) {
        throw new WolfError(
          "internal",
          `readSessionIndex: the GET /agent/sessions page walk did not converge — ` +
            `${pages} pages of limit=${limit} (${rows} rows) and never a short page. ` +
            `A server that ignores "offset" returns page zero forever.`,
          { details: { route: "GET /agent/sessions", pages, rows, limit } },
        );
      }
      if (rows >= SESSION_INDEX_MAX_ROWS) {
        throw new WolfError(
          "internal",
          `readSessionIndex: the GET /agent/sessions page walk did not converge — ` +
            `${rows} rows over ${pages} pages of limit=${limit} and never a short page. ` +
            `A server that ignores "offset" returns page zero forever.`,
          { details: { route: "GET /agent/sessions", pages, rows, limit } },
        );
      }
      offset += limit;
    }
    return index;
  }

  function blankRecord(entry: SessionIndexEntry): MutableRecord {
    return {
      id: entry.id,
      sessionName: entry.sessionName,
      sessionId: entry.sessionId,
      title: null,
      titleTruncated: false,
      owner: null,
      status: null,
      statusMemoryId: null,
      updatedAtMs: null,
      restatedFrom: null,
    };
  }

  function applyRow(record: MutableRecord, row: MemorySearchResultRow): void {
    const parsed = parseTitleFromSnippet(row.snippet);
    const status = row.labels["status"];
    record.title = parsed.title;
    record.titleTruncated = parsed.truncated;
    record.owner = row.labels["owner"] ?? null;
    record.status = isHypothesisStatus(status) ? status : null;
    record.statusMemoryId = row.id;
    record.updatedAtMs = row.createdAtMs;
    record.restatedFrom = row.labels["restated_from"] ?? null;
  }

  function addTamper(record: MutableRecord, tamper: Tamper): void {
    if (record.tamper === undefined) record.tamper = [];
    if (record.tamper.some((t) => t.reason === tamper.reason && t.memory_id === tamper.memory_id)) {
      return;
    }
    record.tamper.push(tamper);
  }

  /**
   * Resolves one hypothesis from rows read with `include_retracted=1`. The rows
   * arrive newest first.
   *
   * A row is skipped, and reported, when it is untrusted (`forged_row`) or when
   * Wolf itself retracted it. A retraction whose OWN provenance is non-empty is
   * ignored for state and reported (`hostile_retraction`) — an untrusted actor
   * cannot withdraw server-written state, and cannot resurrect one either,
   * because "retracted" means *at least one* retraction with empty provenance.
   *
   * `settled` says whether a trusted, un-withdrawn row was actually found in
   * the rows given. The board relies on it: it calls this with the ONE row
   * `latest_per` returned, and only when that row does not settle does it pay
   * for the per-name follow-up that can see older rows.
   */
  function resolveFromRows(
    entry: SessionIndexEntry,
    rows: readonly MemorySearchResultRow[],
    sessions: SessionLookup,
  ): { record: MutableRecord; settled: boolean } {
    const record = blankRecord(entry);
    let settled = false;
    for (const row of rows) {
      if (row.labels["name"] !== entry.id) continue; // not this hypothesis
      if (!isTrusted(row, sessions)) {
        addTamper(record, forgedRowTamper(row));
        continue;
      }
      const retractions: readonly MemoryRetraction[] = row.retractedBy ?? [];
      let withdrawnByWolf = false;
      for (const retraction of retractions) {
        if (hasEmptyProvenance(retraction)) {
          withdrawnByWolf = true;
        } else {
          addTamper(record, hostileRetractionTamper(retraction));
        }
      }
      if (withdrawnByWolf) continue; // Wolf took this back; keep looking older
      if (!settled) {
        applyRow(record, row);
        settled = true;
      }
    }
    return { record, settled };
  }

  async function readDetailRows(id: string): Promise<MemorySearchResultRow[]> {
    const params: ListMemoriesParams = {
      selector: `kind=${KIND_HYPOTHESIS},name=${id}`,
      limit: DETAIL_LIMIT,
      includeRetracted: true,
    };
    return client.listMemories(params);
  }

  async function readBoard(opts?: ReadOptions): Promise<HypothesisRecord[]> {
    const index = await readSessionIndex(opts);
    // ONE request for the whole board. This is the normal case.
    //
    // ⚠️ `include_retracted=1` is LOAD-BEARING on this request, and the plan's
    // board criterion omits it. Without it Orange applies `notRetractedSQL`
    // BEFORE the `latest_per` reduction (`go/agentdb/memories.go:467,526` —
    // "when it is true a retracted row participates in that reduction and can
    // win its name's slot"), so a hostile retraction of Wolf's NEWEST state row
    // does not merely hide that row: it hands back the OLDER trusted row
    // beneath it, which passes `isTrusted` and is accepted as authoritative.
    // The board then silently ROLLS BACK to the previous status with no
    // anomaly and no tamper warning, while the detail read — which always
    // carries the flag — shows the true state. Two surfaces, disagreeing, with
    // the wrong one being the one the product renders.
    //
    // This is not a mock's opinion. It was reproduced against a running build
    // and both bodies are committed: `__fixtures__/board-resurrection-*.json`
    // are the SAME query with and without the flag, and the unflagged one
    // reports `1a2b3c4d` as `draft` where the flagged one reports `live` with
    // the hostile retraction attached.
    //
    // The fast path survives: the flag costs no extra request (Orange attaches
    // retractions in one further query of its own, server-side), so the
    // all-trusted board is still exactly ONE memory request.
    const rows = await client.listMemories({
      selector: `kind=${KIND_HYPOTHESIS}`,
      latestPer: "name",
      limit: BOARD_LIMIT,
      includeRetracted: true,
    });
    const newest = new Map<string, MemorySearchResultRow>();
    for (const row of rows) {
      const name = row.labels["name"];
      if (name === undefined) continue;
      if (!index.has(name)) {
        // A `kind=hypothesis` memory naming something that is not a hypothesis.
        // There is no hypothesis to hang a tamper flag on, so it is dropped and
        // logged rather than rendered.
        logger?.warn(
          { memory_id: row.id, name },
          "kind=hypothesis memory names no session in the index — ignored",
        );
        continue;
      }
      if (!newest.has(name)) newest.set(name, row);
    }

    const records: MutableRecord[] = [];
    const anomalies: SessionIndexEntry[] = [];
    for (const entry of index.values()) {
      const row = newest.get(entry.id);
      // The newest row goes through the SAME resolver the detail read uses, so
      // the two surfaces cannot answer differently. It settles — the fast path,
      // no follow-up — when that row is trusted and Wolf has not withdrawn it;
      // a hostile retraction of it is reported as tamper and changes nothing.
      const resolved = resolveFromRows(entry, row === undefined ? [] : [row], index);
      if (resolved.settled) {
        records.push(resolved.record);
        continue;
      }
      // Not settled: the newest row was written inside a container, or Wolf
      // itself retracted it, or there is no row at all (which is what a
      // retraction looked like before the flag above). All three need the
      // per-name audit view, which can see the rows underneath.
      anomalies.push(entry);
    }

    for (const entry of anomalies) {
      const rowsForId = await readDetailRows(entry.id);
      records.push(resolveFromRows(entry, rowsForId, index).record);
    }

    // Newest first, and a hypothesis with no resolvable state row sorts last
    // rather than vanishing.
    records.sort((a, b) => (b.updatedAtMs ?? -1) - (a.updatedAtMs ?? -1));
    return records;
  }

  async function readHypothesis(id: string, opts?: ReadOptions): Promise<HypothesisRecord> {
    const index = await readSessionIndex(opts);
    const entry = index.get(id);
    if (entry === undefined) {
      throw new WolfError("not_found", `no hypothesis ${id}`, { details: { id } });
    }
    const rows = await readDetailRows(id);
    return resolveFromRows(entry, rows, index).record;
  }

  async function readEvaluationSummaries(
    sessions: SessionLookup,
  ): Promise<Map<string, EvaluationSummary>> {
    // `include_retracted=1` for the same reason the board read carries it
    // (see readBoard): without it Orange applies `notRetractedSQL` BEFORE the
    // `latest_per` reduction, so a hostile retraction of the newest evaluation
    // row hands back the OLDER one — rolling the displayed score back with no
    // sign that anything happened.
    const rows = await client.listMemories({
      selector: `kind=${KIND_EVALUATION}`,
      latestPer: "name",
      limit: BOARD_LIMIT,
      includeRetracted: true,
    });
    const out = new Map<string, EvaluationSummary>();
    for (const row of rows) {
      const name = row.labels["name"];
      if (name === undefined || out.has(name)) continue;
      if (!sessions.has(name)) continue; // names something that is not a hypothesis
      if (!isTrusted(row, sessions)) {
        // A forged evaluation row cannot set a score, which is the whole
        // point. It is logged rather than rendered: the board's `tamper` array
        // is the pinned `Tamper` shape for the STATE row (W5), and widening it
        // here would make the board report tamper the detail page does not.
        logger?.warn(
          { memory_id: row.id, name },
          "untrusted kind=evaluation memory ignored (score not rendered)",
        );
        continue;
      }
      const withdrawnByWolf = (row.retractedBy ?? []).some(hasEmptyProvenance);
      if (withdrawnByWolf) continue;
      const parsed = parseEvaluationSummaryLine(parseTitleFromSnippet(row.snippet).title);
      if (parsed === null) {
        logger?.warn(
          { memory_id: row.id, name },
          "kind=evaluation line 1 did not parse — support_score omitted",
        );
        continue;
      }
      out.set(name, { ...parsed, memoryId: row.id, createdAtMs: row.createdAtMs });
    }
    return out;
  }

  // ── The report layer's two reads (W15) ────────────────────────────────

  /**
   * The rows-in, one-row-out half of both report reads, and deliberately the
   * same three rules `resolveFromRows` applies to hypothesis state:
   *
   *   1. a row naming a different hypothesis is not ours — skip it silently;
   *   2. a row that fails `trust` is an anomaly — skip it, report `forged_row`;
   *   3. a row retracted by WOLF (empty provenance on the retraction) is gone —
   *      skip it and keep looking older; a retraction whose own provenance is
   *      NON-empty is ignored for state and reported as `hostile_retraction`.
   *
   * Rule 3 is the one that matters. `retracts` is an ordinary label and
   * `notRetractedSQL` never checks who wrote the retraction, so without this a
   * prompt-injected researcher withdraws the locked template and the report
   * frame simply 404s — an erasure indistinguishable from "nobody authored
   * one". With it, the template is still served and the attack is named.
   *
   * `reject` decides rule 2 AND names the anomaly, because the two kinds fail
   * it for different reasons and a reader must be able to tell them apart. A
   * `report-template` fails `isTrusted` and is a `forged_row`. A `report` is
   * untrusted BY CONSTRUCTION — a researcher inside a container writes one on
   * every tick, and flagging each `forged_row` would fill the board with
   * warnings for the system working exactly as designed — so its rule is
   * `isOwnReport` and its anomaly is `cross_hypothesis_write` (W22). Passing
   * `null` keeps every row, which no caller does any more.
   */
  function pickSurvivingRow(
    id: string,
    rows: readonly MemorySearchResultRow[],
    reject: ((row: MemorySearchResultRow) => Tamper | null) | null,
  ): { row: MemorySearchResultRow | null; tamper: Tamper[] } {
    const tamper: Tamper[] = [];
    const add = (t: Tamper): void => {
      if (tamper.some((x) => x.reason === t.reason && x.memory_id === t.memory_id)) return;
      tamper.push(t);
    };
    let winner: MemorySearchResultRow | null = null;
    for (const row of rows) {
      if (row.labels["name"] !== id) continue;
      const rejected = reject === null ? null : reject(row);
      if (rejected !== null) {
        add(rejected);
        continue;
      }
      let withdrawnByWolf = false;
      for (const retraction of row.retractedBy ?? []) {
        if (hasEmptyProvenance(retraction)) withdrawnByWolf = true;
        else add(hostileRetractionTamper(retraction));
      }
      if (withdrawnByWolf) continue;
      if (winner === null) winner = row;
    }
    return { row: winner, tamper };
  }

  async function reportSessions(opts?: ReportReadOptions): Promise<SessionLookup> {
    return opts?.sessions ?? (await readSessionIndex(opts));
  }

  function requireKnownHypothesis(id: string, sessions: SessionLookup): void {
    // The session list is the authoritative index (§ "The trust model"), so an
    // id absent from it is not a hypothesis whose report is missing — it is not
    // a hypothesis. `readHypothesis` answers the same way for the same reason.
    if (!sessions.has(id)) {
      throw new WolfError("not_found", `no hypothesis ${id}`, { details: { id } });
    }
  }

  /** One board row's report facts, off the 500-character snippet alone. */
  function reportSummaryOf(row: MemorySearchResultRow, tamper: Tamper[]): ReportSummary {
    // The SAME reduction the full read applies (`parseReportContent` trims
    // line 1 and truncates it at HEADLINE_MAX_CHARS), so the board and the
    // detail page cannot disagree about what the headline says. `""` survives
    // as `""`: a report whose line 1 was blank said nothing, which is not the
    // same fact as there being no report.
    const line = parseTitleFromSnippet(row.snippet).title.trim();
    return {
      headline: truncateHeadline(line).text,
      memoryId: row.id,
      createdAtMs: row.createdAtMs,
      tamper,
    };
  }

  async function readReportSummaries(
    sessions: SessionLookup,
  ): Promise<Map<string, ReportSummary>> {
    // `include_retracted=1` for the same reason every other read here carries
    // it (see readBoard): without it Orange applies `notRetractedSQL` BEFORE
    // the `latest_per` reduction, so a hostile retraction of the newest report
    // hands back an older one with no sign that anything happened.
    const rows = await client.listMemories({
      selector: `kind=${KIND_REPORT}`,
      latestPer: "name",
      limit: BOARD_LIMIT,
      includeRetracted: true,
    });

    const newest = new Map<string, MemorySearchResultRow>();
    for (const row of rows) {
      const name = row.labels["name"];
      if (name === undefined) continue;
      if (!sessions.has(name)) {
        // A `kind=report` naming something that is not a hypothesis. There is
        // no board row to hang an anomaly on, so it is logged rather than
        // rendered — exactly as `readBoard` treats the same shape.
        logger?.warn(
          { memory_id: row.id, name },
          "kind=report memory names no session in the index — ignored",
        );
        continue;
      }
      if (!newest.has(name)) newest.set(name, row);
    }

    const out = new Map<string, ReportSummary>();
    const anomalies: string[] = [];
    for (const [name, row] of newest) {
      const owner = reportOwnerFor(name, sessions);
      const picked = pickSurvivingRow(name, [row], (candidate) =>
        isOwnReport(candidate, owner) ? null : crossHypothesisTamper(candidate),
      );
      if (picked.row !== null) {
        out.set(name, reportSummaryOf(picked.row, picked.tamper));
        continue;
      }
      // The newest row was written by something that is not this hypothesis,
      // or Wolf itself withdrew it. `latest_per` cannot see underneath, so
      // this one hypothesis pays for the per-name audit view — and its real
      // headline survives the attack.
      anomalies.push(name);
    }

    for (const name of anomalies) {
      const owner = reportOwnerFor(name, sessions);
      const rowsForId = await client.listMemories({
        selector: reportSelector(KIND_REPORT, name),
        limit: DETAIL_LIMIT,
        includeRetracted: true,
      });
      const picked = pickSurvivingRow(name, rowsForId, (candidate) =>
        isOwnReport(candidate, owner) ? null : crossHypothesisTamper(candidate),
      );
      out.set(
        name,
        picked.row === null
          ? { headline: null, memoryId: null, createdAtMs: null, tamper: picked.tamper }
          : reportSummaryOf(picked.row, picked.tamper),
      );
    }

    return out;
  }

  async function readTemplate(id: string, opts?: ReportReadOptions): Promise<TemplateRead> {
    const sessions = await reportSessions(opts);
    requireKnownHypothesis(id, sessions);
    const rows = await client.listMemories({
      selector: reportSelector(KIND_REPORT_TEMPLATE, id),
      limit: DETAIL_LIMIT,
      includeRetracted: true,
    });
    // `report-template` IS in TRUSTED_KINDS, so all three clauses apply: empty
    // provenance, the kind, and a `name` matching an existing `hyp-<id>`
    // session. A template written from inside a container is a forgery — the
    // frame route must serve 404 rather than render it.
    const picked = pickSurvivingRow(id, rows, (row) =>
      isTrusted(row, sessions) ? null : forgedRowTamper(row),
    );
    if (picked.row === null) return { template: null, tamper: picked.tamper };
    // The template HTML is far past the 500-character snippet, so the full row
    // is a second request. `GET /agent/memories/{id}` is deliberately NOT
    // retraction-filtered on the Orange side, which is what lets a row a
    // hostile retraction hid still be read here.
    const full = await client.getMemoryById(picked.row.id);
    const parsed = parseTemplateContent(full.content);
    return {
      template: {
        memoryId: full.id,
        hypothesisId: id,
        structureHash: parsed.first,
        html: parsed.html,
        createdAtMs: full.createdAtMs,
      },
      tamper: picked.tamper,
    };
  }

  async function readLatestReport(id: string, opts?: ReportReadOptions): Promise<ReportRead> {
    const sessions = await reportSessions(opts);
    requireKnownHypothesis(id, sessions);
    const rows = await client.listMemories({
      selector: reportSelector(KIND_REPORT, id),
      limit: DETAIL_LIMIT,
      includeRetracted: true,
    });
    // W22's cross-hypothesis defence, at the ONE read every renderer of a
    // report goes through: the detail payload's `report` block AND W21's
    // frame. A `kind=report, name=B` row written from hypothesis A's session
    // is not evidence about B, so it is skipped and the read keeps looking at
    // older rows — B's own last report is still served, and the attack is
    // named rather than merely suppressed.
    const owner = reportOwnerFor(id, sessions);
    const picked = pickSurvivingRow(id, rows, (row) =>
      isOwnReport(row, owner) ? null : crossHypothesisTamper(row),
    );
    if (picked.row === null) return { report: null, tamper: picked.tamper };
    const full = await client.getMemoryById(picked.row.id);
    // `parseReportContent` THROWS `invalid` naming the offending slot key. It
    // is not swallowed: a report whose body is not a flat {slotId: html} map
    // cannot be rendered, and the writer is a model, so the failure has to be
    // legible to whoever reads the log rather than silently becoming "no
    // report yet".
    let parsed: ParsedReport;
    try {
      parsed = parseReportContent(full.content);
    } catch (err) {
      // The anomalies above were witnessed on OTHER rows and are still true.
      // Losing them here is what made a forged report vanish from the detail
      // page whenever the victim's own body happened not to parse.
      throw withReportTamper(err, picked.tamper);
    }
    return {
      report: {
        ...parsed,
        memoryId: full.id,
        hypothesisId: id,
        createdAtMs: full.createdAtMs,
        createdByWorker: full.createdByWorker,
        createdBySession: full.createdBySession,
      },
      tamper: picked.tamper,
    };
  }

  async function appendState(params: AppendStateParams): Promise<MemoryRecord> {
    if (!isHypothesisId(params.id)) {
      throw new WolfError("invalid", `not a hypothesis id: ${JSON.stringify(params.id)}`, {
        details: { id: params.id },
      });
    }
    const labels: Record<string, string> = {
      kind: KIND_HYPOTHESIS,
      name: params.id,
      status: params.status,
      owner: slugifyOwner(params.ownerEmail),
    };
    if (params.restatedFrom !== undefined) labels["restated_from"] = params.restatedFrom;
    const content = buildHypothesisContent({
      title: params.title,
      thesis: params.thesis,
      ownerEmail: params.ownerEmail,
      evaluation: params.evaluation ?? null,
      rationale: params.rationale ?? null,
    });
    // The body carries NO provenance keys. O7 rejects a body containing
    // `created_by_worker` or `created_by_session` with 400 rather than ignoring
    // them — even when the value is the empty string — and the route answers
    // 201, which `client.appendMemory` already pins.
    return client.appendMemory({ labels, content, embed: false });
  }

  async function appendEvaluation(params: AppendEvaluationParams): Promise<MemoryRecord> {
    if (!isHypothesisId(params.id)) {
      throw new WolfError("invalid", `not a hypothesis id: ${JSON.stringify(params.id)}`, {
        details: { id: params.id },
      });
    }
    // `kind` and `name` only: § "Memory kinds" gives this row no `status` and
    // no `owner`, and a label Wolf invents here is a label the board's
    // `latest_per=name` reduction would have to reason about.
    return client.appendMemory({
      labels: { kind: KIND_EVALUATION, name: params.id },
      content: buildEvaluationContent(params.snapshot),
      embed: false,
    });
  }

  async function readEvaluationRows(
    id: string,
    limit: number = EVALUATION_HISTORY_LIMIT,
  ): Promise<MemorySearchResultRow[]> {
    const rows = await client.listMemories({
      selector: `kind=${KIND_EVALUATION},name=${id}`,
      limit,
      includeRetracted: true,
    });
    const sessions: SessionLookup = new Set([id]);
    const out: MemorySearchResultRow[] = [];
    for (const row of rows) {
      if (row.labels["name"] !== id) continue;
      if (!isTrusted(row, sessions)) {
        logger?.warn(
          { memory_id: row.id, name: id },
          "untrusted kind=evaluation memory ignored (the poller will not count it)",
        );
        continue;
      }
      if ((row.retractedBy ?? []).some(hasEmptyProvenance)) continue;
      out.push(row);
    }
    return out;
  }

  async function readEvaluationSnapshot(memoryId: string): Promise<EvaluationSnapshot | null> {
    const full = await client.getMemoryById(memoryId);
    return parseEvaluationContent(full.content).snapshot;
  }

  const transitioner: Transitioner = createTransitioner({
    readCurrentStatus: async (id) => (await readHypothesis(id)).status,
    // ⚠️ PROCESS-WIDE, not per store instance. W10's poller runs beside the
    // Express app but cannot share its store: `createApp` builds its own and
    // returns only the app, and `app.ts` belongs to other tickets. Two
    // KeyedMutexes would mean the poller's `live -> challenged` and a human's
    // `/verdict` could both read `live` and both append, which is exactly the
    // race W5's machine exists to close. Sharing the mutex at module scope
    // closes it for every store in the process, which is the only scope that
    // is true. Serialisation is still PER HYPOTHESIS ID: different ids never
    // wait on each other.
    mutex: SHARED_TRANSITION_MUTEX,
  });

  async function transition(params: TransitionParams): Promise<TransitionOutcome> {
    const { id, to } = params;
    return transitioner.transition(id, to, async () => {
      // Carried forward from the row we just read INSIDE the lock: the board
      // read has snippets only, so the title and thesis come from a full-
      // content read of the state row itself.
      const record = await readHypothesis(id);
      if (record.statusMemoryId === null) {
        throw new WolfError("conflict", `hypothesis ${id} has no trusted state row to carry forward`);
      }
      const previous: MemoryRecord = await client.getMemoryById(record.statusMemoryId);
      const parsed = parseHypothesisContent(previous.content);
      const appended = await appendState({
        id,
        status: to,
        title: parsed.title,
        thesis: parsed.thesis,
        ownerEmail: parsed.ownerEmail ?? "",
        evaluation: params.evaluation ?? null,
        rationale: params.rationale ?? null,
        ...(record.restatedFrom !== null ? { restatedFrom: record.restatedFrom } : {}),
      });
      return appended.id;
    });
  }

  return {
    newId: newHypothesisId,
    readSessionIndex,
    readBoard,
    readHypothesis,
    readEvaluationSummaries,
    readReportSummaries,
    readTemplate,
    readLatestReport,
    appendState,
    appendEvaluation,
    readEvaluationRows,
    readEvaluationSnapshot,
    transition,
  };
}
