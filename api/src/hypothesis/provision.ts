/**
 * Go-live provisioning and ordered teardown — the two orderings this product
 * is graded on.
 *
 * design/2026-08-20-agent-wolf.md, ticket W9. Two things in this file are
 * correctness properties rather than style, and both are asserted by
 * `provision.test.ts` as ORDERED SEQUENCES, never as unordered sets:
 *
 * ## 1. Provisioning order, because rollback has to be possible
 *
 * Bob's memories are append-only: there is no update and no delete, and
 * "changing" one means appending a newer one. So the trusted
 * `kind=hypothesis, status=live` row must be written **last**. Written
 * earlier, a rollback is unsatisfiable — nothing can take it back, and the
 * hypothesis is live on the board with no worker and no schedule behind it.
 *
 *   1. append the trusted `kind=hypothesis-spec, status=locked` memory
 *      carrying the candidate JSON verbatim (`POST /agent/memories` → 201)
 *   2. `PUT /agent/workers/researcher-<id>` with the composed prompt
 *   3. `POST /agent/schedules` in worker mode
 *   4. append the trusted `kind=hypothesis, status=live` memory — LAST
 *
 * A failure at 2, 3 or 4 deletes whatever 2 and 3 created, in teardown order
 * (schedule first). **Step 1's memory is deliberately NOT withdrawn**: an
 * orphaned locked spec with no `live` row is inert, and a retraction is
 * itself an append that a later reader has to reason about. Do not "fix"
 * this by writing a `retracts` memory.
 *
 * ## 2. Teardown order, because the scheduler does not check `enabled`
 *
 *   1. `DELETE /agent/schedules/{id}` — **first**. Draining before this
 *      cannot terminate: the scheduler mints a delivery every tick and only
 *      checks that the worker *exists*
 *      (`go/cmd/agentd/scheduler.go:363-371`); dispatch then fails it with
 *      `worker "x" is disabled` (`go/cmd/agentd/dispatch.go:246-248`), and
 *      only the five-consecutive-failure streak
 *      (`go/cmd/agentd/scheduler.go:768-790`) would ever stop it.
 *   2. **Drain pending deliveries for this worker.** There is no
 *      delivery-cancel route and none is being added — deliveries are
 *      read-only over HTTP, and `DeliveryQuery` has no `worker` field
 *      (`go/agentdb/events.go:296-307`) while the row itself does
 *      (`EventDelivery.Worker`, `:263`). So Wolf polls `?status=pending` and
 *      filters client-side, bounded by `WOLF_TEARDOWN_DRAIN_SECONDS`.
 *   3. `DELETE /agent/workers/researcher-<id>`.
 *   4. Delete the tick sessions (`GET /agent/sessions?user_email=*&worker=…`).
 *      Nothing else deletes them: the 30-minute archive loop returns the port
 *      but leaves one row per day per hypothesis forever.
 *   5. `DELETE /agent/session/{id}` for the `hyp-<id>` session.
 *
 * **Teardown never deletes datasets.** They are the evidence behind the
 * verdict, and O3's 30-version reaper is why the verdict memory carries the
 * whole evaluation snapshot instead of a promise to read the data back later.
 *
 * A tick session still in flight is allowed to finish. Anything it writes
 * carries a session id in its provenance and is untrusted by construction, so
 * it cannot change state.
 */

import { readFileSync } from "node:fs";

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BobClient } from "../bob/client.js";
import type { DeliveryRecord, MemorySearchResultRow } from "../bob/types.js";
import { validateSpec, type Spec, type SpecError } from "./spec.js";
import type { EvaluationResult } from "./evaluate.js";
import {
  KeyedMutex,
  classifyTransition,
  illegalTransitionError,
  missingStateError,
  type HypothesisStatus,
} from "./lifecycle.js";
import {
  inFlightSessionIds,
  isHypothesisId,
  newestTrustedRow,
  sessionNameForHypothesis,
  type HypothesisStore,
  type SessionLookup,
} from "./store.js";

// ── The prompt contract with W12 ────────────────────────────────────────

/**
 * The one substitution token in `prompts/researcher-preamble.md`, alone on
 * its own line inside a ```json fence. W12 pins it and ships a test that it
 * occurs exactly once.
 */
export const SPEC_TOKEN = "{{LOCKED_SPEC_JSON}}";

/**
 * The preamble/method boundary. Everything above it is locked; everything
 * below it is the mutable method body a weekly critic may rewrite.
 *
 * ⚠️ **The split is LINE-ANCHORED** (`split("\n")` then `line.trim() ===`),
 * never `indexOf` or a `split` on the bare substring — R93. The preamble
 * contains this marker TWICE: once as prose inside backticks near the top
 * ("everything below the `<!-- WOLF:METHOD-BODY -->` line…") and once as the
 * real boundary line. A substring split cuts at the prose occurrence and
 * silently makes most of the locked preamble mutable, with nothing failing.
 */
