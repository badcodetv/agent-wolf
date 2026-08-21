import { describe, expect, it } from "vitest";
import { countDataRows, normalise, type RawMarketDataRow } from "./normalise.js";

// design/2026-08-20-agent-wolf.md § "The canonical dataset CSV" pins the
// EXACT byte string this ticket must reproduce. The two rows below are the
// plan's own worked example (not a provider fixture — normalise() is a pure
// function over already-extracted rows, so this input is hand-constructed
// on purpose, the same way any pure-function unit test hand-constructs its
// input; it needs no live network access).
describe("marketdata_normalise", () => {
  it("emits the canonical dataset CSV byte-for-byte for a two-row input", () => {
    const rows: RawMarketDataRow[] = [
      { timestamp: "2026-08-19", value: "141.22" },
      { timestamp: "2026-08-20", value: "143.90" },
    ];

    const csv = normalise(rows);

    expect(csv).toBe("timestamp,value\n2026-08-19T00:00:00Z,141.22\n2026-08-20T00:00:00Z,143.90\n");
  });

  it("converts a date-only provider timestamp to RFC3339 UTC midnight", () => {
    const csv = normalise([{ timestamp: "2026-01-01", value: "1" }]);
    expect(csv).toBe("timestamp,value\n2026-01-01T00:00:00Z,1\n");
  });

  it("sorts ascending by timestamp regardless of input order", () => {
    const rows: RawMarketDataRow[] = [
      { timestamp: "2026-01-03", value: "3" },
      { timestamp: "2026-01-01", value: "1" },
      { timestamp: "2026-01-02", value: "2" },
    ];

    expect(normalise(rows)).toBe(
      "timestamp,value\n2026-01-01T00:00:00Z,1\n2026-01-02T00:00:00Z,2\n2026-01-03T00:00:00Z,3\n",
    );
  });

  it("emits header-only output with no data rows for an empty input, and no blank line after it", () => {
    expect(normalise([])).toBe("timestamp,value\n");
  });

  // "marketdata_ duplicate-date" — the generic dedup rule (normalise()
  // operating on an already-extracted row array) rather than the
  // FRED-connector-specific restatement case: recording a REAL FRED
  // response containing a genuine restatement is blocked in this
  // environment (no FRED_API_KEY available to the executor — see Notes /
  // the Discovered Issues Log entry this ticket adds). This test proves
  // the same rule — last occurrence in provider order wins — without
  // depending on that fixture.
  it("marketdata_ duplicate-date: keeps the LAST occurrence in provider order, not the first or the max", () => {
    const rows: RawMarketDataRow[] = [
      { timestamp: "2026-01-01", value: "100" },
      { timestamp: "2026-01-02", value: "200" },
      // A restatement of 2026-01-01 arriving later in provider order, with
      // a corrected (and, deliberately, numerically SMALLER) value — so a
      // "keep the max" implementation would fail this test differently
      // from a "keep the first" one, and only "keep the last" passes.
      { timestamp: "2026-01-01", value: "97.5" },
    ];

    const csv = normalise(rows);

    expect(csv).toBe("timestamp,value\n2026-01-01T00:00:00Z,97.5\n2026-01-02T00:00:00Z,200\n");
    expect(csv).not.toContain("100");
  });

  // Every other case in this file uses contiguous dates (01-01, 01-02,
  // 01-03), so a hypothetical gap-filling or interpolating implementation
  // would pass the whole file up to this point — see this ticket's
  // Discovered Issues Log entry. This case pins a real gap: 2026-01-05
  // follows 2026-01-01 directly, with nothing synthesised in between.
  it("marketdata_ no gap filling and no interpolation: a real gap between dates produces no synthesised rows", () => {
    const rows: RawMarketDataRow[] = [
      { timestamp: "2026-01-01", value: "10" },
      { timestamp: "2026-01-05", value: "50" },
    ];

    const csv = normalise(rows);

    expect(csv).toBe("timestamp,value\n2026-01-01T00:00:00Z,10\n2026-01-05T00:00:00Z,50\n");
  });

  describe("marketdata_ countDataRows boundaries", () => {
    it("empty file is 0", () => {
      expect(countDataRows("")).toBe(0);
    });

    it("header-only (with trailing LF) is 0", () => {
      expect(countDataRows("timestamp,value\n")).toBe(0);
    });

    it("one data row (with trailing LF) is 1", () => {
      expect(countDataRows("timestamp,value\n2026-01-01T00:00:00Z,1\n")).toBe(1);
    });

    it("one data row with NO trailing newline still counts the last line: 1", () => {
      expect(countDataRows("timestamp,value\n2026-01-01T00:00:00Z,1")).toBe(1);
    });

    it("two data rows is 2", () => {
      expect(
        countDataRows(
          "timestamp,value\n2026-01-01T00:00:00Z,1\n2026-01-02T00:00:00Z,2\n",
        ),
      ).toBe(2);
    });

    it("a file ending in a blank line counts the blank line as a line, and is never negative", () => {
      const csv = "timestamp,value\n2026-01-01T00:00:00Z,1\n2026-01-02T00:00:00Z,2\n\n";
      const result = countDataRows(csv);
      expect(result).toBeGreaterThanOrEqual(0);
      // 4 \n-terminated runs (header, row, row, "") → max(0, 4-1) = 3,
      // matching O6a's mechanical \n-run definition exactly rather than a
      // "count non-blank data lines" definition — the boundary case exists
      // to prove this never goes negative or throws, not that blank lines
      // are filtered.
      expect(result).toBe(3);
    });

    it("is never -1 for any input this function accepts", () => {
      expect(countDataRows("")).toBeGreaterThanOrEqual(0);
      expect(countDataRows("\n")).toBeGreaterThanOrEqual(0);
      expect(countDataRows("x")).toBeGreaterThanOrEqual(0);
    });

    it("matches normalise()'s own output: a normalised two-row CSV counts as 2", () => {
      const csv = normalise([
        { timestamp: "2026-08-19", value: "141.22" },
        { timestamp: "2026-08-20", value: "143.90" },
      ]);
      expect(countDataRows(csv)).toBe(2);
    });
  });
});
