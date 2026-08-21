# Market-data fixtures

design/2026-08-20-agent-wolf.md § W6: "Fixtures are recorded real responses,
not hand-written." This file records the exact command each fixture was (or
would be) captured with, per that requirement.

## FRED — RECORDED 2026-08-21 (W6b)

**W6b.** A real `FRED_API_KEY` was made available to the W6b executor (it is
not committed anywhere — see `.env`, which is git-ignored). Both fixtures
below were recorded with it on **2026-08-21** using exactly these commands
(shown with the variable, never the value):

```sh
curl -sS "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=$FRED_API_KEY&file_type=json&observation_start=2024-12-20&observation_end=2025-01-03" \
  -o api/src/marketdata/__fixtures__/fred-observations-dgs10.json

curl -sS "https://api.stlouisfed.org/fred/series/search?search_text=treasury&api_key=$FRED_API_KEY&file_type=json&limit=5" \
  -o api/src/marketdata/__fixtures__/fred-search-treasury.json
```

(Both files were re-serialised through `json.dump(..., indent=2)` after
capture, for readable diffs — the field set and values are unchanged from
what FRED returned. Neither response body contains the API key; verified
with `grep` for the literal key value against both files before committing,
in addition to the general repo-wide `.env`-is-git-ignored protection.)

**`fred-observations-dgs10.json`** — DGS10 (10-Year Treasury yield),
`observation_start=2024-12-20&observation_end=2025-01-03`. This range was
chosen because it spans both Christmas Day and New Year's Day 2024/2025,
and DGS10 is published as a business-daily series that lists every weekday
including market holidays, with the value `"."` on days markets were
closed. The recorded response contains exactly this: 11 observations, two
of which (`2024-12-25` and `2025-01-01`) have `"value": "."`. This pins the
missing-value-sentinel-omission test.

**`fred-search-treasury.json`** — `search_text=treasury&limit=5` (the
unbounded query matches 7306 series; `limit=5` keeps the committed fixture
small while still exercising the real field shape). This pins the
`series_search` field-mapping test: `id`, `title`, `units`, `frequency`,
`observation_start`, `observation_end` are all present on every item, as
FRED actually returns them (`units`/`frequency` are the plain English
strings, e.g. `"Percent"`/`"Daily"`, not the `_short` codes).

## Stooq — ALSO BLOCKED, no fixture recorded (discovered during this ticket)

Stooq's daily-download endpoint needs no key, and a bare status check
confirms it answers HTTP 200:

```sh
curl -sS -i "https://stooq.com/q/d/l/?s=spy.us&i=d"
# HTTP/1.1 200 OK
```

**However, the response BODY is not CSV.** Verified directly and
repeatedly during this ticket (`curl`, `curl` with a browser `User-Agent`,
a persisted cookie jar across two requests, and `wget`, all four attempts
on 2026-08-21): every plain HTTP request to this endpoint returns an HTML
page containing a client-side JavaScript proof-of-work challenge
(`This site requires JavaScript to verify your browser...`), not the
`Date,Open,High,Low,Close,Volume` CSV the connector needs. The response
looks like:

```
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
...
<!DOCTYPE html><html>...<script nonce="...">
(async()=>{const c="...",d=4,t="0".repeat(d),...
```

This is a bot-protection wall (compute a SHA-256 proof-of-work, POST the
solution to `/__verify`, reload). Solving it programmatically to scrape the
site is not something this ticket will do — that is circumventing
anti-automation protection, not "recording a fixture," and it is out of
scope regardless of ticket instructions. This same command was reported
reachable-without-a-key by the orchestrator's own pre-ticket check, which
appears to have checked only the HTTP status code and not the response
body; see this ticket's Discovered Issues Log entry.

The command that WOULD have been used, if/when the endpoint answers CSV
again (or an equivalent unprotected Stooq mirror/endpoint is identified):

```sh
curl -sS "https://stooq.com/q/d/l/?s=spy.us&i=d" \
  -o api/src/marketdata/__fixtures__/stooq-spy-daily.csv
```

Until then, `stooq.ts`'s `parseStooqCsv` is implemented and unit-tested
against Stooq's publicly documented CSV shape
(`Date,Open,High,Low,Close,Volume`, `Close` as the value column) — see
`stooq.test.ts`'s `parseStooqCsv` describe block, which says explicitly in
its own title that this is NOT a recorded fixture.

## The Stooq ticker table — not a recorded fixture, by design

The committed static ticker table `search()` matches against
(§ W6 acceptance criteria: "Stooq has no search API: its `search` matches a
committed static ticker table … covering at least the US equity and ETF
symbols the interviewer prompt suggests") is a hand-authored reference
table, not a captured API response — Stooq has no search endpoint, which is
exactly why `stooq.ts`'s `search()` matches against a committed table
instead of calling out.

**It lives at `api/src/marketdata/stooq-tickers.ts`, as a TypeScript
module — not at `__fixtures__/stooq-tickers.json`.** It started life as a
JSON file under this directory, loaded at runtime with `readFileSync`; a
fix-round finding caught that `api/`'s build (`tsc`, `rootDir: src` →
`outDir: dist`) does not copy that JSON into `dist/`, and `api/Dockerfile`
copies only `dist/`, `package.json` and `node_modules` — so
`createStooqClient()` with no injected `tickers` would `ENOENT` the first
time it ran from the built image (this ticket's Discovered Issues Log
entry has the full account). Moving the table into a `.ts` module makes it
part of the same `tsc` output as everything else this package exports, so
there is nothing left for the production image to be missing.

`prompts/interviewer.md` does not exist yet on this branch (it is created
by a later ticket), so the table is a reasonable placeholder set of
well-known US equities and ETFs, including `avav.us` (the one symbol the
plan's own Spec JSON example names) — see this ticket's Discovered Issues
Log entry and its `guesses` for the exact list and the reasoning. Extend
it, rather than replace it, if a later ticket finds `prompts/interviewer.md`
names symbols this table lacks.