export const METHOD_BODY_MARKER = "<!-- WOLF:METHOD-BODY -->";

export interface SplitPrompt {
  /** Everything above the marker line, marker excluded. */
  locked: string;
  /** Everything below the marker line, marker excluded. */
  methodBody: string;
}

/**
 * Splits a composed prompt (or W12's preamble template) at the marker line.
 * Refuses a text in which the marker does not appear as a whole line exactly
 * once — zero means the boundary is gone, more than one means it is
 * ambiguous, and both would silently relocate the locked/mutable boundary.
 */
export function splitAtMethodMarker(text: string): SplitPrompt {
  const lines = text.split("\n");
  const at: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === METHOD_BODY_MARKER) at.push(index);
  });
  if (at.length !== 1) {
    throw new WolfError(
      "misconfigured",
      `the researcher prompt must contain the line ${METHOD_BODY_MARKER} exactly once as a whole ` +
        `line; found ${at.length}`,
      { details: { marker: METHOD_BODY_MARKER, occurrences: at.length } },
    );
  }
  const index = at[0] ?? 0;
  return {
    locked: lines.slice(0, index).join("\n"),
    methodBody: lines.slice(index + 1).join("\n"),
  };
}

/**
 * `locked preamble + marker + mutable method body`, with the locked spec JSON
 * substituted into the preamble verbatim.
 *
 * The spec is embedded as TEXT, exactly as it was written by whoever proposed
 * it — not re-serialised — so a `derived` metric's `method` object appears
 * byte-for-byte inside the worker's `system_prompt`, which is what makes the
 * locked scoreboard something a reader can check rather than take on trust.
 */
export function composeResearcherPrompt(input: {
  preambleTemplate: string;
  specJson: string;
  methodBody: string;
}): string {
  const template = splitAtMethodMarker(input.preambleTemplate);
  if (!template.locked.includes(SPEC_TOKEN)) {
    throw new WolfError(
      "misconfigured",
      `the researcher preamble template must contain ${SPEC_TOKEN} above the ${METHOD_BODY_MARKER} line`,
      { details: { token: SPEC_TOKEN } },
    );
  }
  // `split`/`join` rather than `String.replace`, because `replace` interprets
  // `$&`, `$1` and friends in the REPLACEMENT — and the replacement here is
  // attacker-adjacent text written inside an interview container.
  const locked = template.locked.split(SPEC_TOKEN).join(input.specJson);
  // Exactly `splitAtMethodMarker`'s inverse: `above.join("\n") + "\n" + marker
  // + "\n" + below.join("\n")`. Composing and re-splitting is a round trip, which
  // is what lets an accepted amendment carry the critic's rewritten method body
  // across untouched.
  return `${locked}\n${METHOD_BODY_MARKER}\n${input.methodBody}`;
}

// ── The spec candidate: JSON text, verbatim ─────────────────────────────

/**
 * Pulls the spec JSON out of a memory's content **as text**, so it can be
 * carried verbatim into the locked memory and into the prompt.
 *
 * Handles the two shapes § "Memory kinds" produces: a ```json fence, or a
 * summary line followed by the bare JSON object. Fence first — the same
 * precedence `routes/hypotheses.ts`'s `extractJsonObject` uses, so the two
 * readers cannot disagree about which object a memory carries.
 */
