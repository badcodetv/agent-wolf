/**
 * Who may write a hypothesis's metric datasets — the dataset half of
 * § "The trust model".
 *
 * 🔴 WHY THIS FILE EXISTS. Wolf's status transitions have TWO inputs, and only
 * one of them was defended. Memories are provenance-checked at every read
 * (`isTrusted`, `pickSurvivingRow`), so a row written inside a container can
 * never become state. **Datasets are the other input** — the poller reads
 * `<id>-<slug>`, evaluates the spec's conditions against those numbers, and
 * Wolf itself appends a `challenged` transition when one trips.
 *
 * Bob's `dataset_put` stamps provenance from the token
 * (`mcp_datasets.go:631-632`) but imposes NO name ownership: a session may
 * write ANY name in its project, and `dataset_get` may read any name too.
 * Measured 2026-08-27 from inside a session container: a write to
 * `hyp-victim-fable-probe-rate`, a name that session did not own, returned
 * `version: 2` and read back identically.
 *
 * So without this check the attack is: hostile container writes tripping
 * values into a PEER's dataset name → the peer's poller reads them → **Wolf
 * writes a genuine `challenged` transition**. No tamper flag fires, because
 * the state row really was Wolf's. The forgery happened one step upstream, in
 * the channel nobody guarded.
 *
 * 🔴 THE CHECK IS ON THE **WORKER**, NOT THE SESSION, and that is not a
 * softening. A hypothesis's ticks run in MANY sessions over its life — the
 * poller sweeps old ones and keeps a handful (`sweepTickSessions`) — so a
 * session id is not stable and pinning one would reject legitimate writes
 * within a day. The worker name IS stable and is exactly as forgery-resistant:
 * `caller.Worker` is read from the session ROW server-side, never supplied by
 * the caller (`mcpserver.go:101-110` — `Identified` records that the row was
 * read, "so Worker is authoritative rather than merely unset").
 *
 * Empty is correctly rejected by the same equality. `dataset_put` refuses an
 * unidentified caller outright, so every dataset carries a session; a human
 * chat session has an empty WORKER but a non-empty session, and it is not the
 * application — Wolf's "empty provenance means the application said it" rule
 * requires BOTH fields empty (`store.ts:821`) and no MCP dataset write can
 * produce that. So `createdByWorker === ""` is a foreign writer here, not a
 * trusted one.
 */

import type { DatasetMetadata } from "../bob/types.js";
import { researcherWorkerFor } from "./provision.js";

/**
 * The ONE worker whose writes to hypothesis `id`'s metric datasets count as
 * that hypothesis's own evidence.
 */
export function datasetOwnerFor(id: string): string {
  return researcherWorkerFor(id);
}

/**
 * `<hypothesis-id>-<metric-slug>` — the name the researcher prompt tells the
 * model to `dataset_put`. Built here so the three readers cannot spell it
 * three ways.
 */
export function metricDatasetName(id: string, slug: string): string {
  return `${id}-${slug}`;
}

/**
 * True when this dataset version was written by hypothesis `id`'s own
 * researcher. A caller that gets `false` must not evaluate, chart, or report
 * the bytes — they are another container's word about someone else's series.
 */
export function isOwnDataset(
  meta: Pick<DatasetMetadata, "createdByWorker">,
  id: string,
): boolean {
  return meta.createdByWorker === datasetOwnerFor(id);
}

/** The operator-facing log payload for a refused dataset. */
export function foreignDatasetLog(
  meta: Pick<DatasetMetadata, "createdByWorker" | "createdBySession" | "version">,
  id: string,
  name: string,
): Record<string, unknown> {
  return {
    id,
    dataset: name,
    version: meta.version,
    expected_worker: datasetOwnerFor(id),
    written_by_worker: meta.createdByWorker,
    written_by_session: meta.createdBySession,
  };
}
