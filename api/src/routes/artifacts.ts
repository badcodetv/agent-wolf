/**
 * Wolf's artifact surface — the metadata list for one hypothesis's session
 * (design/2026-08-20-agent-wolf.md, W29).
 *
 *   GET /api/hypotheses/:id/artifacts
 *     → 200 { artifacts: [...] }   the metadata list, projected
 *     → 400 invalid                `:id` is not a bare 8-hex hypothesis id
 *     → 401                        no `wolf_session` cookie, and NO upstream request
 *     → 404 not_found              no session named `hyp-<id>`
 *
 * ## Why this is a server-side PROXY and never a redirect
 *
 * The same argument the series route makes, and for the same two reasons.
 * Orange sets no CORS headers by design, so a `302` to
 * `…/agent/sessions/by-name/…/artifacts` would fail in the browser for a
 * reason nothing on this server can see. And the only credential that opens
 * that route is `WOLF_API_KEY`, Wolf's **project-wide** key: putting it — or a
 * URL that carries it — into a page is handing every reader of that page the
 * whole project. So the list is fetched here, with the key, and re-served as
 * Wolf's own JSON. `artifacts.test.ts` asserts a `200` with a JSON body, a
 * `Location` header that is absent, and a body that names no Orange address.
 *
 * ## The projection is an ALLOW-LIST, and that is the point
 *
 * `artifactRow` names the ten fields that leave this process. Two things it
 * deliberately drops:
 *
 *  - **`blobPath`** — the STORE's object key (`gs://<bucket>/<session>/<file>`).
 *    It describes where Orange keeps the bytes and is of no use to a browser;
 *    publishing it hands out the storage layout for free.
 *  - **`sessionId`** — Orange's session uuid. Wolf addresses a session by the
 *    name it chose (`hyp-<id>`) everywhere else, and a uuid in the page is one
 *    more handle a caller can try somewhere it was not scoped to.
 *
 * An allow-list rather than a delete-list because the failure directions are
 * not symmetric: a field Orange ADDS tomorrow is dropped by an allow-list and
 * published by a delete-list, and nothing in either repo would say so.
 *
 * ## The one line of credential handling
 *
 * 🔴 **Never log a `download_url`.** Nothing here builds one — the response
 * carries no URL at all, and artifact BYTES are a different route and out of
 * W29's scope — and the log line below carries the hypothesis id, the session
 * name and a COUNT. That is the whole rule, and it is one line of code.
 */

import { Router, type Request, type Response } from "express";

import type { Logger } from "../logger.js";
import type { OrangeClient } from "../orange/client.js";
import type { ArtifactRecord } from "../orange/types.js";
import { requireSignedIn } from "../auth/session.js";
import { sessionNameForHypothesis } from "../hypothesis/store.js";
import { requireHypothesisId } from "./embed.js";

/**
 * One artifact as WOLF serves it: snake_case, like every other Wolf wire
 * shape, and ten fields exactly.
 *
 * `status` and `artifact_type` are strings rather than unions on purpose.
 * Orange's own sets are `live | extracted | lost | extraction_failed` and
 * `file | code | image | data | webapp` (explicitly "extensible"), and a
 * closed union here would turn a value Orange adds into a parse failure that
 * costs the whole panel — where passing it through costs one row's dot colour.
 */
export interface ArtifactRow {
  id: string;
  /** Orange's dedup key with the session. May or may not carry a leading slash — whoever wrote it decided. */
  file_path: string;
  artifact_type: string;
  status: string;
  label: string;
  description: string;
  mime_type: string;
  /** Bytes. `fileSize` on Orange's wire; the unit is in the name here by house rule. */
  file_size_bytes: number;
  source: string;
  is_dir: boolean;
}

export interface ArtifactsResponse {
  artifacts: ArtifactRow[];
}

/**
 * The allow-list projection, exported so it can be graded on its own — the
 * key that is NOT in the result is as much of the contract as the ten that
 * are.
 */
export function artifactRow(record: ArtifactRecord): ArtifactRow {
  return {
    id: record.id,
    file_path: record.filePath,
    artifact_type: record.artifactType,
    status: record.status,
    label: record.label,
    description: record.description,
    mime_type: record.mimeType,
    file_size_bytes: record.fileSizeBytes,
    source: record.source,
    is_dir: record.isDir,
  };
}

export interface CreateArtifactsRouterOptions {
  client: OrangeClient;
  logger: Logger;
}

export function createArtifactsRouter(options: CreateArtifactsRouterOptions): Router {
  const { client, logger } = options;
  const router = Router();

  router.get(
    "/api/hypotheses/:id/artifacts",
    // PER ROUTE and before the handler (R79), so a caller with no cookie is
    // refused without a single upstream request — asserted in artifacts.test.ts.
    requireSignedIn,
    (req: Request, res: Response, next) => {
      void (async () => {
        const id = requireHypothesisId(req.params["id"]);
        // § Vocabulary: the id is BARE and the `hyp-` prefix belongs to the
        // session name and to nothing else. Built by the one helper that
        // spells it, never re-spelled here.
        const sessionName = sessionNameForHypothesis(id);

        // An absent session — or one belonging to another project, which
        // Orange deliberately does not distinguish — is a `not_found` from the
        // client's standard status mapping, and reaches the caller as a 404.
        // It is never a 500: this route is not an existence oracle and a
        // hypothesis whose session was reaped is a normal state, not a fault.
        const records = await client.listSessionArtifacts(sessionName);

        // The id, the session name and a COUNT. No path, no blob path, no URL.
        logger.info({ id, session: sessionName, artifacts: records.length }, "artifacts listed");

        const body: ArtifactsResponse = { artifacts: records.map(artifactRow) };
        res.status(200).json(body);
      })().catch(next);
    },
  );

  return router;
}
