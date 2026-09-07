/**
 * The response guard: a provider that stops serving data must FAIL, not
 * parse.
 *
 * ── The defect this exists to prevent ───────────────────────────────────
 *
 * `stooq.ts` asked for CSV and got back an HTML page carrying a
 * client-side JavaScript proof-of-work challenge, with HTTP **200**. Every
 * status check passed, and `parseStooqCsv` then split that HTML on
 * newlines, skipped the first line as a "header", and split the rest on
 * commas.
 *
 * The page's inline `<script>` contains commas. So the parser read it as a
 * DATA ROW: column 0 became the timestamp, column 4 the value. Measured on
 * the recorded page (`__fixtures__/stooq-challenge-page.html`, and pinned
 * by `guard.test.ts`), `normalise` produced this:
 *
 *     timestamp,value
 *     (async()=>{const c="AAAAAGqe___IOLYlp2YVPrEyb…",e.encode(c+n))
 *
 * A structurally valid canonical CSV, one data row, `rows: 1`, a working
 * download URL, and a `dataset_put` that would have stored it as a real
 * versioned observation and reported success.
 *
 * So the failure mode was not "gold has no data today". It was **the whole
 * pipeline reporting success over a fragment of the challenge's own
 * JavaScript**. Nothing threw, nothing logged, and the only symptom a human
 * could see was a chart that made no sense.
 *
 * A provider that hands us something other than data is an outage, and it
 * has to be raised as one. That is all this module does — and it does it
 * BEFORE any parser sees the bytes, because a lenient parser turns a
 * challenge page into an empty series and there is no way to tell those
 * apart afterwards.
 *
 * ── Why every case is `unavailable` ────────────────────────────────────
 *
 * `unavailable` is the one RETRYABLE kind, and it is tempting to argue that
 * a permanent bot-wall (Stooq) should be non-retryable while a 429 should
 * not be. In one response you cannot tell "this provider has walled off
 * programmatic access for good" from "a CDN served an error page for ten
 * seconds" — both are an HTML body where data belonged. Claiming to know
 * which is a guess dressed as a classification, so both are `unavailable`
 * and the MESSAGE carries the distinction: it names the provider, what we
 * asked for, what came back, and a short excerpt. A human reading the same
 * message every day for a week is how permanence gets established.
 *
 * ── The one thing never to put in here ────────────────────────────────
 *
 * **No URLs.** FRED's request URL carries `api_key=<the real key>`, and a
 * download URL carries a signed token. `ResponseGuardContext` takes a
 * provider NAME for exactly this reason. Nothing in this file may accept,
 * log or echo a URL.
 */

import { WolfError } from "../errors.js";

/** What the caller asked the provider for. Shapes the message only. */
export type ExpectedBody = "csv" | "json";

export interface ResponseGuardContext {
  /** Provider name for the message, e.g. `"stooq"`. NEVER a URL — see the file header. */
  provider: string;
  /** The HTTP status, so a 429 reads as a rate limit rather than a mystery. */
  status: number;
  /** The response's `Content-Type`, or null when absent. */
  contentType?: string | null;
  /** What the caller expected back. */
  expected: ExpectedBody;
}

/** How much of an offending body is quoted in the error message. */
export const EXCERPT_CHARS = 160;

/** How much is retained on the error for a log to pick up. */
export const UPSTREAM_BODY_CHARS = 2_000;

/** How far into a body the HTML/challenge sniffers look. */
const SNIFF_CHARS = 4_000;

/**
 * Phrases seen on real interstitials. Kept separate from the generic
 * "it's HTML" test because a challenge page is routinely served with
 * HTTP 200 and `text/html`, which is precisely how Stooq's slipped past a
 * status check.
 */
const CHALLENGE_PHRASES: readonly RegExp[] = [
  /requires?\s+javascript/i,
  /enable\s+javascript/i,
  /verify\s+(your\s+)?browser/i,
  /just\s+a\s+moment/i,
  /cf-browser-verification/i,
  /attention\s+required/i,
  /checking\s+your\s+browser/i,
  /captcha/i,
  /ddos[- ]?guard/i,
];

const RATE_LIMIT_PHRASES: readonly RegExp[] = [/too\s+many\s+requests/i, /rate\s*limit/i];

/** Why a body was rejected. Exported so tests can assert the reason, not just that it threw. */
export type BodyProblemKind =
  | "rate_limited" // HTTP 429, or a body that says so
  | "challenge" // an interstitial demanding a real browser
  | "html" // an HTML page where data belonged
  | "empty" // nothing at all
  | "not_csv" // a body that is not the expected CSV
  | "not_json"; // a body that is not the expected JSON

