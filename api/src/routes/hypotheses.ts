/**
 * The hypothesis routes: the board, the detail read, and creation.
 *
 *   GET  /api/hypotheses        → the board (exactly TWO `latest_per` reads)
 *   POST /api/hypotheses        { title } → 201 { id }
 *   GET  /api/hypotheses/:id    → the detail page's whole payload
 *
 * Every route is mounted under the LITERAL `/api` prefix (R37) and this
 * router — not the app — mounts `requireSignedIn` (R79; see the ⚠️ at the top
 * of `api/src/auth/session.ts`).
 *
 * Two things this file deliberately does NOT do:
 *
 *  - It does not re-implement the trust rule. `isTrusted`, the `Tamper`
 *    shape, the session index and the retraction rule all come from
 *    `hypothesis/store.ts`, and the board's records are passed through
 *    unmodified.
 *  - It does not parse the evaluation summary line. That parser lives in
 *    `hypothesis/store.ts` and there is exactly one of it (W10 writes the
 *    line this file reads).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BobClient } from "../bob/client.js";
import type {
  AttentionRequestRecord,
  MemorySearchResultRow,
  UnixMs,
  UnixSec,
} from "../bob/types.js";
import { requireSignedIn, signedInUser } from "../auth/session.js";
import { loadConfig, type WolfConfig } from "../config.js";
import { validateSpec, type SpecError } from "../hypothesis/spec.js";
import { extractJsonObject } from "../hypothesis/speccontent.js";
import {
  createProvisioner,
  researcherWorkerFor,
  specRejection,
  type Provisioner,
} from "../hypothesis/provision.js";
import { detectDrift, type DriftResult } from "../report/drift.js";
import { parseTemplate } from "../report/template.js";
import type { ReportComposeStats } from "./report.js";
import type { HypothesisStatus } from "../hypothesis/lifecycle.js";
import {
  INTERVIEWER_WORKER,
  HYPOTHESIS_ID_PATTERN,
  isTrusted,
  hasEmptyProvenance,
  parseHypothesisContent,
  sessionNameForHypothesis,
  type EvaluationSummary,
  type HypothesisRecord,
  type HypothesisStore,
  type ReportRead,
  type ReportSummary,
  reportTamperFrom,
  type SessionLookup,
  type Tamper,
} from "../hypothesis/store.js";

// ── Memory kinds this file reads (§ "Memory kinds") ─────────────────────

const KIND_SPEC = "hypothesis-spec";
const KIND_SPEC_CANDIDATE = "hypothesis-spec-candidate";
const KIND_EVALUATION = "evaluation";
const KIND_VERDICT = "verdict";
const KIND_RESEARCH_NOTE = "research-note";
const KIND_SPEC_AMENDMENT = "spec-amendment";

// The per-hypothesis daily researcher's worker name (§ "Orange atoms").
// Defined in `hypothesis/provision.ts` — the module that creates and deletes
// it — and re-exported here so W8's callers keep their import site.
export { RESEARCHER_WORKER_PREFIX, researcherWorkerFor } from "../hypothesis/provision.js";

/** How many rows of one kind a detail read pulls back. */
const DETAIL_ROW_LIMIT = 50;

/** Poll bounds for Orange's ASYNCHRONOUS session create (see below). */
export const DEFAULT_SESSION_POLL_INTERVAL_MS = 500;
export const DEFAULT_SESSION_POLL_TIMEOUT_MS = 30_000;

/**
 * How long `POST /api/hypotheses` waits for the seeded interview turn to be
 * REGISTERED with Orange before answering anyway.
 *
 * Short on purpose. Registration happens within milliseconds of the message
 * POST reaching agentd (`beginActiveQuery`, before the sandbox is dispatched),
 * so this is a guard against a lost race, not a budget for real work. Waiting
 * longer would add latency to the one route in the product that is already
 * slow, to confirm something that is a convenience: if the confirmation never
 * comes, the hypothesis is still real and the user can type.
 */
export const DEFAULT_SEED_REGISTER_TIMEOUT_MS = 5_000;
export const DEFAULT_SEED_POLL_INTERVAL_MS = 150;

// ── Response shapes ─────────────────────────────────────────────────────
//
// snake_case on the wire, matching the plan's own field list
// (`updated_at_ms`, `support_score`, `conditions_summary`), and matching the
// unit-in-the-name rule: `_ms` is unix milliseconds (memories), `_sec` is
// unix seconds (Orange's `agent_*` tables, which is what an attention
// request's `created_at` is).
//
// Both shapes are OPEN FOR EXTENSION: W22 adds `headline` to the board row
// and a `report` block to the detail payload, from this same file, once a
// `kind=report` memory can exist. Nothing here should have to move for that.

/**
 * The board's four sections, in the order § 4 prints them (W27).
 *
 * 🔴 These four strings are a WIRE VOCABULARY `web/`'s fixtures already
 * consume. Renaming one does not break a build: it makes every board row
 * render as unclassified, in NEEDS A HUMAN, with a caption — which is the
 * right behaviour for an unrecognised tier and the wrong behaviour for all of
 * them at once.
 */
export const ATTENTION_TIERS = ["needs_human", "watch", "in_interview", "holding"] as const;
export type AttentionTier = (typeof ATTENTION_TIERS)[number];

/**
 * What the tier rules actually read. `BoardRow` satisfies it structurally;
 * declaring it separately is what lets the table test drive every rule
 * without building a whole row.
 */
export interface AttentionInputs {
  status: HypothesisStatus | null;
  tamper?: Tamper[];
  attention_count?: number;
  stale_count?: number;
  headline: string | null;
}

/**
 * § 4's membership table, in order. The first rule that matches wins, which
 * is what makes a `draft` row carrying tamper NEEDS A HUMAN rather than IN
 * INTERVIEW.
 *
 * 🔴 **This side does NOT filter terminal statuses.** `confirmed`,
 * `invalidated` and `archived` fall through to `holding` here and are dropped
 * from the board by `web/`'s client-side status filter (UI design § 3), which
 * owns that decision and is where `/archive` picks them up. Filtering here
 * too would be two sides each assuming the other did it — and it would make
 * `/archive`, which reads the same rows, unable to see them (R138 hand-off 1).
 *
 * `attentionRequested` is the third clause of rule 1 and is passed in rather
 * than read here: it comes from ONE project-wide attention read for the whole
 * board, not one per hypothesis.
 */
export function attentionTierFor(row: AttentionInputs, attentionRequested: boolean): AttentionTier {
  if (row.status === "challenged" || (row.tamper?.length ?? 0) > 0 || attentionRequested) {
    return "needs_human";
  }
  // `?? 0` here is a COMPARISON default, not a wire default: an absent count
  // is not > 0, which is the same answer an explicit zero gives. The wire
  // field stays absent either way — see `BoardRow.attention_count`.
  if (
    row.status === "live" &&
    ((row.attention_count ?? 0) > 0 || (row.stale_count ?? 0) > 0 || row.headline === null)
  ) {
    return "watch";
  }
  if (row.status === "draft") return "in_interview";
  return "holding";
}

/**
 * Does this open attention request name this hypothesis?
 *
 * ONE rule, shared by the board's tier computation and the detail page's
 * list: the row carries both a worker and a session (`go/agentdb/attention.go`
 * :55-57), a researcher's ask is attributable by worker, and an interviewer's
 * ask carries `worker: "interviewer"` and is attributable only by session. A
 * second copy of this drifts the first time one surface gains a clause.
 *
 * ⚠️ **`sessionId !== null` is TYPE NARROWING, not a behavioural defence, and
 * that rests on an invariant elsewhere.** `mapAttentionRequest` builds
 * `sessionId` with `strField` (`orange/client.ts:337-340`), which coerces to
 * `""` at the wire boundary — so `request.sessionId` is a `string` at runtime
 * whatever Orange sends, and `"" === null` is false. Deleting the clause
 * changes no answer today, which a mutation confirmed.
 *
 * 🔴 It is documented here rather than only in the test because **the day
 * `strField` stops coercing, this guard becomes load-bearing overnight** and
 * nothing else would point at it.
 */
