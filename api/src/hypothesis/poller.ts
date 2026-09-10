/**
 * The evaluation poller — the mechanism that actually moves a hypothesis to
 * `challenged`, and the writer of every number the board shows.
 *
 * design/2026-08-20-agent-wolf.md, ticket W10.
 *
 * ## Why a poller at all
 *
 * Bob cannot call Wolf. There is no webhook, and a subscription dispatches
 * a WORKER, not an HTTP request — so nothing on the Bob side can tell Wolf
 * that today's tick finished writing its datasets. Wolf therefore polls, and
 * this file is the only thing that does.
 *
 * ## The four things that are correctness rather than style
 *
 * 1. **The interval is started in `index.ts`, after `app.listen`, and never as
 *    an import side effect.** `createPoller` schedules nothing; only `start()`
 *    does. Importing `createApp` must not start a live poller, or every route
 *    test in the repo acquires one — asserted in `poller.test.ts`.
 *
 * 2. **Dataset reads are version-gated.** The metadata route is asked first
 *    (it returns the BARE object — the list route is the one that wraps in
 *    `{"datasets":[…]}`), the bytes are fetched only when `version` moved, and
 *    parsed points are cached by `(name, version)`. A metadata response with
 *    no `version` is a hard `invalid` error and is NEVER treated as unchanged:
 *    `undefined !== undefined` is false, and that one mistake re-downloads
 *    every CSV 288 times a day while the mocked test still passes.
 *
 * 3. **The attention counter is DERIVED from memory, never held in process.**
 *    A restart must not reset it, so it is recomputed from the last three
 *    `kind=evaluation` rows on every tick.
 *
 * 4. **Tick sessions are swept without consulting session status**, because
 *    Bob has no "completed" one: a finished tick session reads
 *    `running`/`active` for up to the 30-minute idle timeout and `archived`
 *    only afterwards. The delivery log is what says whether a container is
 *    working, through the ONE in-flight predicate this file shares with W9's
 *    teardown (`inFlightSessionIds`, `store.ts`, R112).
 *
 * ## What it deliberately does NOT do
 *
 * It does not read `GET /agent/attention-requests`. Attention raised from
 * inside a container by `request_human_attention` is surfaced by W8's detail
 * route; over HTTP those rows are read-only, and the `challenged` state on the
 * board is Wolf's notification surface. A poller that read them and exported
 * them would be dead code a criterion vacuously satisfies.
 */

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BobClient } from "../bob/client.js";
import { toMs, type UnixMs } from "../bob/types.js";
import { MS_PER_DAY, evaluate, type EvaluationResult, type Point } from "./evaluate.js";
import { validateSpec, type Spec } from "./spec.js";
import { extractSpecJsonText, researcherWorkerFor } from "./provision.js";
import { parseCanonicalCsvBytes } from "./points.js";
import {
  foreignDatasetLog,
  isOwnDataset,
  metricDatasetName,
} from "./datasettrust.js";
import {
  EVALUATION_HISTORY_LIMIT,
  evaluationLineWithoutTimestamp,
  evaluationSummaryLine,
  inFlightSessionIds,
  newestTrustedRow,
  parseTitleFromSnippet,
  type AttentionEntry,
  type EvaluationSnapshot,
  type HypothesisRecord,
  type HypothesisStore,
  type SessionLookup,
} from "./store.js";

// ── The pinned numbers ──────────────────────────────────────────────────

/** How many tick sessions per hypothesis survive the sweep, newest first. */
export const TICK_SESSIONS_KEPT = 7;

/**
 * The re-write clock: an unchanged evaluation is appended again once more
 * than this has passed, so a quiet hypothesis produces one row a day rather
 * than 288 — and rather than none at all, which would leave the board unable
 * to tell "nothing changed" from "the poller died a week ago".
 */
export const EVALUATION_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/** Three consecutive `indeterminate`s for one condition raise attention. */
export const ATTENTION_RUN_LENGTH = 3;

/** One page of memory rows per per-hypothesis read. */
const ROW_LIMIT = 50;

