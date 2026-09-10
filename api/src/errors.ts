/**
 * Shared error taxonomy for Agent Wolf. Every route handler, client and
 * background job throws (or returns) a `WolfError`, never a bare `Error`.
 *
 * See design/2026-08-20-agent-wolf.md § "Shared error taxonomy" (agent-bob
 * repo) — this file is the canonical implementation named there; do not
 * invent a second taxonomy elsewhere in this codebase.
 */

/**
 * The seven error kinds every Wolf error is classified as. `internal` was
 * added by owner decision 2026-08-21 (R39): an unhandled throw must never
 * be classified as `unavailable`, the one RETRYABLE kind — W10's poller
 * treats `unavailable` as "skip this tick without penalty", so mapping a
 * genuine server bug to it would make the poller retry a crashing endpoint
 * forever instead of surfacing the bug.
 */
export type WolfErrorKind =
  | "not_found" // the thing does not exist
  | "unavailable" // an upstream is down or timed out — RETRYABLE
  | "invalid" // caller error; carries field-level details
  | "conflict" // CAS or state-machine rejection
  | "forbidden" // authenticated but not allowed
  | "misconfigured" // an env var or an Orange-side setting is wrong; names the variable
  | "internal"; // WE have a bug — an unhandled throw. NOT retryable. Message never echoed to the client.

/** Default HTTP status per kind, used when the caller does not override it. */
const DEFAULT_STATUS: Record<WolfErrorKind, number> = {
  not_found: 404,
  unavailable: 503,
  invalid: 400,
  conflict: 409,
  forbidden: 403,
  misconfigured: 500,
  internal: 500,
};

export interface WolfErrorOptions {
  /** Overrides the kind's default HTTP status. */
  status?: number;
  /** Field-level detail (e.g. `{ variable: "WOLF_API_KEY" }`, a zod issue list). */
  details?: unknown;
  /** The verbatim body of an upstream (Orange) error response, if any. */
  upstreamBody?: string;
  /** The underlying cause, if this error wraps another. */
  cause?: unknown;
}

export class WolfError extends Error {
  readonly kind: WolfErrorKind;
  readonly status: number;
  readonly details?: unknown;
  readonly upstreamBody?: string;

  constructor(kind: WolfErrorKind, message: string, options: WolfErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WolfError";
    this.kind = kind;
    this.status = options.status ?? DEFAULT_STATUS[kind];
    this.details = options.details;
    this.upstreamBody = options.upstreamBody;
    Object.setPrototypeOf(this, WolfError.prototype);
  }

  /**
   * A `misconfigured` error naming the offending environment/config
   * variable. Never pass the variable's *value* here — only its name.
   */
  static misconfigured(variableName: string, message?: string): WolfError {
    return new WolfError(
      "misconfigured",
      message ?? `missing or invalid configuration: ${variableName}`,
      { details: { variable: variableName } },
    );
  }

  /**
   * Wraps an unrecognised throw as `internal`. The message is always the
   * fixed string below — never the original error's message — because that
   * message may contain a stack trace, a file path or a credential and must
   * not reach a response body (R39). The real error is kept as `cause` so
   * the caller can log it server-side (e.g. `logger.error({ err: cause }, ...)`),
   * and, where a correlation id exists, callers should attach it via
   * `details` rather than folding it into the message.
   */
  static internal(cause: unknown): WolfError {
    return new WolfError("internal", "internal error", { cause });
  }
}