export function attentionRequestNames(
  request: { worker: string; sessionId: string },
  id: string,
  sessionId: string | null,
): boolean {
  return (
    request.worker === researcherWorkerFor(id) ||
    (sessionId !== null && request.sessionId === sessionId)
  );
}

export interface ConditionsSummary {
  tripped: number;
  holding: number;
  indeterminate: number;
  evaluated_at_ms: UnixMs;
}

export interface BoardRow {
  id: string;
  title: string | null;
  /** True when the 500-byte snippet cut line 1: the UI must not claim the title is complete. */
  title_truncated: boolean;
  owner: string | null;
  status: HypothesisStatus | null;
  support_score: number | null;
  conditions_summary: ConditionsSummary | null;
  updated_at_ms: UnixMs | null;
  /**
   * Line 1 of this hypothesis's newest own `kind=report` (W22).
   *
   * 🔴 `null` means **no report yet**; `""` means **the report said nothing on
   * line 1**. They are different facts and the board renders them differently
   * — `headline === null` on a `live` hypothesis is the cheap board-level
   * proxy for "the report layer is not working" (UI design § 4 point 4) —
   * so neither is ever defaulted into the other.
   */
  headline: string | null;
  tamper?: Tamper[];
  /**
   * Optional label carried forward across a re-roll (W27).
   *
   * It is on the DETAIL row already; putting it here too is what LETS
   * `/archive` stop paying one full detail read per terminal row just to draw
   * the "restated from" lineage (R138 hand-off 2). It costs nothing —
   * `readBoard` has already resolved it.
   *
   * ⚠️ **Present tense would be false today.** `web/src/api/types.ts` does not
   * yet declare this field on its `BoardRow`, and `web/src/pages/Archive.tsx`
   * still calls `fetchHypothesis` per terminal row. The server half is what
   * ships here; the client half is a separate ticket. (R211 class — a
   * sentence that is behaviourally true of the future and mechanically false
   * of the present is what a reader debugs against.)
   */
  restated_from: string | null;
  /**
   * W27. Which section of the board this row belongs to, computed SERVER-SIDE
   * from the rules pinned in `design/2026-08-24-agent-wolf-ui.md` § 4.
   *
   * 🔴 The tier lives in exactly one place, and this is it. `web/`'s
   * `board/tiers.ts` groups and sorts by this value and never recomputes it —
   * a second copy in the browser is the same defect class as putting the
   * go-live validator there.
   */
  attention_tier: AttentionTier;
  /**
   * How many conditions W10 raised for a human, off `attention=<n>` on the
   * evaluation memory's line 1.
   *
   * 🔴 **ABSENT STAYS ABSENT.** The key is omitted when the evaluation line
   * carried no token — which is every memory written before the token
   * existed, and every hypothesis that has never been evaluated. `0` means
   * "the evaluator looked and raised nothing" and is a different fact.
   */
  attention_count?: number;
  /** How many metrics W4 marked stale, off `stale=<n>`. Same absence rule. */
  stale_count?: number;
}

export interface HypothesisDetailRow {
  id: string;
  session_name: string;
  session_id: string | null;
  title: string | null;
  title_truncated: boolean;
  owner: string | null;
  status: HypothesisStatus | null;
  status_memory_id: string | null;
  updated_at_ms: UnixMs | null;
  restated_from: string | null;
  tamper?: Tamper[];
}

/** An untrusted evidence row, with the writer that produced it (W14 labels them). */
export interface EvidenceRow {
  id: string;
  snippet: string;
  status: string | null;
  created_at_ms: UnixMs;
  created_by_worker: string;
  created_by_session: string;
}

export interface AttentionRequestRow {
  id: string;
  message: string;
  created_at_sec: UnixSec;
  session_id: string;
  worker: string;
}

/**
 * One state change, for W14's timeline (W27, closing R143's second half).
 *
 * `id` is the MEMORY id, not the hypothesis id — it is what makes each row
 * addressable and what stops two transitions at the same millisecond
 * collapsing into one.
 */
export interface StateChangeRow {
  id: string;
  status: HypothesisStatus | null;
  created_at_ms: UnixMs;
}

export interface HypothesisAtoms {
  /** The `hyp-<id>` session's Orange id. */
  session_id: string | null;
  /** `researcher-<id>` — created at GO-LIVE, not at draft. */
  worker: string;
  /** null before go-live. */
  schedule_id: string | null;
  /** `<id>-<metric-slug>` for every metric in the LOCKED spec. */
  datasets: string[];
}

/**
 * The detail payload's report block, pinned byte for byte by
 * design/2026-08-20-agent-wolf.md § "The detail route's report block, pinned".
 *
 * `has_template` is first because it is the GATE: W24's Go Live button is
 * enabled iff `spec_validation.valid && report.has_template`, so this one
 * payload carries both halves, and `POST …/go-live` enforces the same two
 * server-side.
 */
export interface ReportBlock {
  /** A LOCKED, TRUSTED `report-template` exists. A forged one is not one. */
  has_template: boolean;
  /** W16's structure hash — line 1 of the template memory. `null` with no template. */
  structure_hash: string | null;
  /**
   * DOMPurify records (nodes **and** attributes) removed across every filled
   * slot, from W21's `composeReportStats` — the ONE producer in this process,
   * bound to the frame cache, so this number describes the document the frame
   * route actually serves.
   *
   * 🔴 The SIGN is the contract, never the magnitude: a library upgrade moves
   * it without anything being wrong. And `null` is NOT `0` — `0` means "the
   * sanitiser removed nothing", `null` means "no producer was wired into this
   * router, so nobody has counted". W23 must not render the second as the
   * first.
   */
  stripped_count: number | null;
  /**
   * The newest of the template row's and the report row's `created_at`, unix
   * MILLISECONDS — the memory table's unit, not the `agent_*` tables' seconds.
   * `null` when neither row exists.
   */
  updated_at_ms: UnixMs | null;
  /**
   * W20's slot drift. 🔴 `null` means **no `kind=report` memory exists at
   * all** — the empty state, which is not drift and must stay distinguishable
   * from `{orphan_slots: [], unfilled_slots: []}`, a tick that matched the
   * template exactly.
   */
  drift: { orphan_slots: string[]; unfilled_slots: string[] } | null;
  /**
   * Wolf could not read something it stored: the newest own `kind=report`
   * body is not a flat `{slotId: html}` map, or the locked template no longer
   * validates. Added to the pinned block by the orchestrator on 2026-08-26.
   *
   * 🔴 It exists so `drift: null` carries ONE meaning. Without it, "no tick
   * has run yet" and "a tick ran and its body is garbage" are the same answer
   * on the wire, and the second is the one a model inside a container can
   * cause at will — on the page carrying the verdict buttons.
   */
  unreadable: boolean;
  /**
   * Anomalies on the template row or the report row. `null` when there are
   * none.
   *
   * 🔴 It survives `unreadable`. The rows are inspected before any body is
   * read, so a forged or hostilely-retracted row found on the way to an
   * unreadable one is still reported here — otherwise the board would warn
   * about an attack this page stayed silent about.
   */
  tamper: Tamper[] | null;
}

