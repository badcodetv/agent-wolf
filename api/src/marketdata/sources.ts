/**
 * The market-data provider list. **One copy, imported everywhere.**
 *
 * This module exists because the list was written out three times and the
 * third copy was missed when `yahoo` was added:
 *
 *   - `mcp/tools.ts` — `SERIES_SOURCES`, the `series_search`/`series_fetch`
 *     tool enums;
 *   - `hypothesis/spec.ts` — `METRIC_SOURCES`, the go-live gate;
 *   - `mcp/seriesdownload.ts` — a bare `z.enum(["fred", "stooq"])` inside
 *     the download token's payload schema.
 *
 * The third one had no test that enumerated sources, so `series_fetch`
 * happily minted a `yahoo` download URL that the download route then
 * rejected with `invalid or expired token` — a signature-shaped error
 * message for what was really an unknown-enum-value rejection. It looked
 * like a crypto or clock problem and was a stale list. Found only by
 * fetching a real gold series end to end through the deployed stack; every
 * unit test passed.
 *
 * So: adding a provider is editing THIS file, and the other three derive
 * from it. `METRIC_SOURCES` is literally `[...SERIES_SOURCES, "derived"]`,
 * which is what it always meant.
 */

/**
 * Every provider a series can be fetched from, in the order
 * `series_search` queries them when no source is given.
 *
 * 🔴 `stooq` is DEAD — stooq.com answers every request with a
 * browser-verification page (see `guard.ts` and `stooq.ts`). It stays in
 * this list so specs locked before it died remain valid; every prompt tells
 * the model never to choose it for new work.
 */
export const SERIES_SOURCES = ["fred", "stooq", "yahoo"] as const;

export type SeriesSource = (typeof SERIES_SOURCES)[number];
