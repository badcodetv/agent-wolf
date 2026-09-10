/**
 * Wire types for every Orange route `api/src/bob/client.ts` calls.
 *
 * design/2026-08-20-agent-wolf.md § "Environment facts you must not
 * rediscover the hard way": "Timestamp units differ across the product
 * surface and this is deliberate ... Do not unify them. Encode the unit
 * in every type you write." That is what the two branded types below are
 * for — a plain `number` cannot express the difference and a field
 * *name* alone creates no compile-time check, only a convention someone
 * can forget.
 *
 * Every field this module exposes is camelCase, regardless of the
 * casing Orange's JSON uses on the wire (`created_by_worker`,
 * `size_bytes`, …) — `client.ts` is what translates between the two.
 * This mirrors the rest of this package (`WolfConfig`, `Logger`, …) and
 * is what lets `createAtMs` / `createdByWorker` / `retractedBy` read the
 * same way whether they came off a memory row or a dataset row. See the
 * ticket's "guesses" note on this file for the one place the plan itself
 * is ambiguous about casing (dataset fields).
 */

// ── Branded unix-time units ─────────────────────────────────────────────
//
// Pinned verbatim by the ticket (so the brand proof below can delete this
// exact suffix and watch `yarn typecheck` fail): a field *name* creates no
// TypeScript incompatibility, so only an intersection with a nominal-ish
// object type stops a `UnixSec` compiling where a `UnixMs` is expected.

/** A unix timestamp in **milliseconds** — memories, datasets, evaluations. */
export type UnixMs = number & { readonly __unit: "ms" };

/** A unix timestamp in **seconds** — Orange sessions, embed-token expiry, `agent_*` tables. */
export type UnixSec = number & { readonly __unit: "s" };

/** The only sanctioned way to produce a `UnixMs` from a plain number. */
export function toMs(n: number): UnixMs {
  return n as UnixMs;
}

/** The only sanctioned way to produce a `UnixSec` from a plain number. */
export function toSec(n: number): UnixSec {
  return n as UnixSec;
}

// ── Sessions ─────────────────────────────────────────────────────────────

export interface CreateSessionResult {
  id: string;
  status: string;
  workflowId: string;
}

export interface SessionByName {
  id: string;
  name: string;
  customer: string;
  job?: string;
  persona?: string;
  title?: string;
  status: string;
  /** Present only when `status === "error"`; the diagnostic verbatim. */
  createError?: string;
  createdAtSec: UnixSec;
  updatedAtSec: UnixSec;
}

/** One row of `GET /agent/sessions` (a bare array on the wire, per `writeJSON(w, sessions)`). */
export interface SessionListRow {
  id: string;
  name?: string;
  worker?: string;
  status: string;
  createdAtSec: UnixSec;
  updatedAtSec: UnixSec;
}

// ── Memories ─────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  labels: Record<string, string>;
  content: string;
  createdByWorker: string;
  createdBySession: string;
  createdAtMs: UnixMs;
}

export interface MemoryRetraction {
  memoryId: string;
  createdByWorker: string;
  createdBySession: string;
  createdAtMs: UnixMs;
}

/** One row of `GET /agent/memories` — a snippet, never full `content` (§ "Snippet reads and full-content reads are different types"). */
export interface MemorySearchResultRow {
  id: string;
  labels: Record<string, string>;
  snippet: string;
  score: number;
  createdByWorker: string;
  createdBySession: string;
  createdAtMs: UnixMs;
  /** Every retraction of this row, newest first (O11, owner decision B5). Absent when not retracted. */
  retractedBy?: MemoryRetraction[];
}

// ── Datasets ─────────────────────────────────────────────────────────────
//
// Field SET is pinned field-for-field against § "Dataset metadata JSON":
// id, name, version, labels, size_bytes, row_count, sha256, content_type,
// created_by_worker, created_by_session, created_at — with `blob_path` and
// `project` never present. Casing follows this module's camelCase rule
// (see the file header); `client.ts` translates the wire names.

export interface DatasetMetadata {
  id: string;
  name: string;
  version: number;
  labels: Record<string, string>;
  sizeBytes: number;
  rowCount: number;
  sha256: string;
  contentType: string;
  createdByWorker: string;
  createdBySession: string;
  createdAtMs: UnixMs;
}

export interface DatasetDownload {
  contentType: string;
  body: ArrayBuffer;
}

// ── Workers ──────────────────────────────────────────────────────────────

export interface PutWorkerParams {
  description?: string;
  systemPrompt?: string;
  mcpConfig?: Record<string, unknown>;
  image?: string;
  maxInstances?: number;
  briefing?: string[];
  enabled?: boolean;
  frozen?: boolean;
  rationale?: string;
}

