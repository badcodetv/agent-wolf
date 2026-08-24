/**
 * The browser's single door to `wolf-api`. Every path is RELATIVE and starts
 * with the literal `/api` — nginx (prod) and the vite dev proxy both forward
 * that prefix unrewritten, so the browser never learns wolf-api's address and
 * there is no second origin to configure.
 *
 * Two rules this file exists to keep in one place:
 *
 *  1. **A server error's `message` is surfaced VERBATIM.** "host port pool is
 *     exhausted" is operational and actionable, and flattening it into "could
 *     not create" throws away the only useful part (plan § "Shared error
 *     taxonomy"). `ApiError.message` is the server's own sentence.
 *  2. **Nothing here logs.** An embed token and a `download_url` are
 *     credentials; a `console.log` of a failed response body is how one
 *     reaches a browser extension or a screenshot.
 */

import type {
  BoardRow,
  EmbedTokenResponse,
  HypothesisDetail,
  SignedInUser,
} from "./types.js";

/** The `hyp-` prefix, written down exactly ONCE in `web/`. */
const SESSION_NAME_PREFIX = "hyp-";

/**
 * `hyp-<id>` from a BARE 8-hex id. § Vocabulary: the id is never prefixed and
 * the prefix belongs to the session name and to nothing else — doubling it
 * produces `hyp-hyp-…`, under which the trust rule's session clause never
 * matches and every hypothesis reads as untrusted.
 */
export function sessionNameForHypothesis(id: string): string {
  return `${SESSION_NAME_PREFIX}${id}`;
}

/** The taxonomy kinds `api/src/errors.ts` defines, plus the browser-side transport failure. */
export type ApiErrorKind =
  | "not_found"
  | "unavailable"
  | "invalid"
  | "conflict"
  | "forbidden"
  | "misconfigured"
  | "internal"
  /** The request never got an answer (offline, DNS, CORS). Not a server kind. */
  | "network";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly details?: unknown;

  constructor(kind: ApiErrorKind, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** True for the one case a caller renders as "sign in", not as a failure. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

interface WireError {
  kind?: unknown;
  message?: unknown;
  details?: unknown;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "not_found",
  "unavailable",
  "invalid",
  "conflict",
  "forbidden",
  "misconfigured",
  "internal",
]);

async function toApiError(response: Response): Promise<ApiError> {
  let body: WireError | undefined;
  try {
    body = (await response.json()) as WireError;
  } catch {
    // A non-JSON body is expected on the paths Express answers itself — a
    // route that is not mounted (`/api/auth/dev-login` without
    // WOLF_TEST_LOGIN) gets Express's own HTML 404, not the taxonomy shape.
    body = undefined;
  }
  const message =
    typeof body?.message === "string" && body.message.trim() !== ""
      ? body.message
      : `${response.status} ${response.statusText}`.trim();
  const kind =
    typeof body?.kind === "string" && KNOWN_KINDS.has(body.kind)
      ? (body.kind as ApiErrorKind)
      : "internal";
  return new ApiError(kind, message, response.status, body?.details);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      // Wolf's session is a signed HttpOnly cookie on this same origin;
      // "same-origin" is fetch's default for credentials, stated here so a
      // future absolute URL does not silently drop it.
      credentials: "same-origin",
      ...init,
    });
  } catch (cause) {
    throw new ApiError("network", "could not reach the Agent Wolf API", 0, { cause: String(cause) });
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ── Auth ────────────────────────────────────────────────────────────────

/** `GET /api/auth/me` — 200 `{ email }`, or 401 when there is no usable cookie. */
export function fetchMe(): Promise<SignedInUser> {
  return getJson<SignedInUser>("/api/auth/me");
}

/** `POST /api/auth/google` — the Google Identity Services credential. */
export function signInWithGoogle(credential: string): Promise<SignedInUser> {
  return postJson<SignedInUser>("/api/auth/google", { credential });
}

/**
 * `POST /api/auth/dev-login` — mounted ONLY when `WOLF_TEST_LOGIN` is set on
 * the API, so a 404 here means "this stack has no offline login", not "wrong
 * password". Express answers that 404 itself, with an HTML body.
 */
export function devLogin(email: string, password: string): Promise<SignedInUser> {
  return postJson<SignedInUser>("/api/auth/dev-login", { email, password });
}

/** `POST /api/auth/logout` — 204 always, even with no cookie. POST, never GET. */
export function logout(): Promise<void> {
  return postJson<void>("/api/auth/logout");
}

// ── Hypotheses ──────────────────────────────────────────────────────────

/**
 * `GET /api/hypotheses` — the WHOLE board in ONE request, tiers included.
 * There is deliberately no per-row follow-up: the tiers, the counts and the
 * headline are all computed server-side.
 */
export function fetchBoard(): Promise<BoardRow[]> {
  return getJson<BoardRow[]>("/api/hypotheses");
}

/** `POST /api/hypotheses` — `{ title }`, 201 `{ id }`. */
export function createHypothesis(title: string, thesis?: string): Promise<{ id: string }> {
  return postJson<{ id: string }>("/api/hypotheses", {
    title,
    ...(thesis !== undefined && thesis.trim() !== "" ? { thesis } : {}),
  });
}

/** `GET /api/hypotheses/:id`. */
export function fetchHypothesis(id: string): Promise<HypothesisDetail> {
  return getJson<HypothesisDetail>(`/api/hypotheses/${encodeURIComponent(id)}`);
}

/** `POST /api/hypotheses/:id/go-live` — takes NO body: the spec it locks is the newest candidate memory. */
export function goLive(id: string): Promise<unknown> {
  return postJson<unknown>(`/api/hypotheses/${encodeURIComponent(id)}/go-live`);
}

/**
 * `GET /api/hypotheses/:id/embed-token` — `{ token, expires_at_sec, embed_url }`.
 *
 * ⚠️ `expires_at_sec` is unix **SECONDS**. Multiply before comparing with
 * `Date.now()`; see `components/OrangeChatFrame.tsx`.
 */
export function fetchEmbedToken(id: string): Promise<EmbedTokenResponse> {
  return getJson<EmbedTokenResponse>(`/api/hypotheses/${encodeURIComponent(id)}/embed-token`);
}
