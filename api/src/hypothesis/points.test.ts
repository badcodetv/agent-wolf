import { describe, expect, it } from "vitest";

import { WolfError } from "../errors.js";
import { normalise } from "../marketdata/normalise.js";
import {
  CANONICAL_CSV_HEADER,
  parseCanonicalCsv,
  parseCanonicalCsvBytes,
  parseRfc3339Utc,
} from "./points.js";

// design/2026-08-20-agent-wolf.md, W10: "`parseCanonicalCsv(text) -> Point[]`
// in api/src/hypothesis/points.ts is the ONE parser". Test names are prefixed
// `points_`.

const CANONICAL = "timestamp,value\n2026-08-19T00:00:00Z,141.22\n2026-08-20T00:00:00Z,143.90\n";

/** The two literals § "The canonical dataset CSV" prints, and their epochs. */
const T_19 = 1_787_097_600_000;
const T_20 = 1_787_184_000_000;

function invalidError(fn: () => unknown): WolfError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WolfError);
    return err as WolfError;
  }
  throw new Error("expected parseCanonicalCsv to throw");
}

describe("points_happy_path", () => {
  it("points_happy_path: the § worked example parses to two ascending points", () => {
    expect(parseCanonicalCsv(CANONICAL)).toEqual([
      { tMs: T_19, v: 141.22 },
      { tMs: T_20, v: 143.9 },
    ]);
  });

  it("points_happy_path: a known row round-trips to the expected INTEGER unix ms", () => {
    // W10: "`tMs` is the RFC3339 timestamp parsed to unix MILLISECONDS,
    // matching W4's liveAtMs/nowMs". A seconds/milliseconds slip here makes
    // every window in the evaluator 1000× too narrow and no other test sees it.
    const [first] = parseCanonicalCsv("timestamp,value\n2026-08-20T00:00:00Z,1\n");
    expect(first?.tMs).toBe(1_787_184_000_000);
    expect(Number.isInteger(first?.tMs)).toBe(true);
    expect(new Date(first?.tMs ?? 0).toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("points_happy_path: a header-only file is ZERO observations, not an error", () => {
    // The state of every dataset on the day its hypothesis goes live.
    expect(parseCanonicalCsv(`${CANONICAL_CSV_HEADER}\n`)).toEqual([]);
    expect(parseCanonicalCsv(CANONICAL_CSV_HEADER)).toEqual([]);
  });

  it("points_happy_path: the terminating LF is optional, exactly one is consumed", () => {
    expect(parseCanonicalCsv("timestamp,value\n2026-08-19T00:00:00Z,141.22")).toEqual([
      { tMs: T_19, v: 141.22 },
    ]);
  });

  it("points_happy_path: negative, exponent and integer values are all finite numbers", () => {
    const csv = [
      "timestamp,value",
      "2026-08-19T00:00:00Z,-0.42",
      "2026-08-20T00:00:00Z,1e3",
      "2026-08-21T00:00:00Z,7",
      "",
    ].join("\n");
    expect(parseCanonicalCsv(csv).map((p) => p.v)).toEqual([-0.42, 1000, 7]);
  });

  it("points_happy_path: fractional seconds are accepted and truncated to whole ms", () => {
    const [only] = parseCanonicalCsv("timestamp,value\n2026-08-20T00:00:00.250Z,1\n");
    expect(only?.tMs).toBe(T_20 + 250);
  });

  it("points_happy_path: parses the bytes an Bob download returns", () => {
    const bytes = new TextEncoder().encode(CANONICAL);
    // A copy into a fresh ArrayBuffer: TextEncoder may hand back a view over a
    // larger pool, and the client's `body` is always a whole ArrayBuffer.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(parseCanonicalCsvBytes(buffer as ArrayBuffer)).toHaveLength(2);
  });
});

describe("points_writer_agreement", () => {
  it("points_writer_agreement: normalise()'s own output parses — one format, two modules", () => {
    // marketdata/normalise.ts is the ONLY writer of this format in the tree
    // and this parser is the only reader. If they ever disagree about the
    // terminating LF or the timestamp spelling, the poller reads zero
    // observations from a legitimately written dataset — the exact silent
    // failure the format is pinned to prevent. So the two are tested against
    // each other rather than each against its own idea of the format.
    const csv = normalise([
      { timestamp: "2026-08-19", value: "141.22" },
      { timestamp: "2026-08-20", value: "143.90" },
    ]);
    expect(csv.startsWith(`${CANONICAL_CSV_HEADER}\n`)).toBe(true);
    expect(parseCanonicalCsv(csv)).toEqual([
      { tMs: T_19, v: 141.22 },
      { tMs: T_20, v: 143.9 },
    ]);
  });
});

describe("points_rejections", () => {
  it("points_rejections: a header that is not byte-for-byte `timestamp,value` fails LOUDLY at line 1", () => {
    // The whole reason the format is pinned: `t,value` otherwise makes the
    // poller read zero observations from a legitimate dataset, with no error
    // anywhere and a support score of 0 on the board.
    for (const header of ["t,value", "timestamp, value", "Timestamp,value", "value,timestamp", ""]) {
      const err = invalidError(() => parseCanonicalCsv(`${header}\n2026-08-19T00:00:00Z,1\n`));
      expect(err.kind).toBe("invalid");
      expect(err.message).toContain("line 1");
      expect(err.message).toContain("timestamp,value");
      expect((err.details as { line: number }).line).toBe(1);
    }
  });

  it("points_rejections: an entirely empty file is a header error, not zero observations", () => {
    expect(invalidError(() => parseCanonicalCsv("")).kind).toBe("invalid");
  });

  it("points_rejections: a row whose column count is not 2 names its line", () => {
    const oneColumn = invalidError(() =>
      parseCanonicalCsv("timestamp,value\n2026-08-19T00:00:00Z,1\nbroken\n"),
    );
    expect((oneColumn.details as { line: number }).line).toBe(3);
    expect(oneColumn.message).toContain("expected 2 columns, got 1");

    const threeColumns = invalidError(() =>
      parseCanonicalCsv("timestamp,value\n2026-08-19T00:00:00Z,1,extra\n"),
    );
    expect((threeColumns.details as { line: number }).line).toBe(2);
    expect(threeColumns.message).toContain("got 3");
  });

  it("points_rejections: a trailing BLANK line is a column-count rejection, naming it", () => {
    const err = invalidError(() => parseCanonicalCsv("timestamp,value\n2026-08-19T00:00:00Z,1\n\n"));
    expect((err.details as { line: number }).line).toBe(3);
  });

  it("points_rejections: a timestamp that is not RFC3339, or not UTC, names its line", () => {
    const cases: [string, number][] = [
      ["2026-08-19", 2],
      ["2026-08-19 00:00:00Z", 2],
      ["2026-08-19T00:00:00+01:00", 2],
      ["2026-08-19T00:00:00", 2],
      ["2026-08-19t00:00:00z", 2],
      ["2026-02-30T00:00:00Z", 2],
      ["2026-13-01T00:00:00Z", 2],
      ["not-a-time", 2],
    ];
    for (const [timestamp, line] of cases) {
      const err = invalidError(() => parseCanonicalCsv(`timestamp,value\n${timestamp},1\n`));
      expect(err.kind).toBe("invalid");
      expect((err.details as { line: number }).line).toBe(line);
      expect(err.message).toContain("RFC3339 UTC");
    }
  });

  it("points_rejections: an empty or non-finite value names its line", () => {
    for (const value of ["", "abc", "NaN", "Infinity", "1.2.3", " 1", "1_000", "--1"]) {
      const err = invalidError(() =>
        parseCanonicalCsv(`timestamp,value\n2026-08-19T00:00:00Z,${value}\n`),
      );
      expect(err.kind).toBe("invalid");
      expect((err.details as { line: number }).line).toBe(2);
    }
  });

  it("points_rejections: `Number()`'s three silent coercions are all rejected", () => {
    // Number("") === 0, Number(" 1 ") === 1 and Number("1.5\r") === 1.5, so a
    // parser that trusted Number() alone would turn three malformed rows into
    // real observations.
    expect(Number("")).toBe(0);
    expect(Number(" 1 ")).toBe(1);
    expect(Number("1.5\r")).toBe(1.5);
    for (const csv of [
      "timestamp,value\n2026-08-19T00:00:00Z,\n",
      "timestamp,value\n2026-08-19T00:00:00Z, 1 \n",
      "timestamp,value\r\n2026-08-19T00:00:00Z,1.5\r\n",
    ]) {
      expect(invalidError(() => parseCanonicalCsv(csv)).kind).toBe("invalid");
    }
  });

  it("points_rejections: CRLF line endings are rejected, naming the line the CR is on", () => {
    const err = invalidError(() =>
      parseCanonicalCsv("timestamp,value\n2026-08-19T00:00:00Z,1\r\n"),
    );
    expect((err.details as { line: number }).line).toBe(2);
    expect(err.message).toContain("LF line endings");
  });

  it("points_rejections: a timestamp that does not strictly increase names its line", () => {
    const equal = invalidError(() =>
      parseCanonicalCsv(
        "timestamp,value\n2026-08-19T00:00:00Z,1\n2026-08-19T00:00:00Z,2\n",
      ),
    );
    expect((equal.details as { line: number }).line).toBe(3);
    expect(equal.message).toContain("strictly greater");

    const descending = invalidError(() =>
      parseCanonicalCsv(
        "timestamp,value\n2026-08-20T00:00:00Z,1\n2026-08-19T00:00:00Z,2\n",
      ),
    );
    expect((descending.details as { line: number }).line).toBe(3);
  });

  it("points_rejections: `where` names the dataset in the message and the details", () => {
    const err = invalidError(() => parseCanonicalCsv("t,value\n", "1a2b3c4d-drone-basket"));
    expect(err.message).toContain("1a2b3c4d-drone-basket");
    expect((err.details as { dataset: string }).dataset).toBe("1a2b3c4d-drone-basket");
  });
});

describe("points_rfc3339", () => {
  it("points_rfc3339: parseRfc3339Utc returns null for every non-UTC spelling", () => {
    expect(parseRfc3339Utc("2026-08-20T00:00:00Z")).toBe(T_20);
    for (const bad of [
      "2026-08-20T00:00:00+00:00",
      "2026-08-20T00:00:00-05:00",
      "2026-08-20",
      "2026-08-20T24:00:00Z",
      "2026-08-20T00:60:00Z",
      "",
    ]) {
      expect(parseRfc3339Utc(bad)).toBeNull();
    }
  });
});