export interface HypothesisDetail {
  hypothesis: HypothesisDetailRow;
  spec: unknown | null;
  spec_source: "hypothesis-spec" | "hypothesis-spec-candidate" | null;
  spec_validation: { valid: boolean; errors: SpecError[] };
  evaluation: unknown | null;
  notes: EvidenceRow[];
  amendments: EvidenceRow[];
  verdict: { id: string; status: string | null; content: string; created_at_ms: UnixMs } | null;
  attention_requests: AttentionRequestRow[];
  atoms: HypothesisAtoms;
  report: ReportBlock;
  /**
   * Why W10's poller moved this hypothesis to `challenged` — the `rationale`
   * it wrote into the state transition, verbatim (R143).
   *
   * 🔴 `null` on every non-`challenged` hypothesis, and that is deliberate
   * rather than incidental. A `confirmed` row's `rationale` is the free text
   * a HUMAN typed with their verdict; serving it under this name would put a
   * person's words where the UI renders a machine's reason. That text is on
   * the `verdict` block already.
   *
   * An unrecognised value is passed through verbatim rather than blanked: a
   * silently empty reason is how a poller change stays invisible.
   */
  challenge_reason: string | null;
  /**
   * Every trusted `kind=hypothesis` row, newest first — the *plural* W14's
   * timeline criterion asks for and could not get (R143).
   *
   * Forged rows and rows Wolf itself retracted are NOT here; they are on
   * `hypothesis.tamper`, from the same read.
   */
  state_history: StateChangeRow[];
  /**
   * `state_history` came back at the store's per-name cap, so there may be
   * older state rows it does not contain (W27, S3).
   *
   * 🔴 Always on the wire, `false` included. An absent flag and "we know this
   * timeline is complete" are different facts, and W13's fix round already
   * proved a page renders an absent field as whatever its default happens to
   * be (R140). A silently short timeline on the page carrying the verdict
   * controls is a dropped anomaly, which the doctrine forbids.
   */
  state_history_truncated: boolean;
}

// ── Options ─────────────────────────────────────────────────────────────

export interface CreateHypothesesRouterOptions {
  /**
   * ⚠️ ONE store instance, shared. `transition`'s `KeyedMutex` is per store
   * INSTANCE, not per process (W5's Notes): a router that constructed its own
   * store would silently stop serialising transitions against every other
   * holder of one.
   */
  store: HypothesisStore;
  client: BobClient;
  logger: Logger;
  /** Overridable so tests do not wait real seconds on the create poll. */
  sessionPollIntervalMs?: number;
  sessionPollTimeoutMs?: number;
  /** Same, for the wait on the seeded interview turn being registered. */
  seedRegisterTimeoutMs?: number;
  seedPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * W9's four human routes need `WOLF_SCHEDULE_CRON` and
   * `WOLF_TEARDOWN_DRAIN_SECONDS`. `app.ts` is NOT on W9's Files line, so it
   * still constructs this router with three options — when neither this nor
   * `provisioner` is supplied, the provisioner is built LAZILY on the first
   * call to one of those four routes, from `loadConfig()`. Nothing is read
   * from the environment, and no prompt file is opened, until then.
   */
  config?: WolfConfig;
  provisioner?: Provisioner;
  /**
   * W21's `composeReportStats`, from `createReportRouter`'s returned pair.
   *
   * 🔴 **The ONE producer of `stripped_count`.** The number can only come out
   * of `composeFrame`, which lives behind the report router's frame cache, and
   * that accessor is bound to the SAME instance — so calling it is what makes
   * this payload's number describe the document `GET …/report/frame` actually
   * serves. Running a second `sanitiseSlot` pass here would produce a second
   * number that can disagree with the served document, and the two agree
   * almost always, which is what would make it dangerous rather than obvious
   * (§ "HTTP routes added", note 2).
   *
   * OPTIONAL for the reason `provisioner` is: a caller may build this router
   * with three options. When it is absent nothing is guessed —
   * `report.stripped_count` is `null`, which is a different answer from `0`
   * and says "nobody counted" rather than "nothing was removed". Every other
   * field of the block is served either way.
   *
   * It deliberately does NOT hand back the composed `html`, and this router
   * must never ask for it: the document is safe only inside the sandboxed
   * frame the CSP header applies to, and a JSON payload the SPA renders has
   * no sandbox, no `frame-ancestors` and no opaque origin (ruled 2026-08-26).
   */
  composeReportStats?: (
    id: string,
    options?: { sessions?: SessionLookup },
  ) => Promise<ReportComposeStats | null>;
}

const createBody = z.object({
  title: z.string().trim().min(1).max(500),
  /**
   * The thesis prose. Line 1 of the memory is always the title; this is
   * everything after it.
   *
   * 🔴 **REQUIRED since 2026-09-07, and the reason is a workflow one.** It was
   * optional, and a hypothesis created without it produced a detail page with
   * a title, a disabled GO LIVE, eight empty sections and an interviewer
   * sitting in the rail asking the user to state a thesis they believed they
   * had already stated — because they had, into a field nothing read. The
   * thesis is now the interview's FIRST MESSAGE (see `seedInterview` below),
   * so an empty one is not a thinner hypothesis, it is a conversation that
   * cannot start.
   */
  thesis: z.string().trim().min(1).max(20_000),
});

/**
 * ⚠️ `POST /api/hypotheses/:id/go-live` takes **NO REQUEST BODY**. The spec
 * it locks is the newest `kind=hypothesis-spec-candidate` memory — the
 * untrusted kind by which an interview running inside a container gets its
 * proposal to the human who approves it. A body here would be a second,
 * unaudited way to set the scoreboard.
 */
const verdictBody = z.object({
  verdict: z.enum(["confirmed", "invalidated"]),
  rationale: z.string().trim().min(1).max(20_000),
});

const retireBody = z.object({
  rationale: z.string().trim().min(1).max(20_000),
});

