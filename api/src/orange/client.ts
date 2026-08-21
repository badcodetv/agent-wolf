/**
 * A typed client for every Orange route Wolf touches — the list is
 * exhaustive and closed at twenty-two routes; see
 * design/2026-08-20-agent-wolf.md § W2's Scope. No other file may add a
 * route here except W15 (strictly serial after this ticket).
 *
 * The client reads no environment variable: it is constructed with
 * `createOrangeClient({ baseUrl, apiKey })` and the caller supplies both
 * (`api/src/config.ts` is owned by other tickets and this file does not
 * touch it). The API key lives only in the `ctx` closure below and is
 * used only to set the `X-API-Key` header — it is never placed in a
 * `WolfError`, a log line, or any returned value.
 */

import pino from "pino";
import type { Logger } from "../logger.js";
import { WolfError, type WolfErrorKind } from "../errors.js";
import {
  toMs,
  toSec,
  type AttentionRequestRecord,
  type CreateSessionResult,
  type DatasetDownload,
  type DatasetMetadata,
  type DeliveryRecord,
  type EmbedTokenResult,
  type MemoryRecord,
  type MemoryRetraction,
  type MemorySearchResultRow,
  type ProjectSettings,
  type PutProjectSettingsParams,
  type PutWorkerParams,
  type CreateScheduleParams,
  type ListAttentionRequestsParams,
  type ListDeliveriesParams,
  type ScheduleRecord,
  type SessionByName,
  type SessionListRow,
  type VerifyGoogleResult,
  type WorkerRecord,
} from "./types.js";

// Re-exported here (not redeclared) so callers importing route-parameter
// types from this module keep working — the one home for both is types.ts.
export type { ListAttentionRequestsParams, ListDeliveriesParams };

// ── Request/response parameter shapes not worth a whole export from types.ts ──

export interface ListMemoriesParams {
  selector?: string;
  query?: string;
  limit?: number;
  latestPer?: string;
  since?: string;
  until?: string;
  /** `?include_retracted=1` (O11). Omitted entirely when false — the route 400s on any other value, including `0`. */
  includeRetracted?: boolean;
}

export interface AppendMemoryParams {
  labels: Record<string, string>;
  content: string;
  /** Server default is `true`; only sent when the caller sets it explicitly. */
  embed?: boolean;
}

export interface ListSessionsParams {
  worker?: string;
  limit?: number;
  offset?: number;
}

export interface DownloadDatasetParams {
  version?: number;
  /** A scoped dataset download token, as an alternative to the project API key already carried on every call. */
  token?: string;
}

export interface OrangeClient {
  createSession(params: { name: string; worker?: string }): Promise<CreateSessionResult>;
  getSessionByName(name: string): Promise<SessionByName>;
  deleteSession(id: string): Promise<void>;
  listSessions(params?: ListSessionsParams): Promise<SessionListRow[]>;

  appendMemory(params: AppendMemoryParams): Promise<MemoryRecord>;
  listMemories(params?: ListMemoriesParams): Promise<MemorySearchResultRow[]>;
  /**
   * `GET /agent/memories/{id}` — FULL content, not the 500-character snippet
   * the list route returns. Deliberately not retraction-filtered on the Orange
   * side (`go/agentdb/memories.go:281-283`: "fetching a specific id is an
   * explicit request for that row"), which is what lets W15's report reads
   * serve a template a hostile retraction tried to hide.
   */
  getMemoryById(id: string): Promise<MemoryRecord>;
  /** @deprecated W15 named this `getMemoryById`; this alias is kept only so W8's routes keep compiling. */
  getMemory(id: string): Promise<MemoryRecord>;
  /**
   * `GET /agent/memories/current?name=` — FULL content, the newest memory
   * carrying `name=<name>`.
   *
   * ⚠️ `kind` is filtered CLIENT-SIDE and cannot be pushed to the server.
   * Orange's route builds the selector as exactly `"name=" + name`
   * (`go/httpapi/memories.go:391`) and accepts no other parameter, so it
   * answers with the newest memory of ANY kind carrying that name — and every
   * kind in Wolf's vocabulary shares `name=<hypothesis id>`. Passing `kind`
   * asserts what came back; it does not search past it. When the newest row is
   * a different kind the result is `not_found`, NOT the newest row of the kind
   * asked for. Anything that needs "the newest row of this kind" must use
   * `listMemories` with a `kind=,name=` selector — which is also the only way
   * to pass `include_retracted=1`, which this route does not support at all.
   */
  getCurrentMemory(name: string, kind?: string): Promise<MemoryRecord>;