/** One page of sessions, and one page of deliveries, per sweep. */
const SESSION_PAGE = 200;
const DELIVERY_PAGE = 1000;

/** The two reasons a hypothesis reaches `challenged`. A closed vocabulary:
 * the UI says "time's up, verdict?" for one and "your thesis was challenged"
 * for the other, and it must never have to parse prose to tell them apart. */
export type ChallengeReason = "condition_tripped" | "horizon_reached";

// ── Reports ─────────────────────────────────────────────────────────────

/** Why one hypothesis produced no evaluation this tick. A closed set. */
export type SkipReason =
  | "no_locked_spec"
  | "no_live_row"
  | "no_datasets_yet"
  /** Every metric this hypothesis declares was written by a FOREIGN worker.
   * Not "no data" — data Wolf refuses to believe. See `datasettrust.ts`. */
  | "forged_datasets";

export interface HypothesisTickReport {
  id: string;
  /** Set when the tick produced an `EvaluationResult`. */
  evaluated: boolean;
  /** The appended `kind=evaluation` memory id, or null when suppressed. */
  evaluationMemoryId: string | null;
  /** Non-null only when a state row was actually written. */
  transitionedTo: "challenged" | null;
  reason: ChallengeReason | null;
  attention: AttentionEntry[];
  /** Tick session ids deleted by the sweep. */
  swept: string[];
  /** Tick sessions the in-flight exclusion kept (R112). */
  inFlight: string[];
  skipped: SkipReason | null;
  error: { kind: string; message: string } | null;
}

export interface TickReport {
  startedAtMs: UnixMs;
  /** How many `live` hypotheses the session index produced. */
  live: number;
  hypotheses: HypothesisTickReport[];
  /** Set when the tick could not even read the board. */
  error: { kind: string; message: string } | null;
}

// ── Dependencies ────────────────────────────────────────────────────────

export interface PollerConfig {
  /** `WOLF_POLL_INTERVAL_SECONDS`, whole seconds. */
  pollIntervalSeconds: number;
}

export interface CreatePollerOptions {
  client: BobClient;
  store: HypothesisStore;
  logger: Logger;
  config: PollerConfig;
  now?: () => number;
}

export interface Poller {
  /** One sweep. Never throws — every failure is recorded in the report. */
  tick(): Promise<TickReport>;
  /** Schedules the interval. Idempotent. NOTHING before this call schedules a timer. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

// ── The poller ──────────────────────────────────────────────────────────

function classifyError(err: unknown): { kind: string; message: string } {
  if (err instanceof WolfError) return { kind: err.kind, message: err.message };
  // Never `unavailable`: that is the one RETRYABLE kind, and classifying our
  // own bug as retryable makes this poller hammer a crashing endpoint every
  // interval forever instead of surfacing it (R39).
  return { kind: "internal", message: err instanceof Error ? err.message : String(err) };
}

function isKind(err: unknown, kind: string): boolean {
  return err instanceof WolfError && err.kind === kind;
}

export function createPoller(options: CreatePollerOptions): Poller {
  const { client, store, logger, config } = options;
  const now = options.now ?? ((): number => Date.now());

  /**
   * Parsed points, keyed `<dataset name>@<version>`.
   *
   * This is the other half of the version gate: knowing the version has not
   * moved is only useful if last tick's parse is still in hand. Only ONE
   * version per name is kept — an older one can never be asked for again,
   * since the poller always reads the current version — so the cache is
   * bounded by the number of datasets, not by the number of ticks.
   */
  const points = new Map<string, Point[]>();

  /**
   * Every cache key this tick touched, so the rest can be dropped at the end
   * of it. Without this the cache keeps one entry per dataset the process has
   * EVER read, including those of hypotheses long since retired — a slow leak
   * in a service whose whole job is to run for months.
   */
  let touched = new Set<string>();

  let timer: ReturnType<typeof setInterval> | null = null;

  function lookupFor(id: string): SessionLookup {
    // Every read below is for an id the session index already produced, so a
    // one-element set is exactly the trust rule's third clause and costs no
    // second index read.
    return new Set([id]);
  }