const amendBody = z.object({
  amendment_id: z.string().trim().min(1).max(200),
  decision: z.enum(["accept", "reject"]),
  rationale: z.string().trim().min(1).max(20_000),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new WolfError("invalid", `${what} is not a valid request body`, {
      details: {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

function requireHypothesisId(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!HYPOTHESIS_ID_PATTERN.test(id)) {
    // Bare 8-hex, always. `hyp-` belongs to the SESSION NAME and nothing else
    // (§ Vocabulary) — a `hyp-`-prefixed id here is the `hyp-hyp-…` bug being
    // born, and it would also travel into a memory selector.
    throw new WolfError("invalid", "not a hypothesis id (expected 8 lowercase hex characters)", {
      details: { id: raw },
    });
  }
  return id;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Create: mapping Orange's session-create failures ────────────────────

/**
 * `POST /agent/session`'s refusals, each mapped to the taxonomy.
 *
 * The Orange client already maps the two that would otherwise be wrong:
 * a 403 whose body says "host port pool is exhausted" arrives as
 * `unavailable` carrying the upstream message VERBATIM (deleting a finished
 * session genuinely clears it — owner decision B7), and a 501 arrives as
 * `misconfigured`. What is left is the 404 and the two 409s.
 */
function classifyCreateFailure(err: unknown, sessionName: string): never {
  if (err instanceof WolfError) {
    if (err.kind === "unavailable") {
      // The port-pool refusal arrives from the client as kind `unavailable`
      // carrying Orange's own status (403), because the client preserves the
      // upstream status on every error it builds. Restated at the taxonomy's
      // 503 so the two paths that produce this condition — the POST's 403 and
      // a polled `status:"error"` — answer identically, and so a retryable
      // kind is not served behind a status that says "never retry". The
      // MESSAGE is passed through untouched: "host port pool is exhausted" is
      // the only actionable part and flattening it is the failure this
      // criterion exists to prevent.
      throw new WolfError("unavailable", err.message.trim(), {
        status: 503,
        upstreamBody: err.upstreamBody ?? "",
        details: { session: sessionName },
      });
    }
    if (err.kind === "misconfigured") throw err;
    if (err.status === 404) {
      // `no worker "interviewer" in this project` — the project has never been
      // bootstrapped, or the worker was deleted. NOT `not_found`: nothing the
      // caller asked for is missing.
      throw new WolfError(
        "misconfigured",
        `Orange has no "${INTERVIEWER_WORKER}" worker in the wolf project — run ` +
          "scripts/bootstrap-project.ts (W12) before creating a hypothesis",
        { details: { worker: INTERVIEWER_WORKER, fix: "scripts/bootstrap-project.ts" } },
      );
    }
    if (err.status === 409) {
      // Two different bodies land here — "session name already taken" and
      // `worker "interviewer" is disabled` — and both are genuine conflicts.
      // The upstream message is kept: they need different fixes.
      throw new WolfError("conflict", `Orange refused to create session ${sessionName}`, {
        status: 409,
        upstreamBody: err.upstreamBody ?? "",
        details: { session: sessionName, upstream: err.upstreamBody ?? err.message },
      });
    }
    if (err.status === 403) {
      // "no project in token": the credential carries no project, so a named
      // session cannot be scoped. Wolf's own credential, Wolf's own problem.
      throw WolfError.misconfigured(
        "WOLF_API_KEY",
        "WOLF_API_KEY: Orange refused a named session because the credential carries no " +
          "project — it must be the wolf project's API key",
      );
    }
  }
  throw err;
}

// ── Detail reads ────────────────────────────────────────────────────────

/**
 * Everything below reads memories labelled `name=<id>` for an id that is
 * already known to have a `hyp-<id>` session (the board's index, checked by
 * `store.readHypothesis`). That is the trust rule's third clause, so a
 * one-element lookup is exactly right here — and it costs no second index
 * read.
 */
function lookupFor(record: { id: string; sessionId: string | null }): SessionLookup {
  // A `Map`, not a `Set`, because W22's cross-hypothesis rule has a SECOND
  // clause — "written by this hypothesis's own `hyp-<id>` session" — and
  // `sessionIdFrom` can only answer it from a lookup that carries the id. The
  // record already holds it, so this costs no second index read; a `Set` here
  // would silently drop the clause and let an interview-session report read as
  // somebody else's.
  return new Map([[record.id, record.sessionId]]);
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline < 0 ? text : text.slice(0, newline);
}

/**
 * The interview's first message: the hypothesis id, then the user's thesis.
 *
 * 🔴 **The id has to be in here because the model cannot see it anywhere
 * else.** A session container is given `SESSION_ID` (Orange's 32-hex id) and
 * `SESSION_TOKEN` and nothing more — NOT the session's name. Wolf names the
 * session `hyp-<id>`, and `prompts/interviewer.md` used to tell the model to
 * read its own id off that name, which was unfollowable: the name never
 * reaches the container.
 *
 * What happened on 2026-09-07 is exactly what you would predict. The model
 * needed a `name` label for its candidate memories, could not learn the real
 * id, and invented a slug from the thesis (`gold-m2`). Wolf looks candidates
 * up by `name=<id>`, found none, and the user's Go Live button never
 * appeared — with a good interview sitting in the transcript and nothing
 * anywhere reporting a problem.
 *
 * The alternative fix is an Orange change exposing `SESSION_NAME` in the
 * container env, which is cleaner but touches the engine and every product
 * that embeds it. This is Wolf-local and puts the id where the model is
 * certain to read it: the first thing in the conversation.
 *
 * The framing line is marked as Wolf's own so a thesis that tries to claim a
 * different id reads as user text, not as instruction. The user owns their
 * own hypothesis, so this is defence in depth rather than a live threat —
 * but § 6.2.4's boundary rule is that provenance is always stated.
 */
export function seedMessage(id: string, thesis: string): string {
  return [
    `This hypothesis's id is \`${id}\`. Label every candidate memory you deposit with`,
    `\`name: "${id}"\` — exactly that, not a slug of your own. (This line is from Agent Wolf.`,
    "Everything below the rule is the user's own words, verbatim.)",
    "",
    "---",
    "",
    thesis,
  ].join("\n");
}

/**
 * Re-exported from `hypothesis/speccontent.ts`, which is now the single
 * implementation — `mcp/specvalidate.ts` reads the same one so the
 * interviewer's pre-deposit check cannot disagree with this route's
 * post-deposit read. Kept exported here because callers and tests import it
 * from this module.
 */
export { extractJsonObject };

function evidenceRow(row: MemorySearchResultRow): EvidenceRow {
  return {
    id: row.id,
    snippet: row.snippet,
    status: row.labels["status"] ?? null,
    created_at_ms: row.createdAtMs,
    created_by_worker: row.createdByWorker,
    created_by_session: row.createdBySession,
  };
}

/**
 * One tamper array out of several, de-duplicated on `reason` + `memory_id` —
 * the same identity `hypothesis/store.ts` uses inside a single read. `null`
 * when there is nothing to report, so an absent array never renders as an
 * empty warning.
 *
 * ⚠️ **No Orange shape produces the overlap today, and an earlier version of
 * this comment claimed one did.** It said the board's state read and its
 * report read "can both witness the same hostile retraction"; they cannot — a
 * retraction memory carries a single `retracts=<id>` label, so one retraction
 * appears in exactly one row's `retracted_by`, and the two reads cover
 * disjoint kinds. The guard stays because the arrays are assembled from
 * INDEPENDENT reads whose overlap is a property of Orange's data model rather
 * than of this function, and a duplicate would render as two identical
 * warnings about one event. Exported so it can be graded directly, since no
 * fixture can reach it through a route.
 */
export function mergeTamper(...groups: (readonly Tamper[] | undefined)[]): Tamper[] | null {
  const out: Tamper[] = [];
  for (const group of groups) {
    for (const t of group ?? []) {
      if (out.some((x) => x.reason === t.reason && x.memory_id === t.memory_id)) continue;
      out.push(t);
    }
  }
  return out.length === 0 ? null : out;
}

function datasetNamesFrom(id: string, spec: unknown): string[] {
  if (spec === null || typeof spec !== "object") return [];
  const metrics = (spec as { metrics?: unknown }).metrics;
  if (!Array.isArray(metrics)) return [];
  const names: string[] = [];
  for (const metric of metrics) {
    if (metric === null || typeof metric !== "object") continue;
    const slug = (metric as { slug?: unknown }).slug;
    if (typeof slug === "string" && slug !== "") names.push(`${id}-${slug}`);
  }
  return names;
}

// ── The router ──────────────────────────────────────────────────────────

export function createHypothesesRouter(options: CreateHypothesesRouterOptions): Router {
  const { store, client, logger } = options;
  const pollIntervalMs = options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.sessionPollTimeoutMs ?? DEFAULT_SESSION_POLL_TIMEOUT_MS;
  const seedRegisterTimeoutMs = options.seedRegisterTimeoutMs ?? DEFAULT_SEED_REGISTER_TIMEOUT_MS;
  const seedPollIntervalMs = options.seedPollIntervalMs ?? DEFAULT_SEED_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;

  const router = Router();
  // PER ROUTER (R79), and narrowed further to this router's own path prefix:
  // never `app.use(requireSignedIn)`, because W7's `/mcp` and
  // `/series/download` live at the app root precisely because a session
  // container has no cookie and reaches wolf-api directly at the DinD
  // gateway. The path argument means a request this router does not serve
  // passes through untouched (a 404 stays a 404, and a later ticket mounting
  // a public route after this one is not silently 401ed).
  router.use("/api/hypotheses", requireSignedIn);

  /**
   * Built on FIRST USE, never at construction: `app.ts` is not on W9's Files
   * line and still passes three options, so the fallback has to read
   * `loadConfig()` itself — and doing that eagerly would make every existing
   * route test depend on the ambient environment and open two prompt files.
   */
  let built: Provisioner | undefined = options.provisioner;
  function provisioner(): Provisioner {
    built ??= createProvisioner({ client, store, logger, config: wolfConfig() });
    return built;
  }

  /**
   * Resolved on FIRST USE and memoised, for the same reason the provisioner is
   * built lazily: a caller may construct this router with three options, and
   * reading the environment eagerly would make every existing route test
   * depend on the ambient one. W22 needs it for `WOLF_REPORT_MAX_BYTES`, which
   * is a PARAMETER to the template parser and never read inside it.
   */
  let resolvedConfig: WolfConfig | undefined = options.config;
  function wolfConfig(): WolfConfig {
    resolvedConfig ??= loadConfig();
    return resolvedConfig;
  }

  function idParam(req: Request): string | undefined {
    const raw: unknown = req.params["id"];
    return typeof raw === "string" ? raw : undefined;
  }

  async function listKind(
    id: string,
    kind: string,
    opts: { includeRetracted?: boolean } = {},
  ): Promise<MemorySearchResultRow[]> {
    return client.listMemories({
      selector: `kind=${kind},name=${id}`,
      limit: DETAIL_ROW_LIMIT,
      ...(opts.includeRetracted === true ? { includeRetracted: true } : {}),
    });
  }

  /**
   * The newest row that is trusted AND that Wolf itself has not withdrawn.
   * A retraction whose own provenance is non-empty is IGNORED — an untrusted
   * actor cannot withdraw server-written state (§ "Retraction").
   */
  function newestTrusted(
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

  /**
   * Orange's session create is ASYNCHRONOUS and reports no provisioning
   * failure on the POST: it answers `200 {id, status:"creating", workflowId}`
   * and provisions in a background goroutine (`go/httpapi/session.go`). A
   * failure lands on the row as `status:"error"` plus `create_error`, so the
   * only way to know a session exists is to poll the by-name route until the
   * status leaves `creating`.
   */
  async function waitForSession(
    sessionName: string,
  ): Promise<{ id: string; status: string }> {
    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      const session = await client.getSessionByName(sessionName);
      if (session.status === "error") {
        // `create_error` is passed through VERBATIM. "host port pool is
        // exhausted" arrives on this path too, and flattening it into "could
        // not create" throws away the only actionable part.
        throw new WolfError(
          "unavailable",
          session.createError && session.createError !== ""
            ? session.createError
            : `Orange could not provision session ${sessionName}`,
          { status: 503, details: { session: sessionName } },
        );
      }
      if (session.status !== "creating") {
        return { id: session.id, status: session.status };
      }
      if (Date.now() >= deadline) {
        throw new WolfError(
          "unavailable",
          `Orange session ${sessionName} was still "creating" after ${Math.round(
            pollTimeoutMs / 1000,
          )}s`,
          { status: 503, details: { session: sessionName } },
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  // ── GET /api/hypotheses ───────────────────────────────────────────────

  router.get("/api/hypotheses", (_req: Request, res: Response, next) => {
    void (async () => {
      // Request 1 of 2: the board read, `latest_per=name` with
      // `include_retracted=1` (inside `readBoard`). Request 2: the
      // evaluations. Both are O(1) in the hypothesis count — twelve
      // hypotheses cost the same two requests as one.
      const records: HypothesisRecord[] = await store.readBoard();
      // Every hypothesis's `hyp-<id>` session id, which `readBoard` already
      // resolved. It is both the trust rule's third clause (`has`) and the
      // cross-hypothesis rule's second (`get`), and building it here is what
      // keeps the two follow-up reads from walking the session list again.
      const sessions: SessionLookup = new Map(
        records.map((record) => [record.id, record.sessionId]),
      );
      const [summaries, reports, attention] = await Promise.all([
        store.readEvaluationSummaries(sessions),
        store.readReportSummaries(sessions),
        // ONE project-wide read for the whole board, not one per hypothesis
        // (UI design § 4 point 3). It is NOT a `latest_per` request — it is
        // not a memory read at all — so the board's budget is now: three
        // `latest_per` requests, plus this one attention read, plus one
        // per-name read per ATTACKED hypothesis (R187).
        openAttentionRequests(),
      ]);
      // 🔴 Report DRIFT is deliberately absent from this list. Drift compares
      // a template's structure hash against a report's slot ids, and both need
      // FULL-CONTENT reads — two per hypothesis, which is exactly the O(N)
      // the board's fast path exists to avoid. It stays on the detail page;
      // `headline === null` on a `live` row is the cheap board-level proxy
      // (§ 4 point 4).
      const named = new Set<string>();
      for (const record of records) {
        if (attention.some((request) => attentionRequestNames(request, record.id, record.sessionId))) {
          named.add(record.id);
        }
      }
      res
        .status(200)
        .json(
          records.map((record) =>
            boardRow(record, summaries.get(record.id), reports.get(record.id), named.has(record.id)),
          ),
        );
    })().catch(next);
  });

  /**
   * Every OPEN attention request in the project, once per board read.
   *
   * A board that cannot list attention requests is still a board: the read
   * degrades to "nobody asked" and is logged, exactly as the detail page's
   * does. It costs the third clause of rule 1 — a hypothesis whose only
   * signal was an unanswered question drops out of NEEDS A HUMAN — and it
   * costs nothing else: `challenged` and tamper are read from memory and are
   * unaffected.
   */
  async function openAttentionRequests(): Promise<AttentionRequestRecord[]> {
    try {
      return await client.listAttentionRequests({ state: "open" });
    } catch (err) {
      logger.warn({ err }, "board: could not list attention requests — no row is tiered by one");
      return [];
    }
  }

  function boardRow(
    record: HypothesisRecord,
    summary: EvaluationSummary | undefined,
    report: ReportSummary | undefined,
    attentionRequested: boolean,
  ): BoardRow {
    const row: Omit<BoardRow, "attention_tier"> = {
      id: record.id,
      // A hypothesis in the session index whose state row is missing (or
      // forged, or hostilely retracted) keeps its place with nulls and its
      // tamper array — an anomaly is RENDERED, never dropped.
      title: record.title,
      title_truncated: record.titleTruncated,
      owner: record.owner,
      status: record.status,
      support_score: summary?.supportScore ?? null,
      conditions_summary:
        summary === undefined
          ? null
          : {
              tripped: summary.tripped,
              holding: summary.holding,
              indeterminate: summary.indeterminate,
              evaluated_at_ms: summary.evaluatedAtMs,
            },
      updated_at_ms: record.updatedAtMs,
      // No entry at all means no `kind=report` row for this hypothesis, which
      // is `null`. A row whose line 1 was blank comes back as `""` and stays
      // `""`.
      headline: report?.headline ?? null,
      // Already resolved by `readBoard`; serving it here is what LETS
      // `/archive` stop paying a detail read per terminal row (R138). It has
      // not stopped yet — `web/` does not read this field. See the field's
      // docstring above.
      restated_from: record.restatedFrom,
    };
    // 🔴 ABSENT STAYS ABSENT. `summary?.attention ?? 0` here would make "this
    // memory predates the token" indistinguishable from "the evaluator raised
    // nothing", and W13 renders a zero count as no chip at all — so the bug
    // would be invisible on the page as well as on the wire.
    if (summary?.attention !== undefined) row.attention_count = summary.attention;
    if (summary?.stale !== undefined) row.stale_count = summary.stale;
    // The report read's anomalies join the state row's on the SAME array: a
    // cross-hypothesis report write puts the hypothesis in NEEDS A HUMAN,
    // which is where an attack on what it says belongs, and the detail page
    // reports the identical anomaly in `report.tamper`. (Unlike the evaluation
    // read, which only logs — its anomalies have no detail-page counterpart.)
    //
    // ⚠️ The pair joined here is **`kind=hypothesis` × `kind=report`**, and
    // `mergeTamper`'s de-duplication is DORMANT because of that pairing: a
    // retraction memory carries one scalar `retracts=<id>` label, so it lands
    // in exactly one row's `retracted_by`, and two disjoint kinds cannot
    // witness the same anomaly. **A future call joining two reads of the SAME
    // kind makes duplicates reachable immediately**, and nothing will fail —
    // the dedup simply starts doing work. Restate the pair here if you change
    // it.
    const tamper = mergeTamper(record.tamper, report?.tamper);
    if (tamper !== null) row.tamper = tamper;
    // Computed LAST, over the assembled row: rule 1 reads the merged tamper
    // array, so a cross-hypothesis report write has to be on the row before
    // the tier is decided.
    return { ...row, attention_tier: attentionTierFor(row, attentionRequested) };
  }

  /**
   * Send the user's own thesis prose into the interview as its first message.
   *
   * The text is passed VERBATIM and unframed. It is the user's sentence, and
   * the interviewer's prompt opens by asking for exactly this ("To get
   * started, I need you to state your thesis") — so a wrapper like "The user
   * says:" would put words in their mouth and change what the model is
   * replying to.
   *
   * Fire-and-forget by design; see the call site.
   */

  async function seedInterview(
    id: string,
    sessionName: string,
    sessionId: string,
    thesis: string,
  ): Promise<void> {
    // 🔴 THE TURN IS STARTED HERE AND DELIBERATELY NOT AWAITED TO COMPLETION,
    // but this function DOES wait for it to be REGISTERED. Those are different
    // moments and the difference was a real race.
    //
    // Orange's message route streams the whole model turn down its response,
    // so awaiting it would add the turn's duration to the create. But
    // returning the instant the request is dispatched was worse: the browser
    // navigated, the chat frame mounted, asked Orange "is a turn in flight?",
    // was told no — because the POST had not yet reached
    // `beginActiveQuery` — and never asked again. The reader saw their own
    // message and then silence, while the turn streamed to nobody. Reloading
    // showed a completed answer, which is the tell: the events were being
    // persisted all along.
    //
    // `sessionId` comes from the create route's own `waitForSession`, which
    // already returns it. Looking it up again cost a fourth by-name request
    // and broke the poll-count assertion that proves the wait loop works.
    let failed: unknown = null;
    const turn = client.sendMessage(sessionId, seedMessage(id, thesis)).catch((err: unknown) => {
      // Held, not thrown: this promise outlives the wait below, and an
      // unhandled rejection would take the process down.
      failed = err;
    });
    void turn;

    const deadline = Date.now() + seedRegisterTimeoutMs;
    for (;;) {
      if (failed !== null) {
        logger.warn(
          {
            id,
            session: sessionName,
            err: failed instanceof Error ? failed.message : String(failed),
          },
          "interview seed failed — the hypothesis is fine; the user can type the thesis themselves",
        );
        return;
      }
      // A FAILED probe is not "idle". It is thrown by the client, and it must
      // not be read as "no turn is running" — so it ends the wait the same way
      // the deadline does, rather than looping on an unreachable session.
      let activeQueryId: string | null = null;
      try {
        ({ activeQueryId } = await client.getSessionStatus(sessionId));
      } catch (err: unknown) {
        logger.warn(
          { id, session: sessionName, err: err instanceof Error ? err.message : String(err) },
          "could not confirm the interview turn started; answering anyway",
        );
        return;
      }
      if (activeQueryId !== null) {
        logger.info({ id, session: sessionName, activeQueryId }, "interview turn is in flight");
        return;
      }
      if (Date.now() >= deadline) {
        // Not an error: the turn may simply have been very fast, or Orange may
        // never have registered it. Either way the hypothesis is real and the
        // create must not fail on a confirmation that is a convenience.
        logger.warn(
          { id, session: sessionName },
          "no in-flight turn appeared within the seed window; answering anyway",
        );
        return;
      }
      await sleep(seedPollIntervalMs);
    }
  }

  // ── POST /api/hypotheses ──────────────────────────────────────────────

  router.post("/api/hypotheses", (req: Request, res: Response, next) => {
    void (async () => {
      const user = signedInUser(req);
      const body = parseBody(createBody, req.body, "POST /api/hypotheses");

      const id = store.newId();
      // The `hyp-` prefix is added HERE and nowhere else (§ Vocabulary). The
      // id itself stays bare — in the memory's `name` label, in every
      // selector, and in every dataset name.
      const sessionName = sessionNameForHypothesis(id);

      try {
        await client.createSession({ name: sessionName, worker: INTERVIEWER_WORKER });
      } catch (err) {
        classifyCreateFailure(err, sessionName);
      }
      // Nothing is written to memory until the session is real. If the
      // session never reaches a healthy status, no hypothesis memory is left
      // behind — an id in the memory bus with no session behind it can never
      // be trusted (clause 3) and would sit on the board forever as an
      // anomaly nobody created.
      const session = await waitForSession(sessionName);

      await store.appendState({
        id,
        status: "draft",
        title: body.title,
        thesis: body.thesis,
        ownerEmail: user.email,
      });

      logger.info({ id, session: sessionName, owner: user.email }, "hypothesis created");

      // ── The interview starts itself, and is IN FLIGHT before we answer ─
      //
      // Awaited, but only as far as the turn being registered — see
      // `seedInterview`. The browser must not be able to mount the chat frame
      // and ask "is a turn running?" before the answer is yes. It never
      // throws: a hypothesis whose seed failed is still a real hypothesis the
      // user can type into.
      await seedInterview(id, sessionName, session.id, body.thesis);
      res.status(201).json({ id });
    })().catch(next);
  });

  // ── GET /api/hypotheses/:id ───────────────────────────────────────────

  router.get("/api/hypotheses/:id", (req: Request, res: Response, next) => {
    void (async () => {
      const id = requireHypothesisId(idParam(req));
      // 404s when the id is not in the session index — the authoritative
      // index of hypotheses is the SESSION LIST, never memory.
      //
      // The history rides the SAME per-name read the record comes from: the
      // older rows were already being fetched and thrown away (W27/R143).
      const { record, history, historyTruncated } = await store.readHypothesisWithHistory(id);
      const sessions = lookupFor(record);

      const [specRows, candidateRows, evaluationRows, verdictRows, noteRows, amendmentRows] =
        await Promise.all([
          listKind(id, KIND_SPEC, { includeRetracted: true }),
          listKind(id, KIND_SPEC_CANDIDATE),
          listKind(id, KIND_EVALUATION, { includeRetracted: true }),
          listKind(id, KIND_VERDICT, { includeRetracted: true }),
          listKind(id, KIND_RESEARCH_NOTE),
          listKind(id, KIND_SPEC_AMENDMENT),
        ]);

      // The spec: the newest TRUSTED `hypothesis-spec` once one exists,
      // otherwise the newest `hypothesis-spec-candidate` — the untrusted kind
      // by which an interview running inside a container gets its proposed
      // spec to the human who approves it. `spec_source` is what stops W13
      // rendering a candidate as locked.
      const lockedRow = newestTrusted(specRows, sessions);
      const candidateRow = candidateRows[0];
      let spec: unknown | null = null;
      let specSource: HypothesisDetail["spec_source"] = null;
      let specUnreadable = false;
      const specRow = lockedRow ?? candidateRow;
      if (specRow !== undefined) {
        specSource = lockedRow !== undefined ? KIND_SPEC : KIND_SPEC_CANDIDATE;
        const full = await client.getMemory(specRow.id);
        const parsed = extractJsonObject(full.content);
        if (parsed === undefined) {
          specUnreadable = true;
        } else {
          spec = parsed;
        }
      }

      const evaluationRow = newestTrusted(evaluationRows, sessions);
      const evaluation =
        evaluationRow === undefined
          ? null
          : (extractJsonObject((await client.getMemory(evaluationRow.id)).content) ?? null);

      const verdictRow = newestTrusted(verdictRows, sessions);
      const verdict =
        verdictRow === undefined
          ? null
          : {
              id: verdictRow.id,
              status: verdictRow.labels["status"] ?? null,
              content: (await client.getMemory(verdictRow.id)).content,
              created_at_ms: verdictRow.createdAtMs,
            };

      const detail: HypothesisDetail = {
        hypothesis: detailRow(record),
        spec,
        spec_source: specSource,
        spec_validation: specValidation(spec, specSource, specUnreadable),
        evaluation,
        notes: noteRows.map(evidenceRow),
        amendments: amendmentRows.map(evidenceRow),
        verdict,
        attention_requests: await attentionRequestsFor(id, record.sessionId),
        report: await reportBlockFor(id, sessions),
        challenge_reason: await challengeReasonFor(record),
        state_history: history.map((change) => ({
          id: change.memoryId,
          status: change.status,
          created_at_ms: change.createdAtMs,
        })),
        state_history_truncated: historyTruncated,
        atoms: {
          session_id: record.sessionId,
          worker: researcherWorkerFor(id),
          schedule_id: await scheduleIdFor(id),
          datasets: specSource === KIND_SPEC ? datasetNamesFrom(id, spec) : [],
        },
      };
      res.status(200).json(detail);
    })().catch(next);
  });

  // ── The four human routes (W9) ────────────────────────────────────────
  //
  // All four sit behind `requireSignedIn` (mounted on this router's own path
  // prefix above), and they are the ONLY path to `confirmed`, `invalidated`
  // or `archived`. Nothing inside a container can reach them: they are
  // cookie-authenticated, and every memory they write goes out over
  // `POST /agent/memories` with Wolf's own API key, which is what makes the
  // provenance empty and the row trusted.

  router.post("/api/hypotheses/:id/go-live", (req: Request, res: Response, next) => {
    void (async () => {
      const user = signedInUser(req);
      const id = requireHypothesisId(idParam(req));
      await requireLockedTemplate(id);
      const result = await provisioner().goLive({ id, email: user.email });
      res.status(200).json(result);
    })().catch(next);
  });

  router.post("/api/hypotheses/:id/verdict", (req: Request, res: Response, next) => {
    void (async () => {
      const user = signedInUser(req);
      const id = requireHypothesisId(idParam(req));
      const body = parseBody(verdictBody, req.body, "POST /api/hypotheses/:id/verdict");
      const result = await provisioner().verdict({
        id,
        email: user.email,
        verdict: body.verdict,
        rationale: body.rationale,
      });
      res.status(200).json(result);
    })().catch(next);
  });

  router.post("/api/hypotheses/:id/retire", (req: Request, res: Response, next) => {
    void (async () => {
      const user = signedInUser(req);
      const id = requireHypothesisId(idParam(req));
      const body = parseBody(retireBody, req.body, "POST /api/hypotheses/:id/retire");
      const result = await provisioner().retire({
        id,
        email: user.email,
        rationale: body.rationale,
      });
      res.status(200).json(result);
    })().catch(next);
  });

  router.post("/api/hypotheses/:id/amend", (req: Request, res: Response, next) => {
    void (async () => {
      const user = signedInUser(req);
      const id = requireHypothesisId(idParam(req));
      const body = parseBody(amendBody, req.body, "POST /api/hypotheses/:id/amend");
      const result = await provisioner().amend({
        id,
        email: user.email,
        amendmentId: body.amendment_id,
        decision: body.decision,
        rationale: body.rationale,
      });
      res.status(200).json(result);
    })().catch(next);
  });

  /**
   * The pinned `report` block (§ "The detail route's report block, pinned").
   *
   * It goes through W15's `store.readTemplate` / `store.readLatestReport` and
   * nowhere else, so the trust rule, the retraction rule and W22's
   * cross-hypothesis rule have exactly ONE implementation each — and so this
   * page and W21's frame cannot disagree about which template is locked or
   * which report is this hypothesis's own.
   */
  async function reportBlockFor(id: string, sessions: SessionLookup): Promise<ReportBlock> {
    const [templateRead, degraded] = await Promise.all([
      store.readTemplate(id, { sessions }),
      readLatestReportOrDegrade(id, sessions),
    ]);
    const template = templateRead.template;
    const report = degraded.read.report;
    let unreadable = degraded.unreadable;

    // Slot drift needs the template's DECLARED slot ids, which only the
    // parser knows. `parseTemplate` never throws for bad template input — it
    // answers `{valid: false, errors}` — so a stored template that no longer
    // validates cannot take this page down.
    let declared: string[] = [];
    if (template !== null) {
      const parsed = parseTemplate(template.html, wolfConfig().reportMaxBytes);
      if (parsed.valid) {
        declared = parsed.template.slotIds;
      } else {
        // Wolf's own stored state is unusable: it passed this same parser
        // before it was written, so a validator change or a shrunken budget
        // is the only way here. Declaring NO slots makes every filled slot an
        // orphan, which surfaces loudly on the page instead of hiding — and
        // the frame route answers `internal` for the same state.
        unreadable = true;
        logger.error(
          { id, memory_id: template.memoryId, errors: parsed.errors },
          "detail report block: the stored template no longer validates",
        );
      }
    }
    const drift: DriftResult = detectDrift(declared, report?.slots ?? null);

    // The newer of the two, picked rather than `Math.max`-ed: `UnixMs` is a
    // BRANDED type and `Math.max` would launder the unit away.
    const updatedAtMs: UnixMs | null =
      report !== null && template !== null
        ? report.createdAtMs >= template.createdAtMs
          ? report.createdAtMs
          : template.createdAtMs
        : (report?.createdAtMs ?? template?.createdAtMs ?? null);

    return {
      has_template: template !== null,
      structure_hash: template?.structureHash ?? null,
      stripped_count: await strippedCountFor(id, sessions, template !== null),
      updated_at_ms: updatedAtMs,
      drift:
        drift === null
          ? null
          : { orphan_slots: drift.orphanSlotIds, unfilled_slots: drift.unfilledSlotIds },
      unreadable,
      // ⚠️ The pair joined here is **`kind=report-template` × `kind=report`**
      // — disjoint kinds again, so `mergeTamper`'s de-duplication is dormant
      // for the same reason it is on the board row. See the note at that call
      // site; joining two reads of ONE kind would make duplicates reachable
      // and silently change the assumption.
      tamper: mergeTamper(templateRead.tamper, degraded.read.tamper),
    };
  }

  /**
   * `readLatestReport` THROWS `invalid` when a report's body is not a flat
   * `{slotId: html}` map, and that is right for W21's frame — but a model
   * inside a container is what writes that body, so letting it reach here
   * would hand untrusted content a way to take down the page carrying the
   * VERDICT BUTTONS. It is logged and degraded to "no readable report"
   * instead; the frame route still reports the real failure.
   */
  async function readLatestReportOrDegrade(
    id: string,
    sessions: SessionLookup,
  ): Promise<{ read: ReportRead; unreadable: boolean }> {
    try {
      return { read: await store.readLatestReport(id, { sessions }), unreadable: false };
    } catch (err) {
      if (err instanceof WolfError && err.kind === "invalid") {
        logger.error({ id, err }, "detail report block: the newest report body does not parse");
        // 🔴 `reportTamperFrom`, not `[]`. The store witnessed its anomalies
        // while picking the row, BEFORE it read the body that failed, and
        // discarding them here is what let a cross-hypothesis forgery show on
        // the board and vanish from this page.
        return { read: { report: null, tamper: reportTamperFrom(err) }, unreadable: true };
      }
      // Everything else propagates. An Orange outage or a bug is NOT an
      // unreadable report: answering 200 with an empty block would tell the
      // operator the report layer is idle while the upstream is down.
      throw err;
    }
  }

  /**
   * The ONE `stripped_count` in this process, or `null` — never a second
   * sanitiser pass and never a guessed zero. Composing can fail on the same
   * untrusted content the guard above is about, so a failure costs the count
   * and nothing else.
   */
  async function strippedCountFor(
    id: string,
    sessions: SessionLookup,
    hasTemplate: boolean,
  ): Promise<number | null> {
    if (options.composeReportStats === undefined || !hasTemplate) return null;
    try {
      const stats = await options.composeReportStats(id, { sessions });
      return stats?.strippedCount ?? null;
    } catch (err) {
      logger.error({ id, err }, "detail report block: composing the frame stats failed");
      return null;
    }
  }

  /**
   * R45's server-side half, and the second gate on go-live (W22).
   *
   * W24's Go Live button is enabled iff `spec_validation.valid &&
   * report.has_template`, and `GET /api/hypotheses/:id` now carries both. This
   * is the backstop for the race — and for anything that is not the button.
   * **W9 is not reopened**: the spec half stays entirely in the provisioner,
   * this half stays entirely here, and there is one 422 body shape between
   * them (`specRejection`).
   *
   * ⚠️ Ordering: it runs BEFORE the provisioner, so a hypothesis that is both
   * template-less and not a draft answers 422 rather than 409. That is
   * deliberate — this is the GATE, evaluated exactly where the button
   * evaluates it — and both answers are refusals that write nothing.
   *
   * It is the SAME read the detail block reports, so a `report-template`
   * forged from inside a container does not open the gate either: it fails
   * `isTrusted` and `readTemplate` hands back `null`.
   */
  async function requireLockedTemplate(id: string): Promise<void> {
    // 404s when the id is not in the session index, exactly as every other
    // per-hypothesis read does.
    const { template } = await store.readTemplate(id);
    if (template !== null) return;
    throw specRejection(
      [
        {
          path: "report.has_template",
          message:
            "no report template has been locked for this hypothesis — author one before going live",
        },
      ],
      `hypothesis ${id} cannot go live: no report template is locked`,
    );
  }

  /**
   * The `challenged` state row's `rationale`, read in full.
   *
   * It cannot come off the snippet: a challenged row's content carries the
   * whole evaluation snapshot as fenced JSON, so the rationale is far past
   * the 500 characters the list route returns. The read is paid ONLY for a
   * challenged hypothesis — see `HypothesisDetail.challenge_reason` for why
   * the field is gated on the status rather than served for every state.
   *
   * 🔴 **It degrades to `null` rather than failing the page**, like every
   * other read on this handler — the attention list, the schedule list, the
   * report block. This is the LEAST important field on the page and it sits
   * on the page carrying the human's verdict controls: letting a transient
   * Orange failure here take down the spec, the scoreboard, the verdict and
   * the tamper warnings would trade the whole decision surface for one
   * sentence. `error` rather than `warn` because, unlike a missing schedule,
   * a state row Wolf itself wrote and cannot read back is a real fault.
   *
   * The UI cannot tell this apart from "the poller recorded no rationale",
   * and that is the accepted cost: both render the pinned absent-reason
   * sentence W14 already ships, which is true either way.
   */
  async function challengeReasonFor(record: HypothesisRecord): Promise<string | null> {
    if (record.status !== "challenged" || record.statusMemoryId === null) return null;
    try {
      const full = await client.getMemory(record.statusMemoryId);
      return parseHypothesisContent(full.content).rationale;
    } catch (err) {
      logger.error(
        { id: record.id, memory_id: record.statusMemoryId, err },
        "detail: could not read the challenged state row — challenge_reason omitted",
      );
      return null;
    }
  }

  function detailRow(record: HypothesisRecord): HypothesisDetailRow {
    const row: HypothesisDetailRow = {
      id: record.id,
      session_name: record.sessionName,
      session_id: record.sessionId,
      title: record.title,
      title_truncated: record.titleTruncated,
      owner: record.owner,
      status: record.status,
      status_memory_id: record.statusMemoryId,
      updated_at_ms: record.updatedAtMs,
      restated_from: record.restatedFrom,
    };
    if (record.tamper !== undefined) row.tamper = record.tamper;
    return row;
  }

  /**
   * W3's validator, run over whichever spec was returned, so W13's Go Live
   * button can list the blocking reasons BEFORE the click — W9's 422 only
   * exists after it. `web/` never imports the validator.
   */
  function specValidation(
    spec: unknown | null,
    source: HypothesisDetail["spec_source"],
    unreadable: boolean,
  ): { valid: boolean; errors: SpecError[] } {
    if (unreadable) {
      return {
        valid: false,
        errors: [{ path: "$", message: "the spec memory does not contain a JSON object" }],
      };
    }
    if (spec === null || source === null) {
      return {
        valid: false,
        errors: [
          {
            path: "$",
            message:
              "no spec has been proposed yet — the interview has to deposit a " +
              "hypothesis-spec-candidate memory first",
          },
        ],
      };
    }
    const result = validateSpec(spec);
    return result.valid ? { valid: true, errors: [] } : { valid: false, errors: result.errors };
  }

  /**
   * Attention requests are attributed to this hypothesis when the row's
   * `worker` is `researcher-<id>` **or** its `session_id` is the `hyp-<id>`
   * session's id: the row carries both (`go/agentdb/attention.go:55-57`), and
   * an interviewer ask carries only the session. `created_at`/`expires_at` on
   * that row are unix SECONDS, hence the field name.
   *
   * Surfacing lives here, in the route that renders it — W10's poller does
   * not read attention requests.
   */
  async function attentionRequestsFor(
    id: string,
    sessionId: string | null,
  ): Promise<AttentionRequestRow[]> {
    let rows: AttentionRequestRecord[];
    try {
      rows = await client.listAttentionRequests({ state: "open" });
    } catch (err) {
      // A detail page that cannot list attention requests is still a useful
      // detail page. Everything else on it is already read.
      logger.warn({ id, err }, "could not list attention requests");
      return [];
    }
    return rows
      .filter((row) => attentionRequestNames(row, id, sessionId))
      .map((row) => ({
        id: row.id,
        message: row.message,
        created_at_sec: row.createdAtSec,
        session_id: row.sessionId,
        worker: row.worker,
      }));
  }

  /** null before go-live: the schedule is created with the researcher worker. */
  async function scheduleIdFor(id: string): Promise<string | null> {
    const worker = researcherWorkerFor(id);
    try {
      const schedules = await client.listSchedules();
      return schedules.find((schedule) => schedule.worker === worker)?.id ?? null;
    } catch (err) {
      logger.warn({ id, err }, "could not list schedules");
      return null;
    }
  }

  return router;
}
