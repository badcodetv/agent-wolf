/**
 * Shared error taxonomy for Agent Wolf. Every route handler, client and
 * background job throws (or returns) a `WolfError`, never a bare `Error`.
 *
 * See design/2026-08-20-agent-wolf.md § "Shared error taxonomy" (agent-orange
 * repo) — this file is the canonical implementation named there; do not
 * invent a second taxonomy elsewhere in this codebase.
 */

/** The six error kinds every Wolf error is classified as. */
export type WolfErrorKind =
  | "not_found" // the thing does not exist
  | "unavailable" // an upstream is down or timed out — RETRYABLE
  | "invalid" // caller error; carries field-level details
  | "conflict" // CAS or state-machine rejection
  | "forbidden" // authenticated but not allowed
  | "misconfigured"; // an env var or an Orange-side setting is wrong; names the variable

/** Default HTTP status per kind, used when the caller does not override it. */
const DEFAULT_STATUS: Record<WolfErrorKind, number> = {
  not_found: 404,
  unavailable: 503,
  invalid: 400,
  conflict: 409,
  forbidden: 403,
  misconfigured: 500,
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
}
