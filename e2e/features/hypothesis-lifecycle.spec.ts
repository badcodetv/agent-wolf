/**
 * X1 — the whole product, once, against both running stacks.
 *
 * create → interview → accept a report template → go live → a real cron tick →
 * a dataset written from inside a container → a condition tripped by Wolf's own
 * evaluator → the board and the detail page → a human verdict → teardown
 * observed by effect.
 *
 * Everything here runs offline against the scripted mock model. `run.sh`
 * refuses to start if agentd's boot line does not say so.
 */

import { expect, test } from "@playwright/test";
import {
  allSchedules,
  createAndGoLive,
  datasetMeta,
  getMemory,
  listMemories,
  METRIC_SLUG,
  orange,
  sessionByName,
  sessions,
  signIn,
  waitFor,
  waitForTick,
  wolf,
  workerExists,
  type LiveHypothesis,
} from "../helpers/x1.js";

test.describe.configure({ mode: "serial" });

test.describe("hypothesis lifecycle", () => {
  let hyp: LiveHypothesis;

  test("create, interview, accept a template and go live", async ({ page }) => {
    await signIn(page);
    hyp = await createAndGoLive(page, {
      title: "X1 lifecycle — the probe rate falls",
      thesis: "A probe thesis whose invalidation condition trips on the first tick.",
      interviewMarker: "X1-INTERVIEW-TRIPPING",
    });

    const detail = await wolf<{
      hypothesis: { status: string };
      atoms: { worker: string; schedule_id: string | null; session_id: string };
    }>(page.request, "get", `/api/hypotheses/${hyp.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.hypothesis.status).toBe("live");

    // The three Orange atoms go-live creates. `researcher-<id>` carries the
    // BARE id — the `hyp-` prefix belongs to the session name and to nothing
    // else, and `hyp-hyp-…` is the failure this pair catches.
    expect(detail.body.atoms.worker).toBe(`researcher-${hyp.id}`);
    expect(detail.body.atoms.schedule_id).not.toBeNull();
    expect(await workerExists(`researcher-${hyp.id}`)).toBe(true);
    const session = await sessionByName(hyp.sessionName);
    expect(session?.name).toBe(`hyp-${hyp.id}`);
    expect(session?.name.startsWith("hyp-hyp-")).toBe(false);

    // The locked spec is a TRUSTED memory: written by Wolf through
    // `POST /agent/memories`, so its provenance is server-stamped empty. The
    // researcher can propose a change but can never rewrite this row.
    const specRows = await listMemories(`kind=hypothesis-spec,name=${hyp.id}`);
    expect(specRows.length).toBeGreaterThan(0);
    expect(specRows[0]!.created_by_worker).toBe("");
    expect(specRows[0]!.created_by_session).toBe("");
  });

  test("a real cron tick writes the dataset from inside a container", async () => {
    const meta = await waitForTick(hyp);

    // 🔴 THE DATASET NAME. Bare id + metric slug, never `hyp-<id>-…`.
    expect(meta.name).toBe(`${hyp.id}-${METRIC_SLUG}`);
    expect(meta.name.startsWith("hyp-")).toBe(false);
    expect(meta.version).toBeGreaterThanOrEqual(1);
    expect(meta.row_count).toBe(10);

    // Written from INSIDE the tick container: the provenance names the
    // per-hypothesis researcher worker, which is the whole point of the
    // dataset atom (a shared series that never crosses the model's context).
    const raw = await orange<{ created_by_worker: string }>(
      "GET",
      `/agent/datasets/${encodeURIComponent(meta.name)}`,
    );
    expect(raw.body.created_by_worker).toBe(`researcher-${hyp.id}`);
  });

  test("the tick reached BOTH MCP servers from inside the container", async () => {
    // The reachability proof R41 assigns to X1, and the one thing no unit test
    // in this project can make: a session container calling out over the DinD
    // bridge gateway to two different servers.
    // `mcp__core__memory_create` through the HARNESS's own MCP client (a static
    // tool_use block), not through the container's curl. Matched on the WRITER,
    // never on "the newest row": three hypotheses tick concurrently in this rig
    // and they all write this label pair, so `rows[0]` belongs to whichever one
    // happened to fire last.
    await waitFor(
      `a harness-written probe from researcher-${hyp.id}`,
      async () => {
        const rows = await listMemories(`kind=x1-harness-probe,name=researcher`, { limit: 50 });
        return rows.find((r) => r.created_by_worker === `researcher-${hyp.id}`) ?? null;
      },
      4 * 60_000,
    );

    // …and the same static turn from the INTERVIEW session. It was emitted and
    // never asserted until the verifier pointed it out: a mock turn nothing
    // checks is a turn that can stop working silently.
    const interviewProbe = await listMemories("kind=x1-harness-probe,name=interview", {
      limit: 50,
    });
    expect(
      interviewProbe.length,
      "the interview session's harness-written MCP probe never landed",
    ).toBeGreaterThan(0);
    expect(interviewProbe[0]!.created_by_worker).toBe("interviewer");

    // `mcp__core__dataset_put` through the same client.
    const probe = await datasetMeta("x1-tick-probe");
    expect(probe, "the static dataset_put probe never landed").not.toBeNull();
    expect(probe!.version).toBeGreaterThanOrEqual(1);

    // And the `wolf` MCP server, reached at the DinD gateway. `series_search`
    // over the committed Stooq ticker table answers offline; `series_fetch`
    // answers `misconfigured` with no FRED key, which is still a round trip.
    // A tick session that has actually FINISHED its turns. The schedule fires
    // every minute here, so the newest session for this worker is often still
    // booting — picking it and asserting on an empty event list would fail for
    // a reason that has nothing to do with reachability.
    const { called, inner } = await waitFor(
      `a completed tick session for researcher-${hyp.id}`,
      async () => {
        // `sessions(worker)` sends `?user_email=*&worker=…`, which is the same
        // pair W9's teardown uses. Without `user_email=*` a job session is
        // invisible to an API-key caller and this loop finds nothing at all.
        const candidates = await sessions(`researcher-${hyp.id}`);
        for (const candidate of candidates) {
          const events = await orange<{ events: { events: { type: string; data: unknown }[] }[] }>(
            "GET",
            `/agent/session/${candidate.id}/query-events?limit=200`,
          );
          const flat = (events.body?.events ?? []).flatMap((row) => row.events ?? []);
          const names = flat
            .filter((e) => e.type === "tool_use_start")
            .map((e) => (e.data as { toolName?: string }).toolName ?? "");
          if (names.includes("mcp__core__memory_create")) return { called: names, inner: flat };
        }
        return null;
      },
      5 * 60_000,
    );
    expect(called).toContain("mcp__wolf__series_search");
    expect(called).toContain("mcp__wolf__series_fetch");
    expect(called).toContain("mcp__core__dataset_put");
    expect(called).toContain("mcp__core__memory_create");

    // 🔴 THE RAW STRING, NOT `JSON.stringify` OF IT. `data.output` is ALREADY a
    // string carrying JSON text — measured, not assumed — so stringifying it
    // again escapes every quote: `{"kind":"misconfigured"…}` becomes
    // `"{\"kind\":\"misconfigured\"…}"`, and any pattern containing a quote
    // stops matching. That is a bug this file shipped: the envelope assertion
    // below was written with quotes, against a double-encoded string, and
    // failed for a reason that had nothing to do with what it was testing.
    // Unquoted patterns like `avav.us` survived the escaping, which is exactly
    // why the neighbouring assertion kept passing and hid it.
    const ends = inner
      .filter((e) => e.type === "tool_use_end")
      .map((e) => {
        const out = (e.data as { output?: unknown }).output;
        return typeof out === "string" ? out : JSON.stringify(out ?? "");
      });

    // `series_search` ROUND-TRIPPED: the AeroVironment row comes from W6's
    // committed ticker table, inside wolf-api, reached over the DinD gateway.
    expect(
      ends.some((out) => out.includes("avav.us")),
      "series_search did not answer from inside the container — the wolf MCP server was not reachable",
    ).toBe(true);

    // 🔴 `series_fetch` IS ASSERTED BY ITS ANSWER, NOT ONLY BY ITS NAME. Being
    // in the called list proves the harness SENT it; only wolf-api's own
    // envelope proves it ARRIVED — a connection failure produces a harness
    // error, never a typed `WolfError`.
    //
    // 🔴 THE ENVELOPE, NOT THE MESSAGE — and this assertion has already been
    // wrong once for exactly that reason. `series_fetch(source: "fred")` has
    // three answers and the first draft pinned the message text of ONE of them:
    //
    //   no key   → {"error":{"kind":"misconfigured",
    //               "message":"FRED_API_KEY is required to construct a FRED client",…}}
    //   bad key  → {"error":{"kind":"misconfigured",
    //               "message":"FRED rejected the configured API key",…}}   ← no "FRED_API_KEY"
    //   good key → a success carrying a credential-bearing download_url
    //
    // Both measured directly against a running wolf-api. The draft required
    // `"misconfigured"` AND `"FRED_API_KEY"`, so it passed in a checkout with no
    // `.env` and failed in the canonical one, which has a real key — and the
    // failure was the symptom that exposed the far worse defect: the rig was
    // making a live credentialed call at all. `run.sh` now blanks the key and
    // asserts it, so the first branch is the only reachable one; this asserts
    // the part that is true of every branch that reaches wolf-api.
    expect(
      ends.some((out) => out.includes('"kind":"misconfigured"') && out.includes('"retryable"')),
      "series_fetch produced no typed WolfError envelope. Either it never reached wolf-api, " +
        "or wolf-api answered SUCCESSFULLY because a FRED_API_KEY leaked into the container — " +
        "which would mean this 'offline' run made a live credentialed call. run.sh's " +
        "'offline proof' line checks that before the specs start.",
    ).toBe(true);
  });

  test("Wolf's own evaluator trips the condition and moves it to challenged", async ({ page }) => {
    await signIn(page);
    const detail = await waitFor(
      `hypothesis ${hyp.id} to reach challenged`,
      async () => {
        const res = await wolf<{
          hypothesis: { status: string };
          evaluation: {
            support_score: number;
            conditions: { id: string; state: string; reason: string; value: number }[];
          } | null;
        }>(page.request, "get", `/api/hypotheses/${hyp.id}`);
        return res.status === 200 && res.body.hypothesis.status === "challenged" ? res.body : null;
      },
      5 * 60_000,
    );

    const tripped = detail.evaluation?.conditions.find((c) => c.id === "inv-1");
    expect(tripped?.state).toBe("tripped");
    expect(tripped?.reason).toBe("condition_tripped");
    // The evaluator, not the model, decided this: 145.5 > 100.
    expect(tripped?.value).toBeGreaterThan(100);
    expect(detail.evaluation?.support_score).toBeGreaterThanOrEqual(-1);
    expect(detail.evaluation?.support_score).toBeLessThanOrEqual(1);

    // The board's numbers come from a TRUSTED `kind=evaluation` memory whose
    // first line is the summary — not from a label and not from N dataset reads.
    const evalRows = await listMemories(`kind=evaluation,name=${hyp.id}`);
    expect(evalRows.length).toBeGreaterThan(0);
    expect(evalRows[0]!.created_by_worker).toBe("");
    expect(evalRows[0]!.created_by_session).toBe("");
    const full = await getMemory(evalRows[0]!.id);
    expect(full.content.split("\n")[0]).toMatch(
      /^score=-?\d+(\.\d+)? tripped=\d+ holding=\d+ indeterminate=\d+ evaluated=/,
    );
  });

  test("the board and the detail page render it, and the chat iframe is not blocked", async ({
    page,
  }) => {
    await signIn(page);

    await page.goto("/");
    // 🔴 THE TESTID, NOT `.or(getByText(…))`. An `.or()` against the title text
    // passes even if `hypothesis-row` never renders at all — an assertion that
    // is also true when the thing under test is absent is not an assertion.
    await expect(
      page.locator('[data-testid="hypothesis-row"]').first(),
      "the board rendered no hypothesis-row at all",
    ).toBeVisible();

    // 🔴 KEYED ON THE ID, NEVER ON THE TITLE. The `wolf` project is SHARED and
    // long-lived: every run creates a hypothesis with this same title, so
    // `filter({ hasText: "X1 lifecycle" })` matches every previous run's row
    // too and Playwright fails it as a strict-mode violation —
    // "resolved to 2 elements". Measured: three consecutive runs, identical
    // failure, once a single earlier row survived.
    //
    // The row's link carries the id, which IS unique per run, so this both
    // finds the right row and asserts there is exactly one of it.
    const row = page.locator('[data-testid="hypothesis-row"]').filter({
      has: page.locator(`a[href="/hypotheses/${hyp.id}"]`),
    });
    await expect(row, `expected exactly one board row for ${hyp.id}`).toHaveCount(1);
    await expect(row, "this hypothesis has no row on the board").toBeVisible();

    await page.goto(`/hypotheses/${hyp.id}`);
    // `detail-column` is the left column W13 authors and W14 fills; there is no
    // `detail-page` testid anywhere in `web/src` (an earlier draft of this spec
    // asserted one and failed for that reason alone).
    await expect(page.getByTestId("detail-column")).toBeVisible();
    await expect(page.getByTestId("status-chip").first()).toContainText(/challenged/i);
    await expect(page.getByTestId("verdict-band")).toBeVisible();
    await expect(page.getByTestId("scoreboard")).toBeVisible();
    // W14's condition table, showing the evaluator's own verdict per condition.
    // By TESTID, not by text: "CONDITIONS" appears three times on this page
    // (the section heading, the table's own header, the scoreboard's legend)
    // and a `getByText` is a strict-mode violation rather than an assertion.
    await expect(page.getByTestId("section-conditions")).toBeVisible();

    // The chart Wolf draws itself, from the series proxy.
    await expect(page.getByTestId("metric-charts")).toBeVisible();
    await expect(page.getByTestId("metric-chart").first()).toBeVisible();

    // 🔴 THE CHAT IFRAME. If http://localhost:8091 were missing from the wolf
    // project's `allowed_origins`, the Orange embed page's `frame-ancestors`
    // would block this document outright — which reads as a broken UI rather
    // than as a config error. Asserting the frame has a real document body is
    // what tells the two apart.
    const chatFrame = page.getByTestId("bob-chat-frame");
    await expect(chatFrame).toBeVisible();
    const frame = await chatFrame.elementHandle().then((h) => h?.contentFrame());
    expect(frame, "the embed iframe has no content document — frame-ancestors blocked it").toBeTruthy();
    await expect(
      frame!.locator("body"),
      "the embed page rendered nothing; check allowed_origins",
    ).not.toBeEmpty();
  });

  test("the report frame renders the locked template and its chart", async ({ page }) => {
    await signIn(page);
    await page.goto(`/hypotheses/${hyp.id}`);

    const reportFrame = page.getByTestId("report-frame");
    await expect(reportFrame).toBeVisible({ timeout: 60_000 });
    const frame = await reportFrame.elementHandle().then((h) => h?.contentFrame());
    expect(frame, "the report iframe has no content document").toBeTruthy();

    // The template's own chart, drawn from `window.__WOLF_SERIES__`.
    await expect(frame!.locator("#x1-svg")).toBeAttached();
    await expect(frame!.locator("#x1-caption")).toContainText(/observations/);
    // The mandatory fallback is REMOVED once the chart has drawn. A template
    // that declares it and never removes it shows a permanent failure message.
    await expect(frame!.locator("[data-wolf-fallback]")).toHaveCount(0);
    // The daily slot content the tick wrote.
    await expect(frame!.locator('[data-wolf-slot="headline-note"]')).toContainText(
      /probe series rose/i,
    );

    // 🔴 THE SANDBOX. `sandbox="allow-scripts"` with no `allow-same-origin`,
    // so the framed document's origin is opaque and it can reach nothing of
    // Wolf's. Reading `origin` from inside is the assertion that proves it.
    await expect(reportFrame).toHaveAttribute("sandbox", /allow-scripts/);
    await expect(reportFrame).not.toHaveAttribute("sandbox", /allow-same-origin/);
    const origin = await frame!.evaluate(() => window.origin);
    expect(origin, "the report frame is NOT origin-isolated").toBe("null");
  });

  test("a human verdict tears down the atoms in order and leaves the dataset readable", async ({
    page,
  }) => {
    await signIn(page);

    const res = await wolf<{
      status: string;
      teardown: {
        schedules_deleted: string[];
        worker_deleted: boolean;
        session_deleted: string | null;
        tick_sessions_deleted: string[];
      };
    }>(page.request, "post", `/api/hypotheses/${hyp.id}/verdict`, {
      verdict: "invalidated",
      rationale: "X1: the invalidation condition tripped exactly as the locked scoreboard said it would.",
    });
    expect(res.status, `POST verdict → ${res.text.slice(0, 400)}`).toBe(200);
    expect(res.body.status).toBe("invalidated");

    // TEARDOWN ASSERTED BY OBSERVED EFFECT, never by trusting the report body.
    expect(await workerExists(`researcher-${hyp.id}`)).toBe(false);
    expect(await sessionByName(hyp.sessionName)).toBeNull();
    // Through `allSchedules`, which fails if the listing came back at its cap.
    // This assertion is an ABSENCE, so a truncated page would satisfy it
    // without teardown having happened — see the note on `assertNotTruncated`.
    expect((await allSchedules()).map((s) => s.worker)).not.toContain(`researcher-${hyp.id}`);

    // …AND THE DATASET SURVIVES. Datasets are never torn down: the verdict's
    // own memory carries the evaluation snapshot, but the working data stays
    // readable until the version reaper gets to it.
    const meta = await datasetMeta(hyp.datasetName);
    expect(meta, "the dataset was deleted by teardown — it must not be").not.toBeNull();
    expect(meta!.version).toBeGreaterThanOrEqual(1);

    // The verdict itself is a TRUSTED memory.
    const verdicts = await listMemories(`kind=verdict,name=${hyp.id}`);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts[0]!.created_by_worker).toBe("");
    expect(verdicts[0]!.created_by_session).toBe("");
    expect(verdicts[0]!.labels["status"]).toBe("invalidated");
  });
});