  /** The locked spec, or null with a log line saying why. */
  async function readLockedSpec(id: string): Promise<Spec | null> {
    const rows = await client.listMemories({
      selector: `kind=hypothesis-spec,name=${id}`,
      limit: ROW_LIMIT,
      includeRetracted: true,
    });
    const row = newestTrustedRow(rows, lookupFor(id));
    if (row === undefined) {
      logger.warn({ id }, "poller: no trusted locked spec — skipping this hypothesis");
      return null;
    }
    const full = await client.getMemoryById(row.id);
    const json = extractSpecJsonText(full.content);
    if (json === undefined) {
      logger.error({ id, memory: row.id }, "poller: the locked spec memory carries no JSON object");
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      logger.error({ id, memory: row.id, err }, "poller: the locked spec is not valid JSON");
      return null;
    }
    const result = validateSpec(parsed);
    if (!result.valid) {
      // A locked spec that no longer validates is a real defect (it validated
      // at go-live), so it is logged at error — but it is not this poller's
      // job to fix, and it must not stop every other hypothesis.
      logger.error({ id, memory: row.id, errors: result.errors }, "poller: the locked spec no longer validates");
      return null;
    }
    return result.spec;
  }

  /**
   * Go-live, in unix ms — the OLDEST trusted `status=live` row.
   *
   * Oldest, not newest, because `challenged -> live` is legal on an accepted
   * amendment (owner decision B3): reading the newest would restart the
   * horizon clock every time a human accepts an amendment, so a hypothesis
   * could be amended past its own deadline forever.
   */
  async function readLiveAtMs(id: string): Promise<UnixMs | null> {
    const rows = await client.listMemories({
      selector: `kind=hypothesis,name=${id}`,
      limit: ROW_LIMIT,
      includeRetracted: true,
    });
    const sessions = lookupFor(id);
    let oldest: UnixMs | null = null;
    for (const row of rows) {
      if (row.labels["status"] !== "live") continue;
      if (newestTrustedRow([row], sessions) === undefined) continue;
      // Bob returns newest first, so the LAST match is the oldest row.
      oldest = row.createdAtMs;
    }
    return oldest;
  }

  interface SeriesRead {
    series: Record<string, Point[]>;
    /** Metrics whose dataset has never been written (404 / 410). */
    missing: string[];
    /** Metric slugs whose dataset was written by a worker other than this
     * hypothesis's own researcher. NOT merged into `missing`: "never written"
     * and "written by someone else" are different facts and an operator must
     * be able to tell them apart. */
    foreign: string[];
    downloads: number;
  }

  /**
   * One ascending `Point[]` per metric slug, version-gated.
   *
   * The dataset name is `<hypothesis-id>-<metric-slug>` — the same name
   * `prompts/researcher-preamble.md` tells the researcher to `dataset_put`.
   */
  async function readSeries(id: string, spec: Spec): Promise<SeriesRead> {
    const out: SeriesRead = { series: {}, missing: [], foreign: [], downloads: 0 };
    for (const metric of spec.metrics) {
      const name = metricDatasetName(id, metric.slug);
      let version: number;
      try {
        // The SINGLE-NAME route, whose body is the BARE metadata object.
        // `client.getDataset` refuses a body with no numeric `version` with a
        // typed `invalid` error — which is why nothing here has to compare
        // `undefined !== undefined`, the comparison that would silently treat
        // a broken response as "unchanged" and re-download nothing forever.
        const meta = await client.getDataset(name);
        // 🔴 THE DATASET HALF OF THE TRUST MODEL. Bob lets any session in
        // the project write any dataset name, so the bytes behind this name
        // are not evidence about `id` until their WRITER is checked. Refusing
        // here is what stops a peer container's forged series from driving a
        // real `challenged` transition — see `datasettrust.ts`.
        if (!isOwnDataset(meta, id)) {
          logger.warn(
            foreignDatasetLog(meta, id, name),
            "poller: dataset was written by a foreign worker — REFUSING to evaluate on it",
          );
          out.foreign.push(metric.slug);
          out.series[metric.slug] = [];
          continue;
        }
        version = meta.version;
      } catch (err) {
        if (isKind(err, "not_found")) {
          // "Never written yet" — the state of every dataset on day 0. A log
          // line, not an error, and emphatically not an outage: `not_found`
          // and `unavailable` must stay distinguishable or a provider outage
          // looks like a missing metric.
          logger.info({ id, dataset: name }, "poller: dataset not written yet");
          out.missing.push(metric.slug);
          out.series[metric.slug] = [];
          continue;
        }
        throw err;
      }
      const key = `${name}@${version}`;
      touched.add(key);
      const cached = points.get(key);
      if (cached !== undefined) {
        out.series[metric.slug] = cached;
        continue;
      }
      // Pinned to the version the metadata named: without it a `dataset_put`
      // landing between these two requests would hand back bytes whose
      // version is not the one just cached.
      const download = await client.downloadDataset(name, { version });
      out.downloads += 1;
      const parsed = parseCanonicalCsvBytes(download.body, name);
      for (const existing of points.keys()) {
        if (existing.startsWith(`${name}@`)) points.delete(existing);
      }
      points.set(key, parsed);
      out.series[metric.slug] = parsed;
    }
    return out;
  }

