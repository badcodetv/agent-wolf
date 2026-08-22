/**
 * The ONE canonical-dataset-CSV parser in the tree.
 *
 * design/2026-08-20-agent-wolf.md § "The canonical dataset CSV" (agent-orange
 * repo) pins the format, and W10's scope pins the reason there is exactly one
 * parser: two tickets read dataset bytes (this poller and W11's series proxy),
 * and a second copy is how the two silently disagree about what a legitimate
 * file contains.
 *
 * ```
 * timestamp,value
 * 2026-08-19T00:00:00Z,141.22
 * 2026-08-20T00:00:00Z,143.90
 * ```
 *
 * Header **exactly** `timestamp,value`. RFC3339 in **UTC**, ascending and
 * strictly increasing, `LF` line endings, one metric per file, a single
 * terminating LF and no blank line after it — which is byte-for-byte what
 * `marketdata/normalise.ts`'s `normalise()` emits, the only writer in this
 * codebase.
 *
 * ## Why every rejection is loud, and enumerated
 *
 * The whole reason the format is pinned is that a `t,value` header otherwise
 * makes this parser read **zero observations from a legitimately written
 * dataset with no error anywhere**: the poller then evaluates every condition
 * as `no_observations`, the board shows a support score of 0, and nothing in
 * the system is wrong enough to complain. So each of the six graded
 * rejections below is a typed `invalid` `WolfError` that NAMES THE OFFENDING
 * LINE NUMBER (1-based, the header being line 1):
 *
 *   1. a header that is not byte-for-byte `timestamp,value`;
 *   2. a `\r` anywhere (CRLF endings) — `Number("1.5\r")` is `1.5`, so a CRLF
 *      file would otherwise parse silently and only its timestamps would
 *      break, which is a worse failure than rejecting it;
 *   3. a row whose column count is not 2 (a trailing blank line lands here);
 *   4. a timestamp that is not RFC3339 or not UTC;
 *   5. a `value` that is empty or not finite;
 *   6. a timestamp that is not strictly greater than its predecessor.
 *
 * A **header-only file is zero observations, not an error** — that is the
 * state of every dataset on the day its hypothesis goes live.
 */

import { WolfError } from "../errors.js";
import type { Point, UnixMs } from "./evaluate.js";

/** The header line, byte-for-byte. Nothing else is accepted. */
export const CANONICAL_CSV_HEADER = "timestamp,value";

/**
 * RFC3339 in UTC, and only UTC: an offset (`+01:00`) or a local timestamp is
 * a different instant, and a series that mixes the two is silently wrong
 * rather than loudly broken. Fractional seconds are allowed because a
 * connector may emit them; `normalise()` passes any non-date-only timestamp
 * through unchanged, so this parser must accept what that writer can emit.
 * The `T` and the `Z` are required in upper case — RFC3339 permits the lower
 * case forms, and accepting them here would let two spellings of the same
 * instant into a format whose whole job is to be byte-stable.
 */
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

/**
 * A plain decimal, optionally signed, optionally in exponent form. Deliberately
 * NOT `Number(raw)` alone: `Number("")` is `0`, `Number(" 1 ")` is `1` and
 * `Number("1.5\r")` is `1.5`, so three different kinds of malformed row would
 * parse as a real observation.
 */
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Parses one RFC3339 UTC timestamp to unix **milliseconds**, or returns null
 * if it is not one.
 *
 * The component round-trip is what rejects `2026-02-30T00:00:00Z`: `Date.UTC`
 * happily rolls that over to 2 March, so comparing the reconstructed date's
 * own components back against the ones the string carried is the only way to
 * tell a real calendar date from a rolled-over one.
 */
export function parseRfc3339Utc(raw: string): UnixMs | null {
  const m = RFC3339_UTC.exec(raw);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  // Fractional seconds are accepted and TRUNCATED to whole milliseconds; the
  // series this feeds is daily, and `Point.tMs` is an integer count of them.
  const fractionMs = frac === undefined ? 0 : Math.floor(Number(frac) * 1000);
  return ms + fractionMs;
}

/**
 * The canonical dataset CSV → `Point[]`, ascending, or a typed `invalid`
 * `WolfError` naming the offending line.
 *
 * `where` is folded into every message (the dataset name, normally), because
 * "canonical CSV line 4" on its own does not say which of a hypothesis's four
 * datasets is broken.
 */
export function parseCanonicalCsv(text: string, where?: string): Point[] {
  const prefix = where === undefined || where === "" ? "" : `${where}: `;
  const dataset = where === undefined || where === "" ? {} : { dataset: where };

  /**
   * Declared as a `function` with an explicit `never` return type, not as a
   * `const` arrow: only the former participates in TypeScript's control-flow
   * analysis, which is what lets the callers below narrow `string | undefined`
   * and `number | null` without a cast.
   */
  function fail(line: number, message: string, extra: Record<string, unknown> = {}): never {
    throw new WolfError("invalid", `${prefix}canonical CSV line ${line}: ${message}`, {
      details: { line, ...extra, ...dataset },
    });
  }

  if (text.includes("\r")) {
    const line = text.slice(0, text.indexOf("\r")).split("\n").length;
    fail(line, "CR found — the canonical dataset CSV uses LF line endings only");
  }

  // The canonical form ends in a SINGLE terminating LF (normalise() emits one);
  // anything beyond that is a blank line, which falls through to the
  // column-count rule below and is reported as such.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");

  const header = lines[0] ?? "";
  if (header !== CANONICAL_CSV_HEADER) {
    fail(
      1,
      `header must be exactly ${JSON.stringify(CANONICAL_CSV_HEADER)}, got ${JSON.stringify(header)}`,
      { header },
    );
  }

  const points: Point[] = [];
  let previousMs: number | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    const columns = raw.split(",");
    if (columns.length !== 2) {
      fail(lineNumber, `expected 2 columns, got ${columns.length}`, { columns: columns.length });
    }
    const timestamp = columns[0] ?? "";
    const value = columns[1] ?? "";

    const tMs = parseRfc3339Utc(timestamp);
    if (tMs === null) {
      fail(lineNumber, `timestamp ${JSON.stringify(timestamp)} is not RFC3339 UTC`, { timestamp });
    }
    if (value === "") fail(lineNumber, "value is empty");
    const v = Number(value);
    if (!NUMERIC.test(value) || !Number.isFinite(v)) {
      fail(lineNumber, `value ${JSON.stringify(value)} is not a finite number`, { value });
    }
    if (previousMs !== null && tMs <= previousMs) {
      fail(
        lineNumber,
        `timestamp ${JSON.stringify(timestamp)} is not strictly greater than the previous row's`,
        { timestamp },
      );
    }
    previousMs = tMs;
    points.push({ tMs, v });
  }
  return points;
}

/** The bytes an Orange dataset download returns → `Point[]`. UTF-8, always. */
export function parseCanonicalCsvBytes(bytes: ArrayBuffer, where?: string): Point[] {
  return parseCanonicalCsv(new TextDecoder("utf-8").decode(bytes), where);
}
