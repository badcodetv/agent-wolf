/**
 * X1 — the dataset atom, end to end, through the two byte paths.
 *
 * A tick writes the canonical CSV inside a container; Orange stores it as a
 * versioned blob; Wolf's series proxy reads it back and hands the browser
 * points. The bytes never cross the model's context in either direction.
 *
 * 🔴 WHAT THIS LEG DOES **NOT** PROVE. The mock model's tool inputs are static
 * JSON (`go/modelproxy/script.go:19-60`), so it cannot pipe `series_fetch`'s
 * `download_url` into a later turn's input. The tick therefore writes a FIXTURE
 * series rather than a fetched one: this proves tool reachability and the whole
 * dataset write path, **not** provider→dataset fidelity. The byte-level round
 * trip from a provider is O9's job.
 */

import { expect, test } from "@playwright/test";
import {
  createAndGoLive,
  datasetMeta,
  METRIC_SLUG,
  orange,
  ORANGE_BASE,
  retire,
  signIn,
  waitForTick,
  wolf,
  type LiveHypothesis,
} from "../helpers/x1.js";

test.describe.configure({ mode: "serial" });

test.describe("dataset round trip", () => {
  let hyp: LiveHypothesis;

  test("go live and wait for the first tick", async ({ page }) => {
    await signIn(page);
    hyp = await createAndGoLive(page, {
      title: "X1 dataset round trip",
      thesis: "A probe thesis whose condition never trips, so the dataset can be read at leisure.",
      interviewMarker: "X1-INTERVIEW-HOLDING",
    });
    const meta = await waitForTick(hyp);
    expect(meta.version).toBeGreaterThanOrEqual(1);
  });

  test("the dataset is named with the BARE id and carries the tick's provenance", async () => {
    const meta = await datasetMeta(hyp.datasetName);
    expect(meta).not.toBeNull();

    // 🔴 § Vocabulary: the id is bare, the `hyp-` prefix belongs to the session
    // name and to nothing else. `hyp-hyp-…` is a real failure under which the
    // trust rule's session clause never matches — this assertion exists to
    // catch a doubled prefix at the one place it would first show.
    expect(meta!.name).toBe(`${hyp.id}-${METRIC_SLUG}`);
    expect(meta!.name).toMatch(/^[0-9a-f]{8}-probe-rate$/);
    expect(meta!.content_type).toBe("text/csv");
    expect(meta!.row_count).toBe(10);
    expect(meta!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta!.labels?.["hypothesis"]).toBe(hyp.id);
  });

  test("the stored bytes are the canonical dataset CSV, exactly", async () => {
    const res = await fetch(
      `${ORANGE_BASE}/agent/datasets/${encodeURIComponent(hyp.datasetName)}/download`,
      { headers: { "X-API-Key": process.env.WOLF_API_KEY ?? "" } },
    );
    expect(res.status).toBe(200);
    // Copied from the artifact route's vocabulary: bytes are served as an
    // attachment and must never be sniffed into another type.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csv = await res.text();

    // 🔴 The header is EXACTLY `timestamp,value`. A `t,value` header makes the
    // poller read ZERO observations from a legitimately written dataset with
    // no error anywhere — which is why this is asserted byte-for-byte rather
    // than by parsing.
    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,value");
    expect(csv.includes("\r"), "CRLF endings — the parser rejects them").toBe(false);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.endsWith("\n\n"), "a trailing blank line is a malformed row").toBe(false);

    const rows = lines.slice(1).filter((line) => line !== "");
    expect(rows.length).toBe(10);
    let previous = -1;
    for (const row of rows) {
      const [stamp, value] = row.split(",");
      expect(stamp, `not RFC3339 UTC: ${row}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const ms = Date.parse(stamp!);
      expect(ms, "timestamps must be strictly ascending").toBeGreaterThan(previous);
      previous = ms;
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });

  test("the version history is real, and a second tick advances it under CAS", async () => {
    const first = await datasetMeta(hyp.datasetName);
    // The schedule fires every minute in this rig, so a later version arrives
    // on its own. `dataset_put` is compare-and-swap: the tick re-reads the
    // current version before writing, so this advances rather than conflicts.
    const later = await test.step("wait for a second tick", async () => {
      const deadline = Date.now() + 4 * 60_000;
      for (;;) {
        const meta = await datasetMeta(hyp.datasetName);
        if (meta !== null && meta.version > first!.version) return meta;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 5_000));
      }
    });
    expect(later, "no second version arrived — the CAS write path may be stuck").not.toBeNull();
    expect(later!.version).toBeGreaterThan(first!.version);

    const versions = await orange<{ versions: { version: number }[] }>(
      "GET",
      `/agent/datasets/${encodeURIComponent(hyp.datasetName)}/versions?limit=10`,
    );
    expect(versions.status).toBe(200);
    const numbers = versions.body.versions.map((v) => v.version);
    expect(numbers.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    expect(numbers[0]).toBe(later!.version);
  });

  test("Wolf's series proxy hands the browser points, never bytes", async ({ page }) => {
    await signIn(page);
    const res = await wolf<{
      points: { tMs: number; v: number }[];
      unit: string | null;
      version: number;
      fetched_at_ms: number;
      state: string;
    }>(page.request, "get", `/api/hypotheses/${hyp.id}/series/${METRIC_SLUG}`);
    expect(res.status, `series proxy → ${res.text.slice(0, 300)}`).toBe(200);
    expect(res.body.points.length).toBe(10);
    // Units live in the NAME: `tMs` is unix MILLISECONDS.
    expect(res.body.points[0]!.tMs).toBeGreaterThan(1_700_000_000_000);
    expect(res.body.version).toBeGreaterThanOrEqual(1);
    // The response carries no CSV and no download URL — the credential in a
    // `download_url` must not reach a browser.
    expect(res.text).not.toContain("timestamp,value");
    expect(res.text).not.toContain("token=");

    await page.goto(`/hypotheses/${hyp.id}`);
    await expect(page.getByTestId("metric-chart").first()).toBeVisible();
    await expect(page.getByTestId("metric-chart-no-points")).toHaveCount(0);
  });

  test("retiring the hypothesis leaves the dataset readable", async ({ page }) => {
    await signIn(page);
    await retire(page, hyp.id, "X1: done with the dataset round trip.");
    const meta = await datasetMeta(hyp.datasetName);
    expect(meta, "teardown deleted the dataset — datasets are never torn down").not.toBeNull();
  });
});
