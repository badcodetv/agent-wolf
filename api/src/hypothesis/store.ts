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
  MemoryRecord,
  MemoryRetraction,
  MemorySearchResultRow,
  SessionListRow,
  UnixMs,
  UnixSec,
} from "../orange/types.js";
import type { ListMemoriesParams, ListSessionsParams, OrangeClient } from "../orange/client.js";
import type { EvaluationResult } from "./evaluate.js";
import {
  createTransitioner,
  type HypothesisStatus,
  type TransitionOutcome,
  type Transitioner,
  isHypothesisStatus,
} from "./lifecycle.js";

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

export interface HypothesisStore {
  newId(): string;
  /** The authoritative index: the session list, never memory. */
  readSessionIndex(options?: ReadOptions): Promise<SessionIndex>;
  /** The board's two-step read (§ "Reading the board without giving up the fast path"). */
  readBoard(options?: ReadOptions): Promise<HypothesisRecord[]>;
  /** One hypothesis, always with `include_retracted=1`. */
  readHypothesis(id: string, options?: ReadOptions): Promise<HypothesisRecord>;
  /** Appends a trusted `kind=hypothesis` row through `POST /agent/memories`. */
  appendState(params: AppendStateParams): Promise<MemoryRecord>;
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

const KIND_HYPOTHESIS = "hypothesis";

type MutableRecord = HypothesisRecord & { tamper?: Tamper[] };

export function createHypothesisStore(options: CreateHypothesisStoreOptions): HypothesisStore {
  const { client } = options;
  const logger = options.logger;

  async function readSessionIndex(opts?: ReadOptions): Promise<SessionIndex> {
    const limit = opts?.sessionPageSize ?? SESSION_PAGE_SIZE;
    const index = new Map<string, SessionIndexEntry>();
    let offset = 0;
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
      if (page.length < limit) break;
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
   * Resolves one hypothesis from a page read with `include_retracted=1`. The
   * rows arrive newest first.
   *
   * A row is skipped, and reported, when it is untrusted (`forged_row`) or when
   * Wolf itself retracted it. A retraction whose OWN provenance is non-empty is
   * ignored for state and reported (`hostile_retraction`) — an untrusted actor
   * cannot withdraw server-written state, and cannot resurrect one either,
   * because "retracted" means *at least one* retraction with empty provenance.
   */
  function resolveFromRows(
    entry: SessionIndexEntry,
    rows: readonly MemorySearchResultRow[],
    sessions: SessionLookup,
  ): MutableRecord {
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
    return record;
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
    const rows = await client.listMemories({
      selector: `kind=${KIND_HYPOTHESIS}`,
      latestPer: "name",
      limit: BOARD_LIMIT,
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
      if (row !== undefined && isTrusted(row, index)) {
        const record = blankRecord(entry);
        applyRow(record, row);
        records.push(record);
        continue;
      }
      // Either something inside a container wrote the newest row, or the row is
      // missing entirely — which, on a default read, is what a retraction looks
      // like. Both need the audit view.
      anomalies.push(entry);
    }

    for (const entry of anomalies) {
      const rowsForId = await readDetailRows(entry.id);
      records.push(resolveFromRows(entry, rowsForId, index));
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
    return resolveFromRows(entry, rows, index);
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

  const transitioner: Transitioner = createTransitioner({
    readCurrentStatus: async (id) => (await readHypothesis(id)).status,
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
      const previous: MemoryRecord = await client.getMemory(record.statusMemoryId);
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
    appendState,
    transition,
  };
}
