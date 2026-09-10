/**
 * The series proxy — the other of the two places Wolf hands the browser
 * something that came from Bob (design/2026-08-20-agent-wolf.md, W11).
 *
 *   GET /api/hypotheses/:id/series/:metric
 *     → 200 { points, unit, version, fetched_at_ms, state }
 *     → 400 invalid    the dataset is malformed (W10's graded rejections)
 *     → 401            no `wolf_session` cookie, and NO upstream request
 *     → 404 not_found  `:metric` names no slug in this hypothesis's locked spec
 *
 * ## Why this is a PROXY and not a redirect
 *
 * Bob sets no CORS headers, by design. A `302` to
 * `…/agent/datasets/…/download`, or a `download_url` for the browser to
 * `fetch`, would therefore fail in the browser for a reason nothing on the
 * server can see — and it would put Wolf's project API key, or an O4 dataset
 * token, into a URL the page holds. So the bytes are fetched server-side with
 * `WOLF_API_KEY` and re-served as JSON. `series.test.ts` asserts the response
 * is a `200` with a JSON body and never a `3xx`.
 *
 * No O4 dataset token is minted either. Those exist so a CONTAINER — which
 * holds no project key — can `curl` a URL; a server that already holds the
 * key has no use for one, and minting one would create a second bearer
 * credential with a lifetime, for nothing.
 *
 * ## The three states, which are three different renderings
 *
 * `never_fetched` and `stale` are not one "no data" marker: W14 says "the
 * researcher has not run yet" for the first and "the last tick failed, here
 * is what we last saw" for the second, and a flat line or a silent gap for
 * either is exactly the failure the state field exists to prevent.
 *
 *  - **`never_fetched`** — Bob 404s the dataset: nothing has ever written
 *    it. Answered `200` with `points: []` and `version: 0`, never a `500`.
 *    This is the state of every metric on the day its hypothesis goes live.
 *  - **`stale`** — the newest observation is older than the spec's
 *    `staleness_days`. The points are returned anyway; the caller decides how
 *    to draw them.
 *  - **`ok`** — otherwise.
 *
 * ## One parser
 *
 * Parsing is W10's `parseCanonicalCsvBytes` (`hypothesis/points.ts`) and
 * nothing else. Two readers of dataset bytes exist in this codebase — the
 * poller and this route — and a second parser is how they silently disagree
 * about what a legitimate file contains. A malformed dataset fails LOUDLY as
 * `invalid`, naming the offending line, rather than rendering as an empty
 * series: a `t,value` header would otherwise yield zero observations from a
 * legitimately written file with no error anywhere.
 */

import { Router, type Request, type Response } from "express";

import { WolfError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BobClient } from "../bob/client.js";
import { toMs, type UnixMs } from "../bob/types.js";
import { requireSignedIn } from "../auth/session.js";
import { MS_PER_DAY, type Point } from "../hypothesis/evaluate.js";
import { parseCanonicalCsvBytes } from "../hypothesis/points.js";
import { extractSpecJsonText } from "../hypothesis/provision.js";
import { validateSpec, type Metric, type Spec } from "../hypothesis/spec.js";
import { newestTrustedRow } from "../hypothesis/store.js";
import { foreignDatasetLog, isOwnDataset } from "../hypothesis/datasettrust.js";
import { requireHypothesisId } from "./embed.js";

/** Exactly one of three. Never a boolean, never a free string. */
/** 🔴 `foreign_writer` is NOT a flavour of "no data": the dataset exists and
 * Wolf refuses it, because a worker other than this hypothesis's own
 * researcher wrote it. Any session in the project can write any dataset
 * name, so the writer is what makes bytes evidence. See `datasettrust.ts`. */
export type SeriesState = "ok" | "never_fetched" | "stale" | "foreign_writer";

export interface SeriesResponse {
  /** Ascending, `{ tMs, v }`, unix MILLISECONDS — the pinned `Point`. */
  points: Point[];
  /** The metric's `unit` from the locked spec, e.g. `"USD"`. */
  unit: string;
  /** The dataset version the points came from; `0` when never written. */
  version: number;
  /** When WOLF read it — unix MILLISECONDS. */
  fetched_at_ms: UnixMs;
  state: SeriesState;
}

/** `kind=hypothesis-spec` — the locked, trusted spec (§ "Memory kinds"). */
const KIND_SPEC = "hypothesis-spec";

/** One page of `kind=hypothesis-spec` rows; there is normally exactly one. */
const ROW_LIMIT = 50;

export interface CreateSeriesRouterOptions {
  client: BobClient;
  logger: Logger;
  /** Injectable clock, so staleness is testable without waiting five days. */
  now?: () => number;
}

/**
 * Decides `stale` vs `ok` for a dataset that exists.
 *
 * Exported because it is the one place the staleness rule lives and W14
 * renders its result. A dataset with NO observations at all is `stale`, not
 * `ok`: the file exists, so something wrote it, and "written but carrying
 * nothing" is a failed tick rather than a healthy series — calling it `ok`
 * would draw an empty chart with no explanation, which is precisely the
 * silent gap these three states exist to abolish. It is not `never_fetched`
 * either: that value means the dataset does not exist, and a caller that
 * cannot tell "no file" from "empty file" cannot tell a hypothesis that has
 * never run from one whose researcher writes headers and no rows.
 */