  /**
   * The attention list, DERIVED from the last three `kind=evaluation`
   * memories rather than held in a field.
   *
   * A field would reset on every restart and would have to be written even
   * when nothing else changed. Deriving it costs up to three full-content
   * reads — and only when the current evaluation has an `indeterminate`
   * condition at all, since without one no run can be extended.
   */
  async function deriveAttention(
    current: EvaluationResult,
    previousRows: readonly { id: string }[],
  ): Promise<AttentionEntry[]> {
    const indeterminate = current.conditions.filter((c) => c.state === "indeterminate");
    if (indeterminate.length === 0) return [];

    const history: (EvaluationSnapshot | null)[] = [];
    for (const row of previousRows.slice(0, ATTENTION_RUN_LENGTH)) {
      try {
        history.push(await store.readEvaluationSnapshot(row.id));
      } catch {
        // A body we cannot read breaks the run rather than extending it: an
        // unreadable row is not evidence that the condition was indeterminate.
        history.push(null);
      }
    }

    const out: AttentionEntry[] = [];
    for (const condition of indeterminate) {
      let run = 1;
      let sinceMs = current.evaluated_at_ms;
      for (const snapshot of history) {
        const prior = snapshot?.conditions.find((c) => c.id === condition.id);
        if (prior === undefined || prior.state !== "indeterminate") break;
        run += 1;
        // Walking newest -> oldest, so the last assignment is the run's start.
        sinceMs = snapshot?.evaluated_at_ms ?? sinceMs;
      }
      if (run >= ATTENTION_RUN_LENGTH) {
        out.push({ condition_id: condition.id, reason: condition.reason, since_ms: toMs(sinceMs) });
      }
    }
    return out;
  }

  /** The sweep. Returns the ids deleted and the ids the exclusion kept. */
  async function sweepTickSessions(id: string): Promise<{ swept: string[]; inFlight: string[] }> {
    const worker = researcherWorkerFor(id);
    const sessions = await client.listSessions({ worker, limit: SESSION_PAGE });
    const ordered = [...sessions].sort((a, b) => b.createdAtSec - a.createdAtSec);
    const candidates = ordered.slice(TICK_SESSIONS_KEPT);
    if (candidates.length === 0) return { swept: [], inFlight: [] };

    // Read the delivery log only when there is something to sweep — on a
    // young hypothesis that is every tick for the first week.
    const excluded = inFlightSessionIds(
      await client.listDeliveries({ limit: DELIVERY_PAGE }),
      worker,
    );
    const swept: string[] = [];
    const inFlight: string[] = [];
    for (const session of candidates) {
      if (excluded.has(session.id)) {
        inFlight.push(session.id);
        continue;
      }
      await client.deleteSession(session.id);
      swept.push(session.id);
    }
    if (swept.length > 0) logger.info({ id, worker, swept }, "poller: swept old tick sessions");
    return { swept, inFlight };
  }