export interface BodyProblem {
  kind: BodyProblemKind;
  /** Human-readable, no URL, safe to show a model and a user. */
  message: string;
}

/** Collapses whitespace and truncates, so a whole HTML page cannot land in a log line. */
export function excerpt(text: string, limit = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function looksLikeHtml(head: string, contentType: string | null | undefined): boolean {
  if (contentType && /^\s*text\/html\b/i.test(contentType)) return true;
  const trimmed = head.trimStart();
  if (trimmed.startsWith("<")) return true;
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<script[\s>]/i.test(head);
}

/**
 * Classifies a response body, or returns `null` when it is acceptable.
 *
 * Pure: no I/O, no clock, no throw. Exported so `guard.test.ts` can drive
 * every branch directly and so a new connector can reuse the judgement
 * without reusing the throw.
 */
export function classifyBody(text: string, ctx: ResponseGuardContext): BodyProblem | null {
  const head = text.slice(0, SNIFF_CHARS);
  const asked = ctx.expected === "csv" ? "CSV" : "JSON";

  // Rate limiting first: a 429's body is often HTML too, and "you are being
  // throttled" is far more actionable than "we got a web page".
  if (ctx.status === 429 || RATE_LIMIT_PHRASES.some((re) => re.test(head))) {
    return {
      kind: "rate_limited",
      message: `${ctx.provider} rate-limited this request (status ${ctx.status}); no ${asked} was returned`,
    };
  }

  if (text.trim().length === 0) {
    return {
      kind: "empty",
      message: `${ctx.provider} returned an empty body where ${asked} was expected (status ${ctx.status})`,
    };
  }

  const phrase = CHALLENGE_PHRASES.find((re) => re.test(head));
  if (phrase) {
    return {
      kind: "challenge",
      message:
        `${ctx.provider} returned a browser-verification page instead of ${asked} ` +
        `(status ${ctx.status}) — programmatic access appears to be blocked: ${excerpt(head)}`,
    };
  }

  if (looksLikeHtml(head, ctx.contentType)) {
    return {
      kind: "html",
      message:
        `${ctx.provider} returned an HTML page instead of ${asked} ` +
        `(status ${ctx.status}, content-type ${ctx.contentType ?? "absent"}): ${excerpt(head)}`,
    };
  }

  if (ctx.expected === "csv") {
    // A CSV's first non-empty line is a header of at least two fields. This
    // is what tells a real CSV from a plain-text error ("No data", "Invalid
    // symbol", a stack trace) that would otherwise be parsed into zero rows.
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    if (!firstLine.includes(",")) {
      return {
        kind: "not_csv",
        message:
          `${ctx.provider} returned a body whose first line is not a CSV header ` +
          `(status ${ctx.status}): ${excerpt(firstLine)}`,
      };
    }
  }

  return null;
}

/**
 * Turns a classification into the throw. Exported so a connector that needs
 * to classify and re-throw selectively (see `fred.ts`) raises the identical
 * error rather than assembling a near-copy of it.
 */
export function raiseBodyProblem(problem: BodyProblem, text: string): never {
  throw new WolfError("unavailable", problem.message, {
    details: { problem: problem.kind },
    upstreamBody: text.slice(0, UPSTREAM_BODY_CHARS),
  });
}


/**
 * Guards a body the caller is about to parse as CSV. Returns the text
 * unchanged when it is acceptable; throws `unavailable` otherwise.
 *
 * Call this BEFORE the parser, never after — see the file header.
 */
export function guardCsvBody(text: string, ctx: Omit<ResponseGuardContext, "expected">): string {
  const problem = classifyBody(text, { ...ctx, expected: "csv" });
  if (problem) raiseBodyProblem(problem, text);
  return text;
}

/**
 * Guards and parses a body the caller expects to be JSON. A parse failure
 * is `unavailable` with a message naming the provider — NOT
 * `WolfError.internal`, whose message is replaced by the fixed string
 * "internal error" and which claims the bug is ours. A provider serving
 * non-JSON is the provider's outage, and the operator needs to be able to
 * read that off the error.
 */
export function guardJsonBody<T>(text: string, ctx: Omit<ResponseGuardContext, "expected">): T {
  const full: ResponseGuardContext = { ...ctx, expected: "json" };
  const problem = classifyBody(text, full);
  if (problem) raiseBodyProblem(problem, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    raiseBodyProblem(
      {
        kind: "not_json",
        message:
          `${ctx.provider} returned a body that is not JSON ` +
          `(status ${ctx.status}, content-type ${ctx.contentType ?? "absent"}): ${excerpt(text)}`,
      },
      text,
    );
  }
}