export interface WorkerRecord {
  project: string;
  name: string;
  description: string;
  systemPrompt: string;
  mcpConfig: Record<string, unknown>;
  image: string;
  briefing?: string[];
  maxInstances: number;
  enabled: boolean;
  frozen: boolean;
  createdAtSec: UnixSec;
  updatedAtSec: UnixSec;
}

// ── Schedules ────────────────────────────────────────────────────────────

export interface CreateScheduleParams {
  worker?: string;
  targetSession?: string;
  cron: string;
  input?: string;
  enabled?: boolean;
  rationale?: string;
}

export interface ScheduleRecord {
  id: string;
  project: string;
  worker: string;
  targetSession?: string;
  cron: string;
  input: string;
  enabled: boolean;
  createdAtSec?: UnixSec;
  updatedAtSec?: UnixSec;
}

// ── Deliveries ───────────────────────────────────────────────────────────

export interface ListDeliveriesParams {
  eventId?: string;
  subscriptionId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface DeliveryRecord {
  id: string;
  project: string;
  eventId: string;
  subscriptionId: string;
  sessionId: string;
  worker: string;
  scheduleId: string;
  status: string;
  failureReason: string;
  startedAtSec: UnixSec;
  endedAtSec: UnixSec;
  createdAtSec: UnixSec;
  updatedAtSec: UnixSec;
}

// ── Attention requests ───────────────────────────────────────────────────

export interface ListAttentionRequestsParams {
  state?: "open" | "all";
  limit?: number;
}

export interface AttentionRequestRecord {
  id: string;
  sessionId: string;
  worker: string;
  message: string;
  createdAtSec: UnixSec;
  expiresAtSec: UnixSec;
  answeredAtSec: UnixSec;
  timedOutAtSec: UnixSec;
}

// ── Project settings ─────────────────────────────────────────────────────

export interface ProjectSettings {
  project: string;
  baseImage: string;
  systemPrompt: string;
  mcpConfig: Record<string, unknown>;
  attentionChannel: Record<string, unknown>;
  maxConcurrentJobs: number;
  dailyTokensSoft: number;
  dailyTokensHard: number;
  briefingMaxBytes: number;
  snapshotTtlDays: number;
  updatedAtSec: UnixSec;
}

/** The whole-object PUT body (no patch semantics — `go/agentdb/project_settings.go:136-160`). */
export type PutProjectSettingsParams = Omit<ProjectSettings, "project" | "updatedAtSec"> & {
  rationale?: string;
};

// ── Embed token / auth ───────────────────────────────────────────────────

export interface EmbedTokenResult {
  token: string;
  expiresAtSec: UnixSec;
}

export interface VerifyGoogleResult {
  email: string;
  emailVerified: boolean;
}

// ── Artifacts (W29) ──────────────────────────────────────────────────────

/**
 * One row of `GET /agent/sessions/by-name/{name}/artifacts` — the individual,
 * user-facing files a session's container produced (`go/artifacts/artifacts.go`'s
 * `Artifact`). Distinct from a snapshot: an artifact is one file, a snapshot is
 * a whole filesystem.
 *
 * ⚠️ **This is the one Orange route whose wire is already camelCase.** The
 * memories, datasets, workers and schedules routes all send snake_case
 * (`created_by_worker`, `size_bytes`, …) and `client.ts` translates; the Go
 * `Artifact` struct is tagged `filePath` / `mimeType` / `fileSize` / `isDir`
 * and needs none. Do not "fix" the mapper to read snake_case keys — it would
 * silently map every field to its zero value, which `strField`/`numField` make
 * indistinguishable from an empty artifact.
 *
 * `fileSize` is renamed `fileSizeBytes` here on the house rule that a unit
 * belongs in the type, and `blobPath` and `meta` are deliberately NOT mapped:
 * the blob path is the STORE's object key and nothing above this layer has any
 * business with it.
 */
export interface ArtifactRecord {
  id: string;
  /** Orange's session uuid. Kept here and dropped at Wolf's own route — the browser addresses a session by NAME. */
  sessionId: string;
  /** The dedup key, with `sessionId`. Spelt with or without a leading slash depending on who wrote it. */
  filePath: string;
  /** `"file" | "code" | "image" | "data" | "webapp"`, and extensible — kept as a string on purpose. */
  artifactType: string;
  /** `"live" | "extracted" | "lost" | "extraction_failed"`. A string, so a fifth value Orange adds does not become a parse failure here. */
  status: string;
  label: string;
  description: string;
  mimeType: string;
  /** `fileSize` on the wire. Bytes. */
  fileSizeBytes: number;
  /** `"tool" | "auto" | "upload"` — write-once in Orange. */
  source: string;
  /** When true, the bytes are one blob per file under a PREFIX; the file route serves nothing for it. */
  isDir: boolean;
}

/** The bytes of one artifact — `GET /agent/sessions/by-name/{name}/artifacts/file?path=…`. */
export interface ArtifactFile {
  contentType: string;
  body: ArrayBuffer;
}