  async function pollOne(record: HypothesisRecord, nowMs: number): Promise<HypothesisTickReport> {
    const id = record.id;
    const out: HypothesisTickReport = {
      id,
      evaluated: false,
      evaluationMemoryId: null,
      transitionedTo: null,
      reason: null,
      attention: [],
      swept: [],
      inFlight: [],
      skipped: null,
      error: null,
    };

    try {
      const spec = await readLockedSpec(id);
      if (spec === null) {
        out.skipped = "no_locked_spec";
        return out;
      }
      const liveAtMs = await readLiveAtMs(id);
      if (liveAtMs === null) {
        logger.error({ id }, "poller: live on the board with no trusted status=live row");
        out.skipped = "no_live_row";
        return out;
      }

      const read = await readSeries(id, spec);
      // A foreign dataset contributes an EMPTY series, so a condition over it
      // scores `no_observations` and cannot trip — forged numbers never enter
      // the calculation even when only some metrics are affected. What this
      // branch decides is whether anything BELIEVABLE is left to evaluate.
      if (read.foreign.length > 0 && read.missing.length + read.foreign.length === spec.metrics.length) {
        // 🔴 Not "no data yet" — data Wolf refuses to believe. Reported as its
        // own reason because the operator response is completely different:
        // "wait" versus "someone is writing into this hypothesis's series".
        logger.warn(
          { id, foreign: read.foreign, missing: read.missing },
          "poller: every metric is missing or foreign-written — not evaluating",
        );
        out.skipped = "forged_datasets";
        return out;
      }
      if (read.foreign.length > 0) {
        logger.warn(
          { id, foreign: read.foreign },
          "poller: evaluating WITHOUT the foreign-written metrics",
        );
      }
      if (read.missing.length === spec.metrics.length) {
        // NOTHING has been written yet: the researcher has not run, or its
        // first tick has not finished. Evaluating would score every condition
        // `no_observations` and write a `score=0.00` row that says nothing.
        logger.info({ id, metrics: read.missing }, "poller: no dataset written yet — not evaluating");
        out.skipped = "no_datasets_yet";
        return out;
      }

      const evaluation = evaluate(spec, read.series, liveAtMs, nowMs);
      out.evaluated = true;

      const previousRows = await store.readEvaluationRows(id, EVALUATION_HISTORY_LIMIT);
      const attention = await deriveAttention(evaluation, previousRows);
      out.attention = attention;
      const snapshot: EvaluationSnapshot =
        attention.length > 0 ? { ...evaluation, attention } : evaluation;

      // ── The board's numbers ──────────────────────────────────────────
      const line = evaluationSummaryLine(snapshot);
      const previous = previousRows[0];
      const previousLine =
        previous === undefined ? null : parseTitleFromSnippet(previous.snippet).title;
      // `evaluated=` is the clock and moves every tick, so the comparison is
      // over the rest of the line. Comparing whole lines would make every
      // tick a "change" and append 288 rows a day.
      const changed =
        previousLine === null ||
        evaluationLineWithoutTimestamp(previousLine) !== evaluationLineWithoutTimestamp(line);
      const aged = previous === undefined || nowMs - previous.createdAtMs > EVALUATION_MAX_AGE_MS;
      if (changed || aged) {
        const appended = await store.appendEvaluation({ id, snapshot });
        out.evaluationMemoryId = appended.id;
      }

      // ── The one transition this poller can make ──────────────────────
      const tripped = snapshot.conditions.some((c) => c.state === "tripped");
      const horizonReached = nowMs - liveAtMs >= spec.horizon_days * MS_PER_DAY;
      const reason: ChallengeReason | null = tripped
        ? "condition_tripped"
        : horizonReached
          ? "horizon_reached"
          : null;
      if (reason !== null) {
        out.reason = reason;
        // Through W5's machine, which re-reads the state inside its own lock.
        // A hypothesis already `challenged` is a SELF-transition: no write, no
        // error, no second state memory — which is what makes running this
        // poller twice over the same data idempotent.
        const outcome = await store.transition({
          id,
          to: "challenged",
          evaluation: snapshot,
          rationale: reason,
        });
        if (outcome.changed) {
          out.transitionedTo = "challenged";
          logger.info({ id, reason, memory: outcome.memoryId }, "poller: hypothesis challenged");
        }
      }
    } catch (err) {
      out.error = classifyError(err);
      if (isKind(err, "unavailable")) {
        // The one retryable kind: skip this hypothesis for this tick, no
        // penalty, no state change, try again next interval.
        logger.warn({ id, err }, "poller: Bob unavailable — skipping this hypothesis");
      } else {
        logger.error({ id, err }, "poller: hypothesis failed this tick");
      }
      // The sweep is skipped too: whatever broke the evaluation will break a
      // DELETE as well, and deleting sessions on the strength of a delivery
      // read that may itself have failed is the wrong risk to take.
      return out;
    }

    try {
      const sweep = await sweepTickSessions(id);
      out.swept = sweep.swept;
      out.inFlight = sweep.inFlight;
    } catch (err) {
      out.error = classifyError(err);
      logger.error({ id, err }, "poller: the tick-session sweep failed");
    }
    return out;
  }