  listDatasets(params?: { selector?: string; limit?: number }): Promise<DatasetMetadata[]>;
  getDataset(name: string): Promise<DatasetMetadata>;
  downloadDataset(name: string, params?: DownloadDatasetParams): Promise<DatasetDownload>;

  putWorker(name: string, params: PutWorkerParams): Promise<WorkerRecord>;
  deleteWorker(name: string, params?: { rationale?: string }): Promise<void>;

  createSchedule(params: CreateScheduleParams): Promise<ScheduleRecord>;
  listSchedules(): Promise<ScheduleRecord[]>;
  deleteSchedule(id: string, params?: { rationale?: string }): Promise<void>;

  listDeliveries(params?: ListDeliveriesParams): Promise<DeliveryRecord[]>;
  listAttentionRequests(params?: ListAttentionRequestsParams): Promise<AttentionRequestRecord[]>;

  getProjectSettings(): Promise<ProjectSettings>;
  putProjectSettings(params: PutProjectSettingsParams): Promise<ProjectSettings>;

  createEmbedToken(session: string, ttlSeconds?: number): Promise<EmbedTokenResult>;
  verifyGoogle(credential: string): Promise<VerifyGoogleResult>;
}

export interface CreateOrangeClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Defaults to a silent pino instance; pass a real one to see the one-line-per-request log. */
  logger?: Logger;
}

// ── The one HTTP core every method calls through ─────────────────────────

interface ClientContext {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
}

type QueryValue = string | number | boolean | undefined;

type ErrorOverride = (status: number, bodyText: string) => WolfError | undefined;

interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  jsonBody?: unknown;
  /** Status codes that count as success. Any other 2xx is `internal`, naming the status (R36's lesson, generalised). */
  expectStatus?: number[];
  parse?: "json" | "none" | "bytes";
  errorOverride?: ErrorOverride;
}

interface RequestResult {
  status: number;
  json?: unknown;
  bytes?: ArrayBuffer;
  contentType?: string;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * The fixed status → kind mapping (§ "Non-2xx responses become `WolfError`s").
 * Callers may override a specific status via `errorOverride` (the
 * `/auth/verify-google` 404 and the port-pool-exhaustion 403 both do).
 *
 * `unavailable` is the ONLY kind W10's poller retries — every other kind is
 * treated as terminal for that tick. That is why an unrecognised status
 * (e.g. 418) must fall through to `internal` in the `default` branch below,
 * never to `unavailable`: mapping an unknown status to `unavailable` would
 * make W10 retry something that may never resolve (R39).
 */
function classifyStatus(status: number): WolfErrorKind {
  switch (status) {
    case 401:
      // W15: this case was MISSING, so an Orange 401 fell through `default`
      // and arrived as kind `internal` — "WE have a bug" — for what is in fact
      // a rejected credential. W8 needed `POST /auth/verify-google`'s 401 to
      // read as `forbidden` and worked around it by branching on
      // `err.status === 401` inside its own route rather than editing this
      // file, which left every OTHER caller that branches on `kind`
      // mis-handling a 401. `forbidden` is the taxonomy's "authenticated but
      // not allowed", and it is emphatically NOT `unavailable`: a 401 never
      // clears by retrying.
      //
      // The STATUS stays 401 (`defaultErrorFor` passes it through), so W8's
      // existing `err.status === 401` branch keeps working unchanged.
      return "forbidden";
    case 404:
    case 410:
      return "not_found";
    case 409:
      return "conflict";
    case 403:
      return "forbidden";
    case 400:
    case 422:
      return "invalid";
    case 501:
      return "misconfigured";
    case 500:
    case 502:
    case 503:
    case 504:
      return "unavailable";
    default:
      return "internal";
  }
}

function defaultErrorFor(status: number, method: string, path: string, bodyText: string): WolfError {
  const kind = classifyStatus(status);
  if (kind === "misconfigured") {
    // 501 on this product surface means "not running on Postgres" — the one
    // config value that answer always traces back to.
    return new WolfError(
      "misconfigured",
      `Orange ${method} ${path}: the product layer is not configured (DATABASE_URL)`,
      { status, upstreamBody: bodyText, details: { variable: "DATABASE_URL" } },
    );
  }
  return new WolfError(kind, `Orange ${method} ${path} failed with status ${status}`, {
    status,
    upstreamBody: bodyText,
  });
}

async function doRequest(ctx: ClientContext, opts: RequestOptions): Promise<RequestResult> {
  const url = buildUrl(ctx.baseUrl, opts.path, opts.query);
  const headers: Record<string, string> = { "X-API-Key": ctx.apiKey };
  let body: string | undefined;
  if (opts.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.jsonBody);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method, headers, body });
  } catch (err) {
    ctx.logger.warn({ method: opts.method, path: opts.path }, "orange request: network error");
    throw new WolfError("unavailable", `Orange is unreachable: ${opts.method} ${opts.path}`, {
      cause: err,
    });
  }

  const expect = opts.expectStatus ?? [200];

  if (res.ok) {
    if (!expect.includes(res.status)) {
      const bodyText = await safeText(res);
      ctx.logger.warn(
        { method: opts.method, path: opts.path, status: res.status },
        "orange request: unexpected success status",
      );
      throw new WolfError(
        "internal",
        `Orange ${opts.method} ${opts.path} returned unexpected status ${res.status}`,
        { status: res.status, upstreamBody: bodyText },
      );
    }
    ctx.logger.info({ method: opts.method, path: opts.path, status: res.status }, "orange request: ok");
    if (opts.parse === "bytes") {
      const bytes = await res.arrayBuffer();
      return { status: res.status, bytes, contentType: res.headers.get("content-type") ?? "" };
    }
    if (opts.parse === "none") {
      return { status: res.status };
    }
    const text = await safeText(res);
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }

  const bodyText = await safeText(res);
  const err = opts.errorOverride?.(res.status, bodyText) ?? defaultErrorFor(res.status, opts.method, opts.path, bodyText);
  ctx.logger.warn(
    { method: opts.method, path: opts.path, status: res.status, kind: err.kind },
    "orange request: failed",
  );
  throw err;
}

