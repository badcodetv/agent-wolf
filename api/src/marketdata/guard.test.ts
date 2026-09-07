/**
 * The response guard — the fix for the defect that made Stooq's death
 * invisible.
 *
 * The headline test is `stooq_challenge`: it feeds the **real, recorded**
 * stooq.com challenge page (`__fixtures__/stooq-challenge-page.html`,
 * captured 2026-09-07 — see that directory's README) through the real
 * connector and asserts it THROWS. Before the guard, the same bytes were
 * parsed into a DATA ROW — the page's inline <script> contains commas, so
 * column 0 became a timestamp and column 4 a value — and the pipeline
 * reported that as a successfully stored observation. The first test in
 * this file measures exactly that, so the reason the guard exists cannot
 * be lost.
 *
 * Every fixture used here is a recorded response, not a hand-written one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WolfError } from "../errors.js";
import {
  classifyBody,
  excerpt,
  EXCERPT_CHARS,
  guardCsvBody,
  guardJsonBody,
  UPSTREAM_BODY_CHARS,
} from "./guard.js";
import { createFredClient } from "./fred.js";
import { createStooqClient, parseStooqCsv } from "./stooq.js";
import { normalise } from "./normalise.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const fixture = (name: string) => readFileSync(`${fixturesDir}${name}`, "utf8");

/** stooq.com's live JavaScript proof-of-work interstitial, recorded 2026-09-07. */
const STOOQ_CHALLENGE = fixture("stooq-challenge-page.html");
/** Yahoo Finance's per-IP throttle body, recorded 2026-09-07. */
const YAHOO_429 = fixture("yahoo-429-body.txt");

const CSV_CTX = { provider: "stooq", status: 200, contentType: "text/csv" };

/** A `fetch` double answering one canned response. */
function fetchReturning(
  body: string,
  init: { status?: number; contentType?: string | null } = {},
): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.contentType === null ? {} : { "content-type": init.contentType ?? "text/html" },
    })) as unknown as typeof fetch;
}