export function extractSpecJsonText(content: string): string | undefined {
  const fence = /```json\s*([\s\S]*?)```/.exec(content);
  const candidates = [fence?.[1], content];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    const text = candidate.slice(start, end + 1);
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return text;
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

// ── Memory kinds this module reads and writes ───────────────────────────

const KIND_HYPOTHESIS_SPEC = "hypothesis-spec";
const KIND_SPEC_CANDIDATE = "hypothesis-spec-candidate";
const KIND_SPEC_AMENDMENT = "spec-amendment";
const KIND_EVALUATION = "evaluation";
const KIND_VERDICT = "verdict";

/** The per-hypothesis daily researcher's worker name (§ "Bob atoms"). */
export const RESEARCHER_WORKER_PREFIX = "researcher-";

export function researcherWorkerFor(id: string): string {
  return `${RESEARCHER_WORKER_PREFIX}${id}`;
}

/** How many rows of one kind a provisioning read pulls back. */
const ROW_LIMIT = 50;

/**
 * One page of deliveries per drain poll.
 *
 * The poll is deliberately NOT `?status=pending` filtered (R112): the same
 * page has to answer two questions — "is anything still queued for this
 * worker" (the drain's wait condition) and "which tick sessions are in
 * flight right now" (step 4's exclusion) — and the second needs `running`
 * rows that a `pending` filter would hide. Asking twice would be a second
 * request; one unfiltered page, split client-side, is one. The page is
 * therefore raised to Bob's own clamp ceiling, because it now has to
 * cover terminal rows as well (`clampLimit`, `go/agentdb/events.go`, caps at
 * 1000).
 */
const DELIVERY_PAGE = 1000;

/** How often the drain loop re-polls `GET /agent/deliveries`, in ms. */
export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 1000;

// ── Results ─────────────────────────────────────────────────────────────

export interface TeardownReport {
  /** Every schedule id deleted, in the order they were deleted. FIRST. */
  schedules_deleted: string[];
  /** False when `WOLF_TEARDOWN_DRAIN_SECONDS` elapsed with deliveries still pending. */
  drained: boolean;
  /** The delivery ids teardown gave up waiting for, and left behind. */
  pending_left_behind: string[];
  worker_deleted: boolean;
  /** The `researcher-<id>` tick sessions deleted. */
  tick_sessions_deleted: string[];
  /** Tick sessions left alone because a delivery for this worker was
   * `pending` or `running` on them — R112's in-flight exclusion. */
  tick_sessions_in_flight: string[];
  /** The `hyp-<id>` session's id, once deleted. */
  session_deleted: string | null;
  /** Non-fatal step failures, in order. Teardown is best-effort after step 1. */
  errors: { step: string; message: string }[];
}

export interface GoLiveResult {
  id: string;
  status: HypothesisStatus;
  worker: string;
  schedule_id: string;
  /** The trusted `kind=hypothesis-spec, status=locked` memory. */
  spec_memory_id: string;
  /** The trusted `kind=hypothesis, status=live` memory — written LAST. */
  state_memory_id: string | null;
}

export interface TerminalResult {
  id: string;
  status: HypothesisStatus;
  /** The trusted memory this route appended (the verdict / state row). */
  memory_id: string | null;
  teardown: TeardownReport;
}

export interface AmendResult {
  id: string;
  status: HypothesisStatus;
  decision: "accept" | "reject";
  amendment_id: string;
  /** The new trusted `kind=hypothesis-spec, status=locked` memory, on accept. */
  spec_memory_id: string | null;
  /** The trusted `kind=hypothesis` row appended by the `challenged → live` move. */
  state_memory_id: string | null;
}

// ── Dependencies ────────────────────────────────────────────────────────

export interface ProvisionerPrompts {
  /** `prompts/researcher-preamble.md`, verbatim. */
  preamble: string;
  /** `prompts/researcher-method.md`, verbatim — the initial mutable body. */
  methodBody: string;
}

export interface ProvisionerConfig {
  /** `WOLF_SCHEDULE_CRON` — 5-field, never a nickname. */
  scheduleCron: string;
  /** `WOLF_TEARDOWN_DRAIN_SECONDS` — whole seconds. */
  teardownDrainSeconds: number;
}

export interface CreateProvisionerOptions {
  client: BobClient;
  store: HypothesisStore;
  logger: Logger;
  config: ProvisionerConfig;
  /** Defaults to the two files under `prompts/`, read lazily and once. */
  prompts?: ProvisionerPrompts;
  /** Overridable so a test does not wait real seconds on the drain loop. */
  drainPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Provisioner {
  goLive(params: { id: string; email: string }): Promise<GoLiveResult>;
  verdict(params: {
    id: string;
    email: string;
    verdict: "confirmed" | "invalidated";
    rationale: string;
  }): Promise<TerminalResult>;
  retire(params: { id: string; email: string; rationale: string }): Promise<TerminalResult>;
  amend(params: {
    id: string;
    email: string;
    amendmentId: string;
    decision: "accept" | "reject";
    rationale: string;
  }): Promise<AmendResult>;
  /** Exposed for the routes' own tests; the four methods above call it. */
  teardown(params: { id: string; sessionId: string | null }): Promise<TeardownReport>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function readPromptFile(name: string): string {
  // api/src/hypothesis → api/src → api → repo root → prompts/
  return readFileSync(new URL(`../../../prompts/${name}`, import.meta.url), "utf8");
}

/** The 422 body shape: `{ errors: [{path, message}] }`, all of them at once. */
export function specRejection(errors: SpecError[], message: string): WolfError {
  return new WolfError("invalid", message, { status: 422, details: { errors } });
}

export function createProvisioner(options: CreateProvisionerOptions): Provisioner {
  const { client, store, logger, config } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const drainPollIntervalMs = options.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;

  /**
   * Serialises the WHOLE of go-live and the whole of each teardown per
   * hypothesis id. This is a different mutex from the store's — that one
   * guards the state append alone, and nests inside this one, always in the
   * same order, so the pair cannot deadlock. Without this, two go-live
   * clicks both pass their `draft` pre-flight and provision two schedules
   * for one hypothesis.
   */
  const mutex = new KeyedMutex();

  let prompts: ProvisionerPrompts | undefined = options.prompts;
  function promptParts(): ProvisionerPrompts {
    // Read lazily, so constructing the router (which every route test does)
    // touches no filesystem and cannot throw.
    prompts ??= {
      preamble: readPromptFile("researcher-preamble.md"),
      methodBody: readPromptFile("researcher-method.md"),
    };
    return prompts;
  }

  /**
   * The trust rule's third clause for a single id. Everything below reads
   * memories labelled `name=<id>` for an id already known to have a
   * `hyp-<id>` session (`store.readHypothesis` checks the session index), so
   * a one-element lookup is exactly right and costs no second index read.
   */
  function lookupFor(id: string): SessionLookup {
    return new Set([id]);
  }

  async function listKind(
    id: string,
    kind: string,
    opts: { includeRetracted?: boolean } = {},
  ): Promise<MemorySearchResultRow[]> {
    return client.listMemories({
      selector: `kind=${kind},name=${id}`,
      limit: ROW_LIMIT,
      ...(opts.includeRetracted === true ? { includeRetracted: true } : {}),
    });
  }

  /**
   * The newest row that is trusted AND that Wolf itself has not withdrawn.
   * A retraction whose own provenance is non-empty is IGNORED: an untrusted
   * actor cannot withdraw server-written state (§ "Retraction").
   */
  function newestTrusted(
    rows: readonly MemorySearchResultRow[],
    sessions: SessionLookup,
  ): MemorySearchResultRow | undefined {
    // ONE definition, in store.ts, shared with W10's poller (which needs the
    // same "newest trusted, not withdrawn by Wolf" rule to read a locked
    // spec). This wrapper is kept so the call sites below read unchanged.
    return newestTrustedRow(rows, sessions);
  }

  /**
   * The cheap, pre-write legality check. `store.transition` re-reads the
   * state inside its own lock and is the real gate — but a verdict memory is
   * appended BEFORE that transition (the plan's order), and memories cannot
   * be taken back, so an illegal verdict must be refused before anything is
   * written rather than after.
   */
  function assertTransitionAllowed(
    id: string,
    from: HypothesisStatus | null,
    to: HypothesisStatus,
  ): void {
    if (from === null) throw missingStateError(id, to);
    if (classifyTransition(from, to) === "illegal") throw illegalTransitionError(id, from, to);
  }

  function requireId(id: string): void {
    if (!isHypothesisId(id)) {
      throw new WolfError("invalid", `not a hypothesis id: ${JSON.stringify(id)}`, {
        details: { id },
      });
    }
  }

  // ── Spec candidates and amendments ────────────────────────────────────

  interface CandidateSpec {
    /** The proposing memory's id. */
    memoryId: string;
    /** The JSON exactly as it was written — carried verbatim into the lock. */
    json: string;
    /** The parsed, normalised spec. */
    spec: Spec;
  }

  /**
   * Reads and validates one proposal.
   *
   * **Provenance is deliberately not checked.** A spec candidate is written
   * from inside the interview container, so it is untrusted by construction
   * and W3's validator is the whole gate — the trust rule protects
   * *authoritative state*, and this is a proposal until a human clicks.
   */
  async function readProposal(
    row: MemorySearchResultRow | undefined,
    what: string,
  ): Promise<CandidateSpec> {
    if (row === undefined) {
      throw specRejection([{ path: "", message: "no spec proposed yet" }], what);
    }
    const full = await client.getMemoryById(row.id);
    const json = extractSpecJsonText(full.content);
    if (json === undefined) {
      throw specRejection(
        [{ path: "$", message: "the proposed spec does not contain a JSON object" }],
        what,
      );
    }
    const result = validateSpec(JSON.parse(json));
    if (!result.valid) throw specRejection(result.errors, what);
    return { memoryId: row.id, json, spec: result.spec };
  }

  /**
   * The locked spec memory's content. The spec JSON is carried **verbatim**;
   * at go-live it is the entire content, so `JSON.parse(content)` works and
   * the § "Memory kinds" table ("Content: the spec JSON") is literally true.
   * An amendment has three more things to record, so it wraps the same
   * verbatim JSON in a ```json fence — which is the shape `extractJsonObject`
   * looks for first, so the detail read still returns the spec and not the
   * metadata around it.
   */
  function amendedSpecContent(input: {
    id: string;
    json: string;
    amendmentId: string;
    email: string;
    rationale: string;
  }): string {
    return [
      `Amended spec for hypothesis ${input.id}, accepted from ${input.amendmentId}`,
      "```json",
      input.json,
      "```",
      `Amendment: ${input.amendmentId}`,
      `Decided by: ${input.email}`,
      `Rationale: ${input.rationale}`,
    ].join("\n");
  }

  // ── The evaluation snapshot ───────────────────────────────────────────

  /**
   * The newest trusted `kind=evaluation` snapshot, in full, or null.
   *
   * This is why a verdict outlives O3's 30-version dataset reaper: by the
   * time a hypothesis invalidated on day 90 is read on day 121, the data the
   * verdict was made on is gone. The memory is the permanent record; the
   * dataset is working storage.
   */
  async function evaluationSnapshot(id: string): Promise<EvaluationResult | null> {
    let rows: MemorySearchResultRow[];
    try {
      rows = await listKind(id, KIND_EVALUATION, { includeRetracted: true });
    } catch (err) {
      logger.warn({ id, err }, "could not read the evaluation snapshot");
      return null;
    }
    const row = newestTrusted(rows, lookupFor(id));
    if (row === undefined) return null;
    try {
      const full = await client.getMemoryById(row.id);
      const start = full.content.indexOf("{");
      const end = full.content.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      const parsed: unknown = JSON.parse(full.content.slice(start, end + 1));
      return parsed !== null && typeof parsed === "object" ? (parsed as EvaluationResult) : null;
    } catch (err) {
      logger.warn({ id, memory: row.id, err }, "the evaluation snapshot did not parse");
      return null;
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────

  /**
   * Waits for this worker's already-queued deliveries, bounded, and returns
   * the LAST page it read so step 4 can compute the in-flight exclusion from
   * it without paying a second request (R112).
   *
   * The wait condition is `pending` only, and that is unchanged: a tick
   * session already RUNNING is allowed to finish (anything it writes carries
   * a session id in its provenance and is untrusted by construction, so it
   * cannot change state), and waiting for one would stall every teardown
   * behind a 30-minute container. What changed is only WHERE the status
   * filter is applied — client-side, on a page that also carries the
   * `running` rows step 4 needs.
   */
  async function drain(
    worker: string,
    report: TeardownReport,
  ): Promise<readonly DeliveryRecord[]> {
    const deadline = now() + config.teardownDrainSeconds * 1000;
    let lastPage: readonly DeliveryRecord[] = [];
    for (;;) {
      // `DeliveryQuery` has no `worker` field, so the filter is client-side
      // on the row's own `worker` — which the row does carry.
      lastPage = await client.listDeliveries({ limit: DELIVERY_PAGE });
      const pending = lastPage.filter(
        (delivery) => delivery.worker === worker && delivery.status === "pending",
      );
      if (pending.length === 0) {
        report.drained = true;
        return lastPage;
      }
      if (now() >= deadline) {
        report.drained = false;
        report.pending_left_behind = pending.map((delivery) => delivery.id);
        logger.warn(
          { worker, deliveries: report.pending_left_behind, seconds: config.teardownDrainSeconds },
          "teardown: giving up on the delivery drain and proceeding anyway",
        );
        return lastPage;
      }
      await sleep(drainPollIntervalMs);
    }
  }

  function noteFailure(report: TeardownReport, step: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push({ step, message });
    logger.error({ step, err }, "teardown step failed");
  }

  /**
   * The five steps, in order. Called by every route that reaches a terminal
   * state — and by nothing else.
   *
   * Best-effort after step 1: a hypothesis whose state has already moved to a
   * terminal row must not be left half torn down because one DELETE 500ed, so
   * each later failure is recorded in the report rather than thrown. Step 1
   * is the exception: if the SCHEDULE cannot be deleted, deleting the worker
   * would leave the scheduler minting a delivery a day against a worker that
   * no longer exists, which is the exact state this ordering exists to avoid.
   */
  async function teardown(params: { id: string; sessionId: string | null }): Promise<TeardownReport> {
    const { id } = params;
    const worker = researcherWorkerFor(id);
    const rationale = `wolf: hypothesis ${id} reached a terminal state (design/2026-08-20-agent-wolf.md, W9)`;
    const report: TeardownReport = {
      schedules_deleted: [],
      drained: true,
      pending_left_behind: [],
      worker_deleted: false,
      tick_sessions_deleted: [],
      tick_sessions_in_flight: [],
      session_deleted: null,
      errors: [],
    };

    // 1. The schedule, FIRST. Disabling or deleting the worker first does not
    //    stop it: the scheduler checks only that the worker exists.
    try {
      const schedules = await client.listSchedules();
      for (const schedule of schedules.filter((s) => s.worker === worker)) {
        await client.deleteSchedule(schedule.id, { rationale });
        report.schedules_deleted.push(schedule.id);
      }
    } catch (err) {
      // ABORT, uniquely for this step. Every later step is best-effort, but a
      // schedule that survives while its worker is deleted mints one failed
      // delivery a day until the five-failure streak retires it — which is
      // precisely the state this ordering exists to avoid.
      noteFailure(report, "delete_schedule", err);
      return report;
    }

    // 2. Drain the deliveries the schedule already queued. Bounded.
    let lastDeliveryPage: readonly DeliveryRecord[] = [];
    try {
      lastDeliveryPage = await drain(worker, report);
    } catch (err) {
      noteFailure(report, "drain_deliveries", err);
    }

    // 3. The worker.
    try {
      await client.deleteWorker(worker, { rationale });
      report.worker_deleted = true;
    } catch (err) {
      noteFailure(report, "delete_worker", err);
    }

    // 4. The tick sessions. Nothing else ever deletes them — EXCEPT one that
    //    is in flight right now (R112). W9 shipped this step literally
    //    ("delete every row it returns") because it was never given the
    //    exclusion, which contradicted the rule three lines below it: "a tick
    //    session still in flight is allowed to finish". A /verdict or /retire
    //    issued while a tick is running would otherwise delete that tick's
    //    session row out from under it, mid-`dataset_put`. The predicate is
    //    ONE helper (`inFlightSessionIds`, store.ts), shared with W10's
    //    sweep, and it reads the page the drain above already fetched — so
    //    the recorded five-step ORDER is unchanged, which is what W9's
    //    ordered teardown test gates.
    try {
      const inFlight = inFlightSessionIds(lastDeliveryPage, worker);
      const ticks = await client.listSessions({ worker });
      for (const tick of ticks) {
        if (inFlight.has(tick.id)) {
          report.tick_sessions_in_flight.push(tick.id);
          continue;
        }
        await client.deleteSession(tick.id);
        report.tick_sessions_deleted.push(tick.id);
      }
      if (report.tick_sessions_in_flight.length > 0) {
        logger.info(
          { id, worker, sessions: report.tick_sessions_in_flight },
          "teardown: left an in-flight tick session alone; the archive loop reclaims its port",
        );
      }
    } catch (err) {
      noteFailure(report, "delete_tick_sessions", err);
    }

    // 5. The `hyp-<id>` chat session, LAST.
    try {
      let sessionId = params.sessionId;
      if (sessionId === null || sessionId === "") {
        sessionId = (await client.getSessionByName(sessionNameForHypothesis(id))).id;
      }
      await client.deleteSession(sessionId);
      report.session_deleted = sessionId;
    } catch (err) {
      noteFailure(report, "delete_session", err);
    }

    logger.info({ id, report }, "teardown complete");
    return report;
  }

  // ── Go-live ───────────────────────────────────────────────────────────

  async function goLive(params: { id: string; email: string }): Promise<GoLiveResult> {
    const { id, email } = params;
    requireId(id);
    return mutex.run(id, async () => {
      const record = await store.readHypothesis(id);
      if (record.status !== "draft") {
        // The final append goes through the lifecycle machine anyway, which
        // re-reads inside its own lock; this is the cheap refusal that stops
        // a live hypothesis being re-provisioned before that check is reached.
        throw new WolfError(
          "conflict",
          `hypothesis ${id}: cannot go live from ${record.status ?? "no state"}`,
          { details: { id, from: record.status, to: "live" } },
        );
      }

      const candidates = await listKind(id, KIND_SPEC_CANDIDATE);
      const candidate = await readProposal(candidates[0], "the proposed spec is not valid");

      const worker = researcherWorkerFor(id);
      let scheduleId: string | null = null;
      let workerCreated = false;

      // ── Step 1: the locked spec. NEVER withdrawn on rollback. ──────────
      const specMemory = await client.appendMemory({
        labels: { kind: KIND_HYPOTHESIS_SPEC, name: id, status: "locked" },
        content: candidate.json,
        embed: false,
      });
      const specMemoryId = specMemory.id;

      try {
        // ── Step 2: the researcher worker. ──────────────────────────────
        const { preamble, methodBody } = promptParts();
        await client.putWorker(worker, {
          description: `Agent Wolf daily researcher for hypothesis ${id}`,
          systemPrompt: composeResearcherPrompt({
            preambleTemplate: preamble,
            specJson: candidate.json,
            methodBody,
          }),
          enabled: true,
          rationale: `wolf: go-live for hypothesis ${id} — locked preamble composed from spec memory ${specMemoryId}`,
        });
        workerCreated = true;

        // ── Step 3: the daily schedule, in WORKER mode. ─────────────────
        const schedule = await client.createSchedule({
          worker,
          cron: config.scheduleCron,
          input:
            `Daily research tick for hypothesis ${id}. Follow your method, fetch or recompute ` +
            `every metric in the locked spec, and write each one to its dataset.`,
          enabled: true,
          rationale: `wolf: go-live for hypothesis ${id} — daily researcher schedule`,
        });
        scheduleId = schedule.id;

        // ── Step 4: the trusted `status=live` row. LAST, because memories
        //    are append-only and this one cannot be taken back. ──────────
        const outcome = await store.transition({ id, to: "live" });
        logger.info(
          { id, worker, schedule: scheduleId, spec: specMemoryId, by: email },
          "hypothesis is live",
        );
        return {
          id,
          status: "live" as HypothesisStatus,
          worker,
          schedule_id: scheduleId,
          spec_memory_id: specMemoryId,
          state_memory_id: outcome.memoryId,
        };
      } catch (err) {
        // Roll back everything steps 2 and 3 created, in TEARDOWN order —
        // schedule first — and leave step 1's memory exactly where it is. An
        // orphaned locked spec with no `live` row is inert; a retraction is
        // another append, and there is no delete to reach for.
        await rollback(id, { scheduleId, workerCreated });
        throw err;
      }
    });
  }

  async function rollback(
    id: string,
    created: { scheduleId: string | null; workerCreated: boolean },
  ): Promise<void> {
    const worker = researcherWorkerFor(id);
    const rationale = `wolf: rolling back a failed go-live for hypothesis ${id}`;
    if (created.scheduleId !== null) {
      try {
        await client.deleteSchedule(created.scheduleId, { rationale });
      } catch (err) {
        logger.error({ id, schedule: created.scheduleId, err }, "go-live rollback: schedule");
      }
    }
    if (created.workerCreated) {
      try {
        await client.deleteWorker(worker, { rationale });
      } catch (err) {
        logger.error({ id, worker, err }, "go-live rollback: worker");
      }
    }
    logger.warn({ id, ...created }, "go-live rolled back; the locked spec memory is left in place");
  }

  // ── The three human, terminal routes ──────────────────────────────────

  async function verdict(params: {
    id: string;
    email: string;
    verdict: "confirmed" | "invalidated";
    rationale: string;
  }): Promise<TerminalResult> {
    const { id, email } = params;
    requireId(id);
    return mutex.run(id, async () => {
      const record = await store.readHypothesis(id);
      assertTransitionAllowed(id, record.status, params.verdict);
      const snapshot = await evaluationSnapshot(id);

      // The verdict memory carries the rationale, the deciding user's FULL
      // address (a label may not: no `@` in the K8s charset) and the whole
      // evaluation snapshot — the reason the record outlives the reaper.
      const verdictMemory = await client.appendMemory({
        labels: { kind: KIND_VERDICT, name: id, status: params.verdict },
        content: buildVerdictContent({
          id,
          verdict: params.verdict,
          email,
          rationale: params.rationale,
          evaluation: snapshot,
        }),
        embed: false,
      });

      await store.transition({
        id,
        to: params.verdict,
        evaluation: snapshot,
        rationale: params.rationale,
      });

      const report = await teardown({ id, sessionId: record.sessionId });
      logger.info({ id, verdict: params.verdict, by: email }, "verdict recorded");
      return {
        id,
        status: params.verdict as HypothesisStatus,
        memory_id: verdictMemory.id,
        teardown: report,
      };
    });
  }

  async function retire(params: {
    id: string;
    email: string;
    rationale: string;
  }): Promise<TerminalResult> {
    const { id, email } = params;
    requireId(id);
    return mutex.run(id, async () => {
      const record = await store.readHypothesis(id);
      assertTransitionAllowed(id, record.status, "archived");
      const snapshot = await evaluationSnapshot(id);
      const outcome = await store.transition({
        id,
        to: "archived",
        evaluation: snapshot,
        rationale: params.rationale,
      });
      const report = await teardown({ id, sessionId: record.sessionId });
      logger.info({ id, by: email }, "hypothesis archived");
      return { id, status: "archived", memory_id: outcome.memoryId, teardown: report };
    });
  }

  // ── Amendment ─────────────────────────────────────────────────────────

  async function amend(params: {
    id: string;
    email: string;
    amendmentId: string;
    decision: "accept" | "reject";
    rationale: string;
  }): Promise<AmendResult> {
    const { id, email, amendmentId } = params;
    requireId(id);
    return mutex.run(id, async () => {
      const record = await store.readHypothesis(id);
      const rows = await listKind(id, KIND_SPEC_AMENDMENT);
      const row = rows.find((candidate) => candidate.id === amendmentId);
      if (row === undefined) {
        throw new WolfError(
          "not_found",
          `no spec-amendment ${JSON.stringify(amendmentId)} for hypothesis ${id}`,
          { details: { id, amendment_id: amendmentId } },
        );
      }

      if (params.decision === "reject") {
        // Nothing is written: there is no trusted kind for "a proposal was
        // declined", the proposal itself is already on the record with its
        // own provenance, and a state row would be a self-transition no-op.
        logger.info({ id, amendment: amendmentId, by: email }, "spec amendment rejected");
        return {
          id,
          status: (record.status ?? "challenged") as HypothesisStatus,
          decision: "reject" as const,
          amendment_id: amendmentId,
          spec_memory_id: null,
          state_memory_id: null,
        };
      }

      // An amendment presupposes a scoreboard that is already locked and
      // running. `draft → live` is a legal edge, so without this check an
      // accepted amendment on a draft would move it live with no worker and
      // no schedule behind it — go-live is the only path that provisions.
      if (record.status !== "live" && record.status !== "challenged") {
        throw new WolfError(
          "conflict",
          `hypothesis ${id}: a spec amendment can only be decided while live or challenged, not ${record.status ?? "no state"}`,
          { details: { id, status: record.status } },
        );
      }
      assertTransitionAllowed(id, record.status, "live");

      // Nothing is written until the amended spec validates.
      const amended = await readProposal(row, "the amended spec is not valid");

      const specMemory = await client.appendMemory({
        labels: { kind: KIND_HYPOTHESIS_SPEC, name: id, status: "locked" },
        content: amendedSpecContent({
          id,
          json: amended.json,
          amendmentId,
          email,
          rationale: params.rationale,
        }),
        embed: false,
      });

      // The researcher's LOCKED preamble carries the spec verbatim, so an
      // amended spec that did not reach the worker would leave the daily job
      // working from the superseded scoreboard. The mutable method body —
      // which the weekly critic may have rewritten since go-live — is carried
      // across untouched, split at the marker LINE.
      await recomposeWorkerPrompt(id, amended.json, amendmentId);

      // `challenged → live` is legal (owner decision B3); a self-transition
      // from `live` is a no-op and appends nothing.
      const outcome = await store.transition({ id, to: "live", rationale: params.rationale });
      logger.info({ id, amendment: amendmentId, by: email }, "spec amendment accepted");
      return {
        id,
        status: "live" as HypothesisStatus,
        decision: "accept" as const,
        amendment_id: amendmentId,
        spec_memory_id: specMemory.id,
        state_memory_id: outcome.memoryId,
      };
    });
  }

  async function recomposeWorkerPrompt(
    id: string,
    specJson: string,
    amendmentId: string,
  ): Promise<void> {
    const worker = researcherWorkerFor(id);
    let methodBody = promptParts().methodBody;
    try {
      const existing = await client.getWorker(worker);
      methodBody = splitAtMethodMarker(existing.systemPrompt).methodBody;
    } catch (err) {
      // No worker, or a prompt whose marker line has gone: fall back to the
      // shipped method body rather than refusing the amendment.
      logger.warn({ id, worker, err }, "could not carry the method body across; using the default");
    }
    await client.putWorker(worker, {
      systemPrompt: composeResearcherPrompt({
        preambleTemplate: promptParts().preamble,
        specJson,
        methodBody,
      }),
      enabled: true,
      rationale: `wolf: amended spec accepted for hypothesis ${id} (amendment ${amendmentId}) — locked preamble recomposed`,
    });
  }

  return { goLive, verdict, retire, amend, teardown };
}

/**
 * The verdict memory's content. Line 1 is a human summary; the deciding
 * user's full address and the rationale follow; the whole `EvaluationResult`
 * is fenced JSON at the end, which is what makes the record survive the
 * dataset reaper.
 */
export function buildVerdictContent(input: {
  id: string;
  verdict: "confirmed" | "invalidated";
  email: string;
  rationale: string;
  evaluation: EvaluationResult | null;
}): string {
  const parts = [
    `Hypothesis ${input.id} ${input.verdict} by ${input.email}`,
    input.rationale,
    `Decided by: ${input.email}`,
  ];
  if (input.evaluation !== null) {
    parts.push(["```json", JSON.stringify(input.evaluation, null, 2), "```"].join("\n"));
  }
  return parts.join("\n\n");
}