// ── Small, strict-mode-friendly JSON narrowing helpers ────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function invalidShape(where: string, why: string): WolfError {
  return new WolfError("invalid", `unexpected response shape from ${where}: ${why}`);
}

function strField(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : "";
}

function numField(raw: Record<string, unknown>, key: string): number {
  const v = raw[key];
  return typeof v === "number" ? v : 0;
}

function boolField(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}

function recordField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  return isRecord(v) ? v : {};
}

/**
 * A provenance field — `created_by_worker` / `created_by_session` — which must
 * be PRESENT and a string. An absent one is an `invalid` error, never `""`.
 *
 * ⚠️ **This is the one place in the whole product where the trust rule depends
 * on a field being PRESENT rather than on its value.** § "The trust model"
 * reads: *a memory is trusted iff `created_by_worker === "" && created_by_session === ""`*
 * — so a row that simply OMITS both keys, mapped through the ordinary
 * `strField` default, becomes two empty strings and reads as **trusted**. It
 * fails OPEN, in the direction of granting authority.
 *
 * It is not reachable through today's `agentd`: `agentdb.MemorySearchResult`
 * tags both fields without `omitempty` (`go/agentdb/memories.go:133-134`), so
 * they are always emitted. But the defence cannot be mounted from
 * `hypothesis/store.ts` — by the time the store sees the row the distinction
 * between "absent" and "empty" is already gone — so it is mounted here, at the
 * only boundary that can still tell them apart. W5 found this and named W15 as
 * the owner. Rejecting the shape is the safe direction: a mapper that throws
 * is a visible failure, a mapper that fabricates provenance is a silent one.
 */
function provenanceField(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key];
  if (typeof v !== "string") {
    throw invalidShape(
      where,
      `${key} is ${v === undefined ? "absent" : "not a string"} — provenance must be PRESENT, ` +
        "because the trust rule tests it for EMPTINESS and an absent field would read as trusted",
    );
  }
  return v;
}