export function seriesState(points: readonly Point[], stalenessDays: number, nowMs: number): SeriesState {
  const last = points[points.length - 1];
  if (last === undefined) return "stale";
  return nowMs - last.tMs > stalenessDays * MS_PER_DAY ? "stale" : "ok";
}

export function createSeriesRouter(options: CreateSeriesRouterOptions): Router {
  const { client, logger } = options;
  const now = options.now ?? ((): number => Date.now());
  const router = Router();

  /**
   * The newest TRUSTED locked spec for this hypothesis, or `undefined`.
   *
   * The same read the poller makes (`hypothesis/poller.ts`'s `readLockedSpec`),
   * through the same shared helpers — `newestTrustedRow`, `extractSpecJsonText`
   * and `validateSpec` — rather than a second trust rule. It is not lifted into
   * `hypothesis/store.ts` because W11 does not own that file (§ "Parallelism
   * and file ownership" lists W5, W8, W15, W10, W22 and W27 on it, and not
   * this ticket).
   *
   * `include_retracted=1` and `newestTrustedRow` together are what make a
   * HOSTILE retraction — one written from inside a container, trying to hide
   * the spec — visible rather than effective (O11, § "Retraction").
   */
  async function readLockedSpec(id: string): Promise<Spec | undefined> {
    const rows = await client.listMemories({
      selector: `kind=${KIND_SPEC},name=${id}`,
      limit: ROW_LIMIT,
      includeRetracted: true,
    });
    // A one-element session lookup, exactly as the poller uses: the trust
    // rule's third clause asks "is there a session for this name", and the
    // FIRST clause — empty provenance — is the unforgeable one here. Nothing
    // running inside a container can write a row with empty provenance, so a
    // row that passes clause 1 was written by wolf-api itself with its own
    // API key. This route is read-only and returns no state, so it does not
    // pay for the session-index read that W8's detail route makes.
    const row = newestTrustedRow(rows, new Set([id]));
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

  router.get(
    "/api/hypotheses/:id/series/:metric",
    // PER ROUTE and before the handler (R79), so a caller with no cookie is
    // refused without a single upstream request — asserted in series.test.ts.
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        const slug = typeof req.params["metric"] === "string" ? req.params["metric"] : "";

        // The locked spec is the authority on which metrics EXIST, what unit
        // each carries and when a series counts as stale. A hypothesis with
        // no locked spec has no metrics at all, so every `:metric` under it is
        // a 404 — the same answer, deliberately, as a spec that names no such
        // slug: this route is not an oracle for which hypotheses exist.
        const spec = await readLockedSpec(id);
        const metric: Metric | undefined = spec?.metrics.find((m) => m.slug === slug);
        if (spec === undefined || metric === undefined) {
          throw new WolfError("not_found", `no metric ${JSON.stringify(slug)} in this hypothesis`, {
            details: { id, metric: slug },
          });
        }

        // `<hypothesis-id>-<metric-slug>` — the same name the researcher
        // prompt tells the model to `dataset_put`, built in one place.
        const name = `${id}-${metric.slug}`;
        const fetchedAtMs = toMs(now());

        let version: number;
        try {
          // The SINGLE-NAME route, whose body is the BARE metadata object
          // (the LIST route is the one that wraps in `{"datasets":[…]}`).
          const meta = await client.getDataset(name);
          // 🔴 Same gate as the poller and the report frame: any session in
          // the project can write this name, so the writer decides whether
          // these bytes are this hypothesis's series at all. A foreign write
          // is surfaced as its own state, never drawn — see `datasettrust.ts`.
          if (!isOwnDataset(meta, id)) {
            logger.warn(
              foreignDatasetLog(meta, id, name),
              "series: dataset was written by a foreign worker — REFUSING to serve it",
            );
            const body: SeriesResponse = {
              points: [],
              unit: metric.unit,
              version: 0,
              fetched_at_ms: fetchedAtMs,
              state: "foreign_writer",
            };
            res.status(200).json(body);
            return;
          }
          version = meta.version;
        } catch (err) {
          if (err instanceof WolfError && err.kind === "not_found") {
            // Never written. A 200 with an empty series and a state that says
            // WHY — not a 500, and not an `ok` empty chart. `not_found` and
            // `unavailable` must stay distinguishable here for the same
            // reason they must in the poller: an outage is not a missing
            // metric, and this branch must not swallow one.
            logger.info({ id, dataset: name }, "series: dataset not written yet");
            const body: SeriesResponse = {
              points: [],
              unit: metric.unit,
              version: 0,
              fetched_at_ms: fetchedAtMs,
              state: "never_fetched",
            };
            res.status(200).json(body);
            return;
          }
          throw err;
        }

        // Pinned to the version the metadata just named: without it a
        // `dataset_put` landing between these two requests would hand back
        // bytes from a version other than the one this response reports, and
        // the UI would name a snapshot it is not showing.
        const download = await client.downloadDataset(name, { version });
        // W10's parser, and no other. Throws a typed `invalid` WolfError
        // naming the offending line — a 400, never an empty series.
        const points = parseCanonicalCsvBytes(download.body, name);

        const body: SeriesResponse = {
          points,
          unit: metric.unit,
          version,
          fetched_at_ms: fetchedAtMs,
          state: seriesState(points, spec.staleness_days, fetchedAtMs),
        };
        res.status(200).json(body);
      })().catch(next);
    },
  );

  return router;
}
