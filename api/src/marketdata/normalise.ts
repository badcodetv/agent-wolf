/**
 * The canonical dataset CSV — the single normaliser every market-data
 * connector's output goes through before `dataset_put` is called.
 *
 * See design/2026-08-20-agent-wolf.md § "The canonical dataset CSV" (agent-orange
 * repo): header exactly `timestamp,value`, RFC3339 in UTC, ascending by
 * timestamp, LF line endings, one metric per file, a single terminating LF
 * after the last data row and NO blank line after it.
 *
 * Nothing here reads `process.env` (W6 acceptance criterion) — every input
 * is passed explicitly.
 */

/** A single (timestamp, value) pair as a provider connector emits it, BEFORE
 * normalisation. `timestamp` is either a bare date (`YYYY-MM-DD`, which both
 * FRED and Stooq emit) or an already-RFC3339 string. `value` is kept as the
 * verbatim numeric STRING the provider sent — never re-parsed to a JS
 * `number` and reformatted — so normalise() cannot introduce floating-point
 * drift (e.g. 0.1 + 0.2) into a byte-exact output. */
export interface RawMarketDataRow {
  timestamp: string;
  value: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` becomes `YYYY-MM-DDT00:00:00Z`, exactly as § "The canonical
 * dataset CSV" specifies. A timestamp that is not date-only is assumed to
 * already be RFC3339 UTC and is passed through unchanged — neither provider
 * emits anything else today, and re-parsing an already-correct timestamp
 * through `Date` risks losing precision or silently accepting a non-UTC
 * offset. */
function toRfc3339Utc(timestamp: string): string {
  if (DATE_ONLY_RE.test(timestamp)) {
    return `${timestamp}T00:00:00Z`;
  }
  return timestamp;
}

/**
 * Normalises raw provider rows into the canonical dataset CSV, as bytes.
 *
 * - Deduplicates by (normalised) timestamp, keeping the LAST occurrence in
 *   provider order — a FRED restatement re-emits a date with a corrected
 *   value, and the corrected one must win.
 * - Sorts ascending by timestamp.
 * - No gap filling, no interpolation: a missing day is simply absent.
 * - Emits `timestamp,value` header, LF line endings, a single terminating
 *   LF, no trailing blank line.
 */
export function normalise(rows: RawMarketDataRow[]): string {
  // Map iteration order does not matter here because we sort explicitly
  // below; what matters is that re-`set`ting an existing key overwrites its
  // value, so the LAST occurrence in `rows` (provider order) always wins.
  const byTimestamp = new Map<string, string>();
  for (const row of rows) {
    byTimestamp.set(toRfc3339Utc(row.timestamp), row.value);
  }

  const sorted = Array.from(byTimestamp.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const lines = ["timestamp,value", ...sorted.map(([timestamp, value]) => `${timestamp},${value}`)];
  return `${lines.join("\n")}\n`;
}

/**
 * `row_count` / `rows`: `max(0, N-1)` where `N` counts a `\n`-terminated run
 * plus a final unterminated run when the last byte is not `\n` — exactly
 * O6a's `RowCount` for `text/csv` (design/2026-08-20-agent-wolf.md, O6a
 * ticket, agent-orange repo). So `"h\na\nb"` and `"h\na\nb\n"` both give 1
 * data row's worth over a 2-line body (2 runs → max(0,2-1)=1), `"h\n"`
 * gives 0, and empty gives 0. Never negative.
 *
 * `series_fetch`'s `rows` and a later `dataset_put`'s `row_count` must not
 * disagree about an unmodified file, so this is the ONE implementation
 * both read from.
 */
export function countDataRows(csv: string): number {
  if (csv.length === 0) return 0;
  const parts = csv.split("\n");
  const runs = csv.endsWith("\n") ? parts.length - 1 : parts.length;
  return Math.max(0, runs - 1);
}