function labelsField(raw: Record<string, unknown>): Record<string, string> {
  const v = raw["labels"];
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// ── Response mappers: Orange's snake_case wire → this module's camelCase types ──

function mapMemoryRetraction(raw: unknown, where: string): MemoryRetraction {
  if (!isRecord(raw)) throw invalidShape(where, "expected a retraction object");
  return {
    memoryId: strField(raw, "memory_id"),
    createdByWorker: provenanceField(raw, "created_by_worker", where),
    createdBySession: provenanceField(raw, "created_by_session", where),
    createdAtMs: toMs(numField(raw, "created_at")),
  };
}

function mapMemorySearchRow(raw: unknown, where: string): MemorySearchResultRow {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  const row: MemorySearchResultRow = {
    id: strField(raw, "id"),
    labels: labelsField(raw),
    snippet: strField(raw, "snippet"),
    score: numField(raw, "score"),
    createdByWorker: provenanceField(raw, "created_by_worker", where),
    createdBySession: provenanceField(raw, "created_by_session", where),
    createdAtMs: toMs(numField(raw, "created_at")),
  };
  const retractedByRaw = raw["retracted_by"];
  if (Array.isArray(retractedByRaw)) {
    row.retractedBy = retractedByRaw.map((r) => mapMemoryRetraction(r, where));
  }
  return row;
}

function mapMemoryRecord(raw: unknown, where: string): MemoryRecord {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  return {
    id: strField(raw, "id"),
    labels: labelsField(raw),
    content: strField(raw, "content"),
    createdByWorker: provenanceField(raw, "created_by_worker", where),
    createdBySession: provenanceField(raw, "created_by_session", where),
    createdAtMs: toMs(numField(raw, "created_at")),
  };
}

/**
 * `version` is required and must be numeric — an envelope Orange did not
 * actually send (or a version-less row) is an `invalid` error, never a
 * silently-`undefined` field. W10's version gate compares `version`
 * values on every tick; `undefined !== undefined` is `false`, so a quiet
 * fallback here would make it re-download every CSV 288 times a day.
 */
function mapDatasetMetadata(raw: unknown, where: string): DatasetMetadata {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  const version = raw["version"];
  if (typeof version !== "number") {
    throw invalidShape(where, 'missing or non-numeric "version" field');
  }
  return {
    id: strField(raw, "id"),
    name: strField(raw, "name"),
    version,
    labels: labelsField(raw),
    sizeBytes: numField(raw, "size_bytes"),
    rowCount: numField(raw, "row_count"),
    sha256: strField(raw, "sha256"),
    contentType: strField(raw, "content_type"),
    createdByWorker: strField(raw, "created_by_worker"),
    createdBySession: strField(raw, "created_by_session"),
    createdAtMs: toMs(numField(raw, "created_at")),
  };
}

function mapWorkerRecord(raw: unknown, where: string): WorkerRecord {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  const briefingRaw = raw["briefing"];
  return {
    project: strField(raw, "project"),
    name: strField(raw, "name"),
    description: strField(raw, "description"),
    systemPrompt: strField(raw, "system_prompt"),
    mcpConfig: recordField(raw, "mcp_config"),
    image: strField(raw, "image"),
    briefing: Array.isArray(briefingRaw)
      ? briefingRaw.filter((x): x is string => typeof x === "string")
      : undefined,
    maxInstances: numField(raw, "max_instances"),
    enabled: boolField(raw, "enabled"),
    frozen: boolField(raw, "frozen"),
    createdAtSec: toSec(numField(raw, "created_at")),
    updatedAtSec: toSec(numField(raw, "updated_at")),
  };
}

function mapScheduleRecord(raw: unknown, where: string): ScheduleRecord {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  const targetSession = strField(raw, "target_session");
  return {
    id: strField(raw, "id"),
    project: strField(raw, "project"),
    worker: strField(raw, "worker"),
    targetSession: targetSession || undefined,
    cron: strField(raw, "cron"),
    input: strField(raw, "input"),
    enabled: boolField(raw, "enabled"),
    createdAtSec: raw["created_at"] !== undefined ? toSec(numField(raw, "created_at")) : undefined,
    updatedAtSec: raw["updated_at"] !== undefined ? toSec(numField(raw, "updated_at")) : undefined,
  };
}

function mapDeliveryRecord(raw: unknown, where: string): DeliveryRecord {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  return {
    id: strField(raw, "id"),
    project: strField(raw, "project"),
    eventId: strField(raw, "event_id"),
    subscriptionId: strField(raw, "subscription_id"),
    sessionId: strField(raw, "session_id"),
    worker: strField(raw, "worker"),
    scheduleId: strField(raw, "schedule_id"),
    status: strField(raw, "status"),
    failureReason: strField(raw, "failure_reason"),
    startedAtSec: toSec(numField(raw, "started_at")),
    endedAtSec: toSec(numField(raw, "ended_at")),
    createdAtSec: toSec(numField(raw, "created_at")),
    updatedAtSec: toSec(numField(raw, "updated_at")),
  };
}

function mapAttentionRequest(raw: unknown, where: string): AttentionRequestRecord {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  return {
    id: strField(raw, "id"),
    sessionId: strField(raw, "session_id"),
    worker: strField(raw, "worker"),
    message: strField(raw, "message"),
    createdAtSec: toSec(numField(raw, "created_at")),
    expiresAtSec: toSec(numField(raw, "expires_at")),
    answeredAtSec: toSec(numField(raw, "answered_at")),
    timedOutAtSec: toSec(numField(raw, "timed_out_at")),
  };
}

function mapProjectSettings(raw: unknown, where: string): ProjectSettings {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  return {
    project: strField(raw, "project"),
    baseImage: strField(raw, "base_image"),
    systemPrompt: strField(raw, "system_prompt"),
    mcpConfig: recordField(raw, "mcp_config"),
    attentionChannel: recordField(raw, "attention_channel"),
    maxConcurrentJobs: numField(raw, "max_concurrent_jobs"),
    dailyTokensSoft: numField(raw, "daily_tokens_soft"),
    dailyTokensHard: numField(raw, "daily_tokens_hard"),
    briefingMaxBytes: numField(raw, "briefing_max_bytes"),
    snapshotTtlDays: numField(raw, "snapshot_ttl_days"),
    updatedAtSec: toSec(numField(raw, "updated_at")),
  };
}

function mapSessionListRow(raw: unknown, where: string): SessionListRow {
  if (!isRecord(raw)) throw invalidShape(where, "expected an object");
  return {
    id: strField(raw, "id"),
    name: strField(raw, "name") || undefined,
    worker: strField(raw, "worker") || undefined,
    status: strField(raw, "status"),
    createdAtSec: toSec(numField(raw, "created_at")),
    updatedAtSec: toSec(numField(raw, "updated_at")),
  };
}

// ── The 22 route methods ───────────────────────────────────────────────

function createSession(
  ctx: ClientContext,
  params: { name: string; worker?: string },
): Promise<CreateSessionResult> {
  return doRequest(ctx, {
    method: "POST",
    path: "/agent/session",
    jsonBody: { name: params.name, worker: params.worker },
    // "host port pool is exhausted" is operational and actionable; flattening
    // it into the generic 403→forbidden mapping would throw that away, and
    // treating it as non-retryable would be wrong — deleting a finished
    // session genuinely clears the condition.
    errorOverride: (status, bodyText) => {
      if (status === 403 && bodyText.includes("host port pool is exhausted")) {
        // W15: this used to carry the UPSTREAM status (403) on kind
        // `unavailable`, which contradicts the taxonomy — `unavailable` is
        // 503 — and `unavailable` is the ONE retryable kind. A retry loop
        // that reads the status rather than the kind (or a proxy that does)
        // sees "403 Forbidden", concludes the condition is permanent, and
        // stops retrying the one outage that genuinely clears when a finished
        // session is deleted. The status is restated at 503; the MESSAGE and
        // `upstreamBody` are Orange's, verbatim, because "host port pool is
        // exhausted" is the only actionable part of it, and the upstream
        // status is preserved in `details` rather than thrown away.
        return new WolfError("unavailable", bodyText, {
          status: 503,
          upstreamBody: bodyText,
          details: { upstreamStatus: status },
        });
      }
      return undefined;
    },
  }).then(({ json }) => {
    if (!isRecord(json)) throw invalidShape("POST /agent/session", "expected an object");
    return {
      id: strField(json, "id"),
      status: strField(json, "status"),
      workflowId: strField(json, "workflowId"),
    };
  });
}

function getSessionByName(ctx: ClientContext, name: string): Promise<SessionByName> {
  return doRequest(ctx, {
    method: "GET",
    path: `/agent/sessions/by-name/${encodeURIComponent(name)}`,
  }).then(({ json }) => {
    if (!isRecord(json)) throw invalidShape("GET /agent/sessions/by-name", "expected an object");
    const createError = strField(json, "create_error");
    return {
      id: strField(json, "id"),
      name: strField(json, "name"),
      customer: strField(json, "customer"),
      job: strField(json, "job") || undefined,
      persona: strField(json, "persona") || undefined,
      title: strField(json, "title") || undefined,
      status: strField(json, "status"),
      createError: createError || undefined,
      createdAtSec: toSec(numField(json, "created_at")),
      updatedAtSec: toSec(numField(json, "updated_at")),
    };
  });
}

async function deleteSession(ctx: ClientContext, id: string): Promise<void> {
  await doRequest(ctx, {
    method: "DELETE",
    path: `/agent/session/${encodeURIComponent(id)}`,
    parse: "none",
    expectStatus: [204],
  });
}

function listSessions(ctx: ClientContext, params?: ListSessionsParams): Promise<SessionListRow[]> {
  // ?user_email=* is not optional: an API key's synthetic email
  // (api-key:<project>) matches no session row, and the list would
  // otherwise come back empty.
  const query: Record<string, QueryValue> = { user_email: "*" };
  if (params?.worker !== undefined) query.worker = params.worker;
  if (params?.limit !== undefined) query.limit = params.limit;
  if (params?.offset !== undefined) query.offset = params.offset;
  return doRequest(ctx, { method: "GET", path: "/agent/sessions", query }).then(({ json }) => {
    if (!Array.isArray(json)) throw invalidShape("GET /agent/sessions", "expected a bare array");
    return json.map((row) => mapSessionListRow(row, "GET /agent/sessions"));
  });
}

function appendMemory(ctx: ClientContext, params: AppendMemoryParams): Promise<MemoryRecord> {
  const body: Record<string, unknown> = { labels: params.labels, content: params.content };
  if (params.embed !== undefined) body.embed = params.embed;
  // Orange's append route answers 201 (R36); any other 2xx is a silent
  // contract change and must surface as an error rather than be absorbed.
  return doRequest(ctx, {
    method: "POST",
    path: "/agent/memories",
    jsonBody: body,
    expectStatus: [201],
  }).then(({ json }) => mapMemoryRecord(json, "POST /agent/memories"));
}

function listMemories(ctx: ClientContext, params?: ListMemoriesParams): Promise<MemorySearchResultRow[]> {
  const query: Record<string, QueryValue> = {
    selector: params?.selector,
    query: params?.query,
    limit: params?.limit,
    latest_per: params?.latestPer,
    since: params?.since,
    until: params?.until,
  };
  if (params?.includeRetracted === true) {
    query.include_retracted = 1;
  }
  return doRequest(ctx, { method: "GET", path: "/agent/memories", query }).then(({ json }) => {
    if (!isRecord(json) || !Array.isArray(json["memories"])) {
      throw invalidShape("GET /agent/memories", 'expected {"memories": [...]}');
    }
    return json["memories"].map((m) => mapMemorySearchRow(m, "GET /agent/memories"));
  });
}

function getMemory(ctx: ClientContext, id: string): Promise<MemoryRecord> {
  return doRequest(ctx, {
    method: "GET",
    path: `/agent/memories/${encodeURIComponent(id)}`,
  }).then(({ json }) => mapMemoryRecord(json, `GET /agent/memories/${id}`));
}

function getCurrentMemory(ctx: ClientContext, name: string, kind?: string): Promise<MemoryRecord> {
  return doRequest(ctx, {
    method: "GET",
    path: "/agent/memories/current",
    query: { name },
  }).then(({ json }) => {
    const record = mapMemoryRecord(json, "GET /agent/memories/current");
    // The kind assertion is client-side because the route has nowhere to put
    // it — see the interface comment. Reported as `not_found` rather than
    // `invalid`: from the caller's point of view "the current memory named X
    // is not a Y" is exactly "there is no current Y named X", and Orange
    // already answers 404 for the neighbouring case.
    if (kind !== undefined && record.labels["kind"] !== kind) {
      throw new WolfError(
        "not_found",
        `GET /agent/memories/current?name=${name}: the newest memory with that name is kind ` +
          `${JSON.stringify(record.labels["kind"] ?? "")}, not ${JSON.stringify(kind)}`,
        { status: 404, details: { name, kind, found: record.labels["kind"] ?? "" } },
      );
    }
    return record;
  });
}

function listDatasets(
  ctx: ClientContext,
  params?: { selector?: string; limit?: number },
): Promise<DatasetMetadata[]> {
  const query: Record<string, QueryValue> = { selector: params?.selector, limit: params?.limit };
  return doRequest(ctx, { method: "GET", path: "/agent/datasets", query }).then(({ json }) => {
    if (!isRecord(json) || !Array.isArray(json["datasets"])) {
      throw invalidShape("GET /agent/datasets", 'expected {"datasets": [...]}');
    }
    return json["datasets"].map((d) => mapDatasetMetadata(d, "GET /agent/datasets"));
  });
}

function getDataset(ctx: ClientContext, name: string): Promise<DatasetMetadata> {
  return doRequest(ctx, {
    method: "GET",
    path: `/agent/datasets/${encodeURIComponent(name)}`,
  }).then(({ json }) => mapDatasetMetadata(json, `GET /agent/datasets/${name}`));
}

function downloadDataset(
  ctx: ClientContext,
  name: string,
  params?: DownloadDatasetParams,
): Promise<DatasetDownload> {
  const query: Record<string, QueryValue> = { version: params?.version, token: params?.token };
  return doRequest(ctx, {
    method: "GET",
    path: `/agent/datasets/${encodeURIComponent(name)}/download`,
    query,
    parse: "bytes",
  }).then(({ bytes, contentType }) => ({ contentType: contentType ?? "", body: bytes ?? new ArrayBuffer(0) }));
}

function putWorker(ctx: ClientContext, name: string, params: PutWorkerParams): Promise<WorkerRecord> {
  const body = {
    description: params.description,
    system_prompt: params.systemPrompt,
    mcp_config: params.mcpConfig,
    image: params.image,
    max_instances: params.maxInstances,
    briefing: params.briefing,
    enabled: params.enabled,
    frozen: params.frozen,
    rationale: params.rationale,
  };
  return doRequest(ctx, {
    method: "PUT",
    path: `/agent/workers/${encodeURIComponent(name)}`,
    jsonBody: body,
  }).then(({ json }) => mapWorkerRecord(json, `PUT /agent/workers/${name}`));
}

async function deleteWorker(
  ctx: ClientContext,
  name: string,
  params?: { rationale?: string },
): Promise<void> {
  await doRequest(ctx, {
    method: "DELETE",
    path: `/agent/workers/${encodeURIComponent(name)}`,
    query: { rationale: params?.rationale },
    parse: "none",
    expectStatus: [204],
  });
}

function createSchedule(ctx: ClientContext, params: CreateScheduleParams): Promise<ScheduleRecord> {
  const body = {
    worker: params.worker,
    target_session: params.targetSession,
    cron: params.cron,
    input: params.input,
    enabled: params.enabled,
    rationale: params.rationale,
  };
  return doRequest(ctx, {
    method: "POST",
    path: "/agent/schedules",
    jsonBody: body,
    expectStatus: [201],
  }).then(({ json }) => mapScheduleRecord(json, "POST /agent/schedules"));
}

function listSchedules(ctx: ClientContext): Promise<ScheduleRecord[]> {
  return doRequest(ctx, { method: "GET", path: "/agent/schedules" }).then(({ json }) => {
    if (!isRecord(json) || !Array.isArray(json["schedules"])) {
      throw invalidShape("GET /agent/schedules", 'expected {"schedules": [...]}');
    }
    return json["schedules"].map((s) => mapScheduleRecord(s, "GET /agent/schedules"));
  });
}

async function deleteSchedule(
  ctx: ClientContext,
  id: string,
  params?: { rationale?: string },
): Promise<void> {
  await doRequest(ctx, {
    method: "DELETE",
    path: `/agent/schedules/${encodeURIComponent(id)}`,
    query: { rationale: params?.rationale },
  });
}

function listDeliveries(ctx: ClientContext, params?: ListDeliveriesParams): Promise<DeliveryRecord[]> {
  const query: Record<string, QueryValue> = {
    event_id: params?.eventId,
    subscription_id: params?.subscriptionId,
    status: params?.status,
    limit: params?.limit,
    offset: params?.offset,
  };
  return doRequest(ctx, { method: "GET", path: "/agent/deliveries", query }).then(({ json }) => {
    if (!isRecord(json) || !Array.isArray(json["deliveries"])) {
      throw invalidShape("GET /agent/deliveries", 'expected {"deliveries": [...]}');
    }
    return json["deliveries"].map((d) => mapDeliveryRecord(d, "GET /agent/deliveries"));
  });
}

function listAttentionRequests(
  ctx: ClientContext,
  params?: ListAttentionRequestsParams,
): Promise<AttentionRequestRecord[]> {
  const query: Record<string, QueryValue> = { state: params?.state, limit: params?.limit };
  return doRequest(ctx, { method: "GET", path: "/agent/attention-requests", query }).then(({ json }) => {
    if (!isRecord(json) || !Array.isArray(json["attention_requests"])) {
      throw invalidShape("GET /agent/attention-requests", 'expected {"attention_requests": [...]}');
    }
    return json["attention_requests"].map((a) => mapAttentionRequest(a, "GET /agent/attention-requests"));
  });
}

function getProjectSettings(ctx: ClientContext): Promise<ProjectSettings> {
  return doRequest(ctx, { method: "GET", path: "/agent/project-settings" }).then(({ json }) =>
    mapProjectSettings(json, "GET /agent/project-settings"),
  );
}

function putProjectSettings(
  ctx: ClientContext,
  params: PutProjectSettingsParams,
): Promise<ProjectSettings> {
  // Whole-object replace (go/agentdb/project_settings.go:136-160): every
  // field is written, so a caller must read-merge-write, not patch.
  const body = {
    base_image: params.baseImage,
    system_prompt: params.systemPrompt,
    mcp_config: params.mcpConfig,
    attention_channel: params.attentionChannel,
    max_concurrent_jobs: params.maxConcurrentJobs,
    daily_tokens_soft: params.dailyTokensSoft,
    daily_tokens_hard: params.dailyTokensHard,
    briefing_max_bytes: params.briefingMaxBytes,
    snapshot_ttl_days: params.snapshotTtlDays,
    rationale: params.rationale,
  };
  return doRequest(ctx, {
    method: "PUT",
    path: "/agent/project-settings",
    jsonBody: body,
  }).then(({ json }) => mapProjectSettings(json, "PUT /agent/project-settings"));
}

function createEmbedToken(
  ctx: ClientContext,
  session: string,
  ttlSeconds?: number,
): Promise<EmbedTokenResult> {
  const body: Record<string, unknown> = { session };
  if (ttlSeconds !== undefined) body.ttl_seconds = ttlSeconds;
  return doRequest(ctx, { method: "POST", path: "/agent/embed-token", jsonBody: body }).then(
    ({ json }) => {
      if (!isRecord(json)) throw invalidShape("POST /agent/embed-token", "expected an object");
      return { token: strField(json, "token"), expiresAtSec: toSec(numField(json, "expires_at")) };
    },
  );
}

function verifyGoogle(ctx: ClientContext, credential: string): Promise<VerifyGoogleResult> {
  return doRequest(ctx, {
    method: "POST",
    path: "/auth/verify-google",
    jsonBody: { credential },
    // Orange 404s this route when GOOGLE_CLIENT_ID is unset on Orange
    // itself — a configuration hole, not a rejected user (§ "One
    // documented exception to that table").
    errorOverride: (status, bodyText) => {
      if (status === 404) {
        return new WolfError(
          "misconfigured",
          "Orange: GOOGLE_CLIENT_ID is not set — /auth/verify-google is not mounted",
          { status, upstreamBody: bodyText, details: { variable: "GOOGLE_CLIENT_ID" } },
        );
      }
      return undefined;
    },
  }).then(({ json }) => {
    if (!isRecord(json)) throw invalidShape("POST /auth/verify-google", "expected an object");
    return { email: strField(json, "email"), emailVerified: boolField(json, "email_verified") };
  });
}

// ── Construction ───────────────────────────────────────────────────────

export function createOrangeClient(options: CreateOrangeClientOptions): OrangeClient {
  const ctx: ClientContext = {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    logger: options.logger ?? pino({ level: "silent" }),
  };

  return {
    createSession: (params) => createSession(ctx, params),
    getSessionByName: (name) => getSessionByName(ctx, name),
    deleteSession: (id) => deleteSession(ctx, id),
    listSessions: (params) => listSessions(ctx, params),

    appendMemory: (params) => appendMemory(ctx, params),
    listMemories: (params) => listMemories(ctx, params),
    getMemory: (id) => getMemory(ctx, id),
    getMemoryById: (id) => getMemory(ctx, id),
    getCurrentMemory: (name, kind) => getCurrentMemory(ctx, name, kind),

    listDatasets: (params) => listDatasets(ctx, params),
    getDataset: (name) => getDataset(ctx, name),
    downloadDataset: (name, params) => downloadDataset(ctx, name, params),

    putWorker: (name, params) => putWorker(ctx, name, params),
    deleteWorker: (name, params) => deleteWorker(ctx, name, params),

    createSchedule: (params) => createSchedule(ctx, params),
    listSchedules: () => listSchedules(ctx),
    deleteSchedule: (id, params) => deleteSchedule(ctx, id, params),

    listDeliveries: (params) => listDeliveries(ctx, params),
    listAttentionRequests: (params) => listAttentionRequests(ctx, params),

    getProjectSettings: () => getProjectSettings(ctx),
    putProjectSettings: (params) => putProjectSettings(ctx, params),

    createEmbedToken: (session, ttlSeconds) => createEmbedToken(ctx, session, ttlSeconds),
    verifyGoogle: (credential) => verifyGoogle(ctx, credential),
  };
}