describe("stooq_challenge: the recorded challenge page now fails instead of parsing", () => {
  it("PROOF OF THE OLD DEFECT: the parser writes JAVASCRIPT into the series as a data row", () => {
    // Not a regression test — a record of why the guard exists, measured on
    // the real bytes through the real parser and the real normaliser.
    //
    // The outcome is worse than "an empty series". The page's inline
    // <script> happens to contain commas, so the parser reads that line as
    // a data row: column 0 becomes the TIMESTAMP and column 4 the VALUE.
    // What `dataset_put` would have stored, and a chart would have tried to
    // plot, is a fragment of the challenge's own JavaScript — written with
    // row_count 1, reported as a success.
    const rows = parseStooqCsv(STOOQ_CHALLENGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timestamp).toMatch(/^\(async\(\)=>\{const c=/);
    expect(Number.isNaN(Number(rows[0]!.value))).toBe(true);

    const csv = normalise(rows);
    expect(csv.startsWith("timestamp,value\n(async()=>")).toBe(true);
    // ↑ A structurally valid canonical CSV. Nothing downstream could tell
    //   this from a real observation.
  });

  it("the connector THROWS on the recorded page", async () => {
    const client = createStooqClient({
      fetchImpl: fetchReturning(STOOQ_CHALLENGE, { status: 200, contentType: "text/html; charset=utf-8" }),
    });
    await expect(client.fetch("spy.us")).rejects.toThrow(WolfError);
  });

  it("classifies it as a browser-verification challenge, and says so in the message", async () => {
    const client = createStooqClient({
      fetchImpl: fetchReturning(STOOQ_CHALLENGE, { status: 200, contentType: "text/html; charset=utf-8" }),
    });
    const err = await client.fetch("spy.us").catch((e: unknown) => e as WolfError);
    expect(err).toBeInstanceOf(WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "challenge" });
    // The message has to be readable by a person who has never seen this
    // file: it names the provider, what was expected, and what came back.
    expect((err as WolfError).message).toMatch(/stooq/);
    expect((err as WolfError).message).toMatch(/CSV/);
    expect((err as WolfError).message).toMatch(/browser-verification/);
  });

  it("fires on HTTP 200 — the status check that used to pass is not what decides", () => {
    // The whole reason this went unnoticed: `response.ok` was true.
    expect(classifyBody(STOOQ_CHALLENGE, { ...CSV_CTX, status: 200, contentType: "text/html", expected: "csv" })?.kind).toBe(
      "challenge",
    );
  });
});

describe("guard_classification names each way a provider stops serving data", () => {
  it("a 429 is a rate limit, not a mystery — using Yahoo's recorded body", () => {
    const problem = classifyBody(YAHOO_429, {
      provider: "yahoo",
      status: 429,
      contentType: "text/html",
      expected: "json",
    });
    expect(problem?.kind).toBe("rate_limited");
    expect(problem?.message).toMatch(/rate-limited/);
    expect(problem?.message).toMatch(/429/);
  });

  it("a body SAYING it is rate-limited counts even on a 200", () => {
    // Yahoo's throttle body arrives with a 429 today, but a provider that
    // says "Too Many Requests" behind a 200 is the same event.
    expect(classifyBody(YAHOO_429, { ...CSV_CTX, status: 200, contentType: "text/plain", expected: "csv" })?.kind)
      .toBe("rate_limited");
  });

  it("rate limiting wins over 'it is HTML', because it is the more actionable message", () => {
    const problem = classifyBody("<html><body>Too Many Requests</body></html>", {
      provider: "yahoo",
      status: 429,
      contentType: "text/html",
      expected: "json",
    });
    expect(problem?.kind).toBe("rate_limited");
  });

  it("an HTML page with no challenge wording is still refused", () => {
    const problem = classifyBody("<!doctype html><html><body>502 Bad Gateway</body></html>", {
      ...CSV_CTX,
      expected: "csv",
    });
    expect(problem?.kind).toBe("html");
    expect(problem?.message).toMatch(/HTML page/);
  });

  it("a text/html content-type is enough on its own", () => {
    // A body that happens to start with a letter but is served as HTML.
    expect(
      classifyBody("Nothing to see", { provider: "stooq", status: 200, contentType: "text/html", expected: "csv" })
        ?.kind,
    ).toBe("html");
  });

  it("an empty body is refused — it would otherwise become an empty series", () => {
    expect(classifyBody("   \n ", { ...CSV_CTX, expected: "csv" })?.kind).toBe("empty");
    expect(classifyBody("", { ...CSV_CTX, expected: "json" })?.kind).toBe("empty");
  });

  it("a plain-text body whose first line is not a CSV header is refused", () => {
    expect(classifyBody("Invalid symbol\n", { ...CSV_CTX, expected: "csv" })?.kind).toBe("not_csv");
  });

  it("LIMIT: a real CSV passes untouched", () => {
    const csv = "Date,Open,High,Low,Close,Volume\n2026-01-02,1,2,0.5,1.5,100\n";
    expect(classifyBody(csv, { ...CSV_CTX, expected: "csv" })).toBeNull();
    expect(guardCsvBody(csv, CSV_CTX)).toBe(csv);
  });

  it("LIMIT: a real JSON body passes untouched, and the CSV-header rule does NOT apply to it", () => {
    // `{"observations":[]}` has no comma on its first line. If the not_csv
    // rule leaked into the JSON path, every single-key FRED response would
    // be rejected as a provider outage.
    const body = '{"observations":[]}';
    expect(classifyBody(body, { provider: "FRED", status: 200, contentType: "application/json", expected: "json" }))
      .toBeNull();
    expect(guardJsonBody<{ observations: unknown[] }>(body, {
      provider: "FRED",
      status: 200,
      contentType: "application/json",
    })).toEqual({ observations: [] });
  });
});

describe("guard_throws carry a readable message and a bounded body", () => {
  it("guardCsvBody throws unavailable — the retryable kind, deliberately", () => {
    // You cannot tell a permanent bot-wall from a ten-second CDN error page
    // in one response, so both retry and the message carries the difference.
    // See guard.ts's header.
    const err = (() => {
      try {
        guardCsvBody(STOOQ_CHALLENGE, CSV_CTX);
        return null;
      } catch (e) {
        return e as WolfError;
      }
    })();
    expect(err?.kind).toBe("unavailable");
  });

  it("guardJsonBody reports a non-JSON body as the PROVIDER's problem, not internal", () => {
    // `WolfError.internal` replaces the message with the fixed string
    // "internal error" and asserts the bug is ours. Neither is true here,
    // and neither is diagnosable.
    const err = (() => {
      try {
        guardJsonBody("value: not json", { provider: "yahoo", status: 200, contentType: "application/json" });
        return null;
      } catch (e) {
        return e as WolfError;
      }
    })();
    expect(err?.kind).toBe("unavailable");
    expect(err?.message).toMatch(/yahoo/);
    expect(err?.message).toMatch(/not JSON/);
    expect(err?.message).not.toBe("internal error");
  });

  it("keeps the offending body, but bounded, so a megabyte page cannot land in a log", () => {
    const huge = `<html>${"x".repeat(50_000)}</html>`;
    const err = (() => {
      try {
        guardCsvBody(huge, CSV_CTX);
        return null;
      } catch (e) {
        return e as WolfError;
      }
    })();
    expect(err?.upstreamBody?.length).toBe(UPSTREAM_BODY_CHARS);
  });

  it("quotes only a short, single-line excerpt in the message", () => {
    const err = (() => {
      try {
        guardCsvBody(STOOQ_CHALLENGE, CSV_CTX);
        return null;
      } catch (e) {
        return e as WolfError;
      }
    })();
    // The recorded page has newlines in it; a message spanning lines breaks
    // every log reader.
    expect(err!.message).not.toMatch(/\n/);
  });

  it("carries NO URL — FRED's would contain the API key", () => {
    // The context type takes a provider NAME for this reason. This asserts
    // the shape of what we produce, so a future `url` field cannot be added
    // without this failing.
    const err = (() => {
      try {
        guardCsvBody(STOOQ_CHALLENGE, CSV_CTX);
        return null;
      } catch (e) {
        return e as WolfError;
      }
    })();
    expect(err!.message).not.toMatch(/https?:\/\//);
    expect(err!.message).not.toMatch(/api_key/);
  });

  it("excerpt collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("a\n\n  b\tc")).toBe("a b c");
    const long = excerpt("y".repeat(EXCERPT_CHARS + 50));
    expect(long).toHaveLength(EXCERPT_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("guard_ordering leaves the not_found path alone", () => {
  it("an unknown Stooq symbol is still not_found, not a provider outage", async () => {
    // Stooq answers an unknown symbol with HTTP 200 and the plain text "No
    // data". That body has no comma on its first line, so the guard's
    // not_csv rule would classify it `unavailable` (retryable, "the
    // provider is down") if it ran first — turning "you asked for a ticker
    // that does not exist" into "come back tomorrow". stooq.ts checks "No
    // data" BEFORE calling the guard.
    const client = createStooqClient({
      fetchImpl: fetchReturning("No data\n", { status: 200, contentType: "text/plain" }),
    });
    const err = await client.fetch("nosuch.us").catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("not_found");
  });

  it("a 404 is still not_found and never reaches the guard", async () => {
    const client = createStooqClient({
      fetchImpl: fetchReturning("<html>not found</html>", { status: 404, contentType: "text/html" }),
    });
    const err = await client.fetch("nosuch.us").catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("not_found");
  });
});

describe("guard_fred: the same silent-empty-series shape, closed on FRED too", () => {
  // FRED is alive and keyed, so it has never served us a challenge page.
  // It is wired to the guard anyway because its own body handling had the
  // identical hole: `text ? JSON.parse(text) : {}` turned an EMPTY 200 into
  // `{}`, then `observations ?? []`, then zero rows, then a successfully
  // written empty dataset. Without these tests the FRED wiring would be a
  // guard nobody has ever seen fire — decoration, not a check.
  const KEY = "fred-api-key-for-tests-never-real";

  function fredWith(body: string, init: { status?: number; contentType?: string | null } = {}) {
    return createFredClient({
      apiKey: KEY,
      fetchImpl: (async () =>
        new Response(body, {
          status: init.status ?? 200,
          headers:
            init.contentType === null ? {} : { "content-type": init.contentType ?? "application/json" },
        })) as unknown as typeof fetch,
    });
  }

  it("an EMPTY 200 body is an outage, not a day with no observations", async () => {
    const err = await fredWith("", { status: 200 }).fetch("DGS10").catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "empty" });
    expect((err as WolfError).message).toMatch(/FRED/);
  });

  it("an HTML page is refused and names FRED", async () => {
    const err = await fredWith("<!doctype html><html><body>503</body></html>", {
      status: 200,
      contentType: "text/html",
    })
      .fetch("DGS10")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "html" });
    expect((err as WolfError).message).toMatch(/FRED returned an HTML page/);
  });

  it("a 429 is reported as a rate limit, not as a mystery status", async () => {
    const err = await fredWith("Too Many Requests", { status: 429, contentType: "text/plain" })
      .fetch("DGS10")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("unavailable");
    expect((err as WolfError).details).toEqual({ problem: "rate_limited" });
  });

  it("the guard runs on SEARCH too, not just fetch", async () => {
    const err = await fredWith("", { status: 200 }).search("treasury").catch((e: unknown) => e as WolfError);
    expect((err as WolfError).details).toEqual({ problem: "empty" });
  });

  it("LIMIT: malformed JSON is still `internal`, the classification R39 chose", async () => {
    // The guard must not swallow this case. R39's reasoning stands: a body
    // that is JSON-shaped-but-broken is not evidence of a provider outage,
    // and `unavailable` is the one kind the poller retries indefinitely.
    const err = await fredWith("this is not valid JSON {{{", { status: 200 })
      .fetch("DGS10")
      .catch((e: unknown) => e as WolfError);
    expect((err as WolfError).kind).toBe("internal");
  });

  it("LIMIT: a real observations body still parses", async () => {
    const rows = await fredWith(JSON.stringify({ observations: [{ date: "2026-01-02", value: "4.11" }] })).fetch(
      "DGS10",
    );
    expect(rows).toEqual([{ timestamp: "2026-01-02", value: "4.11" }]);
  });
});
