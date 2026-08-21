/**
 * The committed static Stooq ticker table.
 *
 * design/2026-08-20-agent-wolf.md § W6 acceptance criteria: "Stooq has no
 * search API: its `search` matches a committed static ticker table
 * (`__fixtures__/stooq-tickers.json`, covering at least the US equity and
 * ETF symbols the interviewer prompt suggests) case-insensitively on
 * symbol and name."
 *
 * This table is a TypeScript module, not a `.json` file read at runtime
 * via `readFileSync` — a fix-round correction (see this ticket's
 * Discovered Issues Log entry). `api/`'s build is plain `tsc`
 * (`rootDir: src` → `outDir: dist`, `api/tsconfig.json`), which emits only
 * compiled `.ts` sources into `dist/`; it does not copy arbitrary files
 * like a sibling `__fixtures__/*.json`. The production image
 * (`api/Dockerfile`) then copies only `dist/`, `package.json` and
 * `node_modules` — no `src/`. A `readFileSync` against a path under
 * `src/marketdata/__fixtures__/` therefore ENOENTs the first time it runs
 * from the built image, because that directory does not exist in `dist/`
 * at all. Making the table an imported TS module puts its data through the
 * same `tsc` compilation (and therefore the same `dist/` output) as every
 * other symbol this file exports, so there is nothing left to go missing
 * at runtime.
 *
 * The set below is the same placeholder list reasoned about in this
 * ticket's `__fixtures__/README.md` and `guesses`: a reasonable set of
 * well-known US equities and ETFs, including `avav.us` (the one symbol the
 * plan's own Spec JSON example names). `prompts/interviewer.md` does not
 * exist yet on this branch (a later ticket creates it) — extend this list,
 * rather than replace it, if that ticket finds symbols missing here.
 */

import type { StooqTicker } from "./stooq.js";

export const DEFAULT_STOOQ_TICKERS: StooqTicker[] = [
  { symbol: "spy.us", name: "SPDR S&P 500 ETF Trust" },
  { symbol: "qqq.us", name: "Invesco QQQ Trust" },
  { symbol: "dia.us", name: "SPDR Dow Jones Industrial Average ETF Trust" },
  { symbol: "iwm.us", name: "iShares Russell 2000 ETF" },
  { symbol: "gld.us", name: "SPDR Gold Shares" },
  { symbol: "uso.us", name: "United States Oil Fund" },
  { symbol: "aapl.us", name: "Apple Inc" },
  { symbol: "msft.us", name: "Microsoft Corporation" },
  { symbol: "amzn.us", name: "Amazon.com Inc" },
  { symbol: "googl.us", name: "Alphabet Inc Class A" },
  { symbol: "meta.us", name: "Meta Platforms Inc" },
  { symbol: "nvda.us", name: "NVIDIA Corporation" },
  { symbol: "tsla.us", name: "Tesla Inc" },
  { symbol: "avav.us", name: "AeroVironment Inc" },
  { symbol: "rtx.us", name: "RTX Corporation" },
  { symbol: "lmt.us", name: "Lockheed Martin Corporation" },
  { symbol: "noc.us", name: "Northrop Grumman Corporation" },
  { symbol: "ba.us", name: "The Boeing Company" },
  { symbol: "xom.us", name: "Exxon Mobil Corporation" },
  { symbol: "jpm.us", name: "JPMorgan Chase & Co" },
];