  async function tick(): Promise<TickReport> {
    const startedAtMs = toMs(now());
    const report: TickReport = { startedAtMs, live: 0, hypotheses: [], error: null };
    touched = new Set<string>();
    let board: HypothesisRecord[];
    try {
      // The authoritative index is the SESSION LIST, never memory alone —
      // `readBoard` walks `GET /agent/sessions?user_email=*` first and only
      // then attaches state from memories (§ "The trust model").
      board = await store.readBoard();
    } catch (err) {
      report.error = classifyError(err);
      logger.error({ err }, "poller: could not read the board — nothing polled this tick");
      // Returning EARLY, before the cache prune below, is deliberate: a tick
      // that read nothing has touched nothing, and pruning here would throw
      // away every cached series on one transient board failure and
      // re-download every CSV on the next tick.
      return report;
    }
    const live = board.filter((record) => record.status === "live");
    report.live = live.length;
    for (const record of live) {
      // `pollOne` never throws: one hypothesis's failure must never stop the
      // rest, and no throw may escape the interval callback.
      report.hypotheses.push(await pollOne(record, startedAtMs));
    }
    // Drop every cached series this tick did not read: a retired hypothesis's
    // datasets are never asked for again, and the cache must not grow with the
    // number of hypotheses the process has outlived.
    for (const key of [...points.keys()]) {
      if (!touched.has(key)) points.delete(key);
    }
    logger.info(
      {
        live: report.live,
        evaluated: report.hypotheses.filter((h) => h.evaluated).length,
        appended: report.hypotheses.filter((h) => h.evaluationMemoryId !== null).length,
        challenged: report.hypotheses.filter((h) => h.transitionedTo !== null).length,
        failed: report.hypotheses.filter((h) => h.error !== null).length,
      },
      "poller: tick complete",
    );
    return report;
  }

  return {
    tick,
    get running(): boolean {
      return timer !== null;
    },
    start(): void {
      if (timer !== null) return;
      const intervalMs = config.pollIntervalSeconds * 1000;
      timer = setInterval(() => {
        // The callback itself must never throw and never return a rejected
        // promise nobody awaits: an unhandled rejection here takes the whole
        // process down under Node's default `--unhandled-rejections=throw`.
        void tick().catch((err: unknown) => {
          logger.error({ err }, "poller: tick threw — this is a bug in the poller itself");
        });
      }, intervalMs);
      // Never let the poller alone hold the process open; `app.listen` is
      // what keeps it alive, and a stray interval must not turn a finished
      // test or a shutting-down process into a hang.
      timer.unref?.();
      logger.info({ intervalSeconds: config.pollIntervalSeconds }, "poller: started");
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      logger.info({}, "poller: stopped");
    },
  };
}
