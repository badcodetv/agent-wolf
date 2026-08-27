/**
 * W26 — the report layer, end to end, against both running stacks.
 *
 * Seven legs, in the order W26's acceptance criteria list them:
 *
 *   1. happy path        the chart draws inside the frame; the headline reaches the board
 *   2. sanitiser         a hostile slot renders as prose, with nothing executable left
 *   3. opaque origin     `window.origin === "null"` inside the frame
 *   4. direct navigation the SAME is true of the frame URL opened as a TOP-LEVEL
 *                        document, where no iframe attribute exists to do it
 *   5. cross-hypothesis  a report labelled for another hypothesis never renders
 *   6. retraction        a hostilely-retracted template still renders, flagged
 *   7. drift             a tick filling an undeclared slot is named, not rendered
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 LEG 4 IS THE ONE THAT IS NOT A DUPLICATE OF LEG 3, AND WHY
 *
 * `ReportPanel` mounts the frame with `sandbox="allow-scripts"`, and W21 ALSO
 * sends `Content-Security-Policy: sandbox allow-scripts` as a header on the
 * document itself. Leg 3 cannot tell those two apart: an opaque origin inside
 * the iframe is what EITHER mechanism produces, so leg 3 passes with the CSP
 * directive deleted.
 *
 * A person pasting the frame URL into an address bar has no iframe, so the
 * attribute cannot apply — and that request is authenticated with the same
 * `wolf_session` cookie. If the header's `sandbox` were the redundant-looking
 * clause someone tidied away, that document would run model-authored script in
 * WOLF'S OWN ORIGIN, with the cookie and every signed-in route in reach. Leg 4
 * navigates to it top-level for exactly that reason. It is the regression test
 * for the hole an earlier draft of the design had.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 EVERY PROHIBITION HERE CARRIES A POSITIVE HALF
 *
 * "no `<script>` in the frame" is also true of a frame that failed to render,
 * of a 404, and of a blank page. So every negative assertion below is paired
 * with a positive one — the document rendered, the chart drew, the prose that
 * was SUPPOSED to survive is on screen — and the payloads in
 * `e2e/mock/build-script.py` are written to make that pairing possible:
 * the hostile slot carries prose that must survive alongside the constructs
 * that must not, and the forged cross-hypothesis report is a WELL-FORMED
 * report, so it would render if the defence were removed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CREDENTIALS
 *
 * Nothing here reads or prints a credential. The two container-side writes use
 * `execInSessionContainer`, which runs the program INSIDE the container where
 * `$SESSION_TOKEN` already lives — the value never crosses onto the host. See
 * the header of `e2e/helpers/x1.ts`.
 */

import { expect, test, type Frame, type Page } from "@playwright/test";
import {
  createAndGoLive,
  execInSessionContainer,
  IN_CONTAINER_RPC,
  listMemories,
  retire,
  signIn,
  waitFor,
  waitForTick,
  wolf,
  WOLF_BASE,
  type LiveHypothesis,
} from "../helpers/x1.js";

test.describe.configure({ mode: "serial" });

// ── The shapes this spec reads off the wire ─────────────────────────────────

interface Tamper {
  reason: "forged_row" | "hostile_retraction" | "cross_hypothesis_write";
  written_by_worker: string;
  written_by_session: string;
  memory_id: string;
}

/** `routes/hypotheses.ts` § ReportBlock, pinned. */
interface ReportBlock {
  has_template: boolean;
  structure_hash: string | null;
  stripped_count: number | null;
  updated_at_ms: number | null;
  drift: { orphan_slots: string[]; unfilled_slots: string[] } | null;
  unreadable: boolean;
  tamper: Tamper[] | null;
}

interface Detail {
  hypothesis: { status: string };
  report: ReportBlock;
}

interface BoardRow {
  id: string;
  headline?: string | null;
  attention_tier?: string | null;
}

/**
 * The four board sections, in `web/src/board/tiers.ts`'s order. A row whose
 * `attention_tier` is not one of these is rendered under NEEDS A HUMAN
 * (`groupByTier`), so this list is also how a spec finds the section a row is
 * really in.
 */
const TIERS = ["needs_human", "watch", "in_interview", "holding"] as const;

// ── The three payloads, mirrored from e2e/mock/build-script.py ──────────────
//
// 🔴 These strings are the CONTRACT between the mock rules table and this
// file, and a typo in either half is a test that asserts nothing. They are
// written once here and referenced everywhere below.

/** Prose the sanitiser MUST leave standing — the positive half of leg 2. */
const HOSTILE_SURVIVES = "W26 sanitiser probe: this sentence must survive.";
/**
 * Every hostile construct in the hostile slot spells `alert(` — inside the
 * `<script>`, and inside the `onerror`/`onclick` handlers. One absence
 * assertion over the whole frame therefore covers all five.
 */
const HOSTILE_EXECUTABLE = "alert(";
/** The remote host the hostile `<img>` and `<a>` point at. `.invalid` never resolves (RFC 2606). */
const HOSTILE_REMOTE_HOST = "w26-hostile.invalid";

/** The slot the drift tick fills and the template does not declare. */
const DRIFT_SLOT_ID = "w26-orphan-note";
/** Text that must appear ONLY in the drift notice, never in the frame. */
const DRIFT_CONTENT = "W26 drift probe";
/** The one slot `TEMPLATE_HTML` declares. */
const DECLARED_SLOT_ID = "headline-note";

/** The clean tick's headline, which the board must show. */
const CLEAN_HEADLINE = /^Probe rate rose to \d+\.\d+; the thesis expected it to fall\.$/;
/** Prose the clean tick writes into the declared slot. */
const CLEAN_SLOT_TEXT = /probe series rose/i;

/** The forged cross-hypothesis report's slot text — well-formed, so it WOULD render. */
const FORGERY_TEXT = "W26 cross-hypothesis forgery: this report was written by another hypothesis.";

// ── Small readers ───────────────────────────────────────────────────────────

async function detail(page: Page, id: string): Promise<Detail> {
  const res = await wolf<Detail>(page.request, "get", `/api/hypotheses/${id}`);
  expect(res.status, `GET /api/hypotheses/${id} → ${res.text.slice(0, 300)}`).toBe(200);
  return res.body;
}

/**
 * The detail route's report block once a `kind=report` memory exists.
 *
 * `waitForTick` waits for the DATASET, and the tick writes its report memory
 * several statements later in the same turn — so a spec that asserted on the
 * report block straight after a tick would read `drift: null` ("no tick has
 * run") on a hypothesis whose tick had run. That is the empty state standing
 * in for a real one, which is the failure `drift`'s three-state design exists
 * to prevent; waiting for the state we actually need is the fix.
 */
async function waitForReport(page: Page, id: string, what: string): Promise<ReportBlock> {
  return waitFor(
    `a report block for ${id} — ${what}`,
    async () => {
      const body = await detail(page, id);
      const report = body.report;
      if (report.has_template !== true) return null;
      if (report.drift === null) return null;
      return report;
    },
    9 * 60_000,
    5_000,
  );
}

/**
 * The report iframe's content frame.
 *
 * 🔴 The `expect(frame).toBeTruthy()` is not ceremony. A frame the browser
 * refused to load (a CSP `frame-ancestors` mismatch, a 404 body) yields a
 * `null` content document, and EVERY `locator(...).toHaveCount(0)` below would
 * then pass against it.
 */
async function reportFrame(page: Page): Promise<Frame> {
  const element = page.getByTestId("report-frame");
  await expect(element, "the report panel never mounted a frame").toBeVisible({ timeout: 60_000 });
  await expect(element).toHaveAttribute("sandbox", /allow-scripts/);
  await expect(element).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const frame = await element.elementHandle().then((h) => h?.contentFrame());
  expect(frame, "the report iframe has no content document").toBeTruthy();
  return frame!;
}

/**
 * The assertions that say "this really is the composed report document", used
 * by every leg that renders a frame. Without them, every absence assertion in
 * this file is satisfied by a blank page.
 */
async function expectFrameRendered(frame: Frame): Promise<void> {
  await expect(frame.locator(".x1-title"), "the template's own markup is not in the frame")
    .toHaveText("X1 probe report");
  await expect(frame.locator("#x1-svg"), "the template's chart element is absent").toBeAttached();
  // The mandatory fallback is removed by the template's own script only after a
  // successful draw, so its ABSENCE is the proof that script executed inside
  // the sandboxed frame — which is also what makes "scripts still run" a fact
  // rather than an assumption when the legs below assert what does NOT run.
  await expect(
    frame.locator("[data-wolf-fallback]"),
    "the fallback element is still present — the template's chart script did not run",
  ).toHaveCount(0);
  await expect(frame.locator("#x1-caption")).toContainText(/observations/);
}

/**
 * Whether this document can reach Wolf's ORIGIN-KEYED client storage.
 * `"GRANTED"` means it is in Wolf's own origin; a `denied:` string means the
 * origin is opaque.
 *
 * 🔴 THIS REPLACED A `document.cookie` CHECK THAT COULD NOT FAIL, and the
 * reason belongs here rather than in a commit message. `wolf_session` is
 * `httpOnly: true` (api/src/auth/session.ts:64), so `document.cookie` never
 * contains it in ANY origin — "the framed document cannot see the session
 * cookie" was therefore equally true of a fully compromised document, which
 * makes it decoration rather than a test.
 *
 * Measured, both ways, against the live rig with `"sandbox allow-scripts"`
 * deleted from `frameCsp`:
 *
 *   in-iframe   origin null                    → origin null                    (unchanged)
 *   top-level   origin null                    → origin http://localhost:8091
 *   top-level   cookie threw                   → cookie not-readable  (NEVER readable — httpOnly)
 *   top-level   localStorage SecurityError     → localStorage ACCESSIBLE
 *
 * Storage is the capability that actually tracks the origin, so it is the one
 * asserted. (`connect-src 'none'` independently blocks fetch, so a network
 * probe would not distinguish the two states either.)
 */
const STORAGE_PROBE = (): string => {
  try {
    window.localStorage.setItem("w26-probe", "1");
    window.localStorage.removeItem("w26-probe");
    return "GRANTED";
  } catch (err) {
    return `denied: ${(err as Error).name}`;
  }
};

type TamperReason = Tamper["reason"];

/** What one hypothesis's report block should say, in full. */
interface ExpectedReport {
  /** Slot ids the tick filled that the template does not declare. */
  orphanSlots: string[];
  /** Slot ids the template declares that the tick left empty. */
  unfilledSlots: string[];
  /** `"clean"` pins `stripped_count === 0`; `"stripped"` pins `> 0`. */
  sanitiser: "clean" | "stripped";
  /** The EXACT set of tamper reasons. `[]` means NONE — see below. */
  tamper: TamperReason[];
}

/**
 * Asserts the WHOLE report block and the WHOLE notice strip, in one place.
 * The caller must already be on `/hypotheses/<id>`.
 *
 * 🔴 WHY THIS IS ONE FUNCTION AND NOT THREE SETS OF INLINE ASSERTIONS.
 *
 * Each leg used to assert whatever its own subject happened to be: the happy
 * path pinned drift AND stripped AND the four notices; the sanitiser leg
 * pinned stripped but never drift; the drift leg pinned drift but never
 * stripped. Every one of those omissions is a defect the suite could not
 * see, and the omissions differed per leg — so no single leg looked thin.
 * That is the divergence shape this project has been caught by repeatedly:
 * a fact asserted in one place and quietly forgotten in a neighbour.
 *
 * 🔴 AND THE WORST OF THEM: NOBODY ASSERTED THE ABSENCE OF TAMPER. The two
 * tamper legs look for their own reason with `.find(...)` and take `.first()`
 * on the notice, and BOTH are satisfied by a list full of spurious extras. A
 * defect that flagged every report in the product as tampered passed all ten
 * legs. `tamper` here is an EXACT set, so `[]` is a real assertion that a
 * healthy hypothesis carries no anomaly at all, and a populated one is an
 * assertion that it carries THAT anomaly and nothing else.
 *
 * With one list, a fact can no longer be pinned in one leg and forgotten in
 * another: there is only one place to forget it, and every caller pays.
 */
async function expectReportState(
  page: Page,
  id: string,
  expected: ExpectedReport,
): Promise<ReportBlock> {
  const report = (await detail(page, id)).report;

  expect(report.has_template, `${id}: no locked template`).toBe(true);
  expect(report.unreadable, `${id}: Wolf could not read what it stored`).toBe(false);

  // Drift, both directions, as SETS — order is document order and not the
  // subject of any leg here.
  expect(report.drift, `${id}: drift is null, which means NO TICK HAS RUN`).not.toBeNull();
  expect([...report.drift!.orphan_slots].sort(), `${id}: orphan slots`).toEqual(
    [...expected.orphanSlots].sort(),
  );
  expect([...report.drift!.unfilled_slots].sort(), `${id}: unfilled slots`).toEqual(
    [...expected.unfilledSlots].sort(),
  );
  const drifted = expected.orphanSlots.length + expected.unfilledSlots.length > 0;

  // 🔴 `null` is a THIRD state ("nobody counted"), not a small number.
  expect(report.stripped_count, `${id}: nobody counted the sanitiser's records`).not.toBeNull();
  if (expected.sanitiser === "clean") {
    expect(report.stripped_count, `${id}: the sanitiser removed something it should not have`).toBe(0);
  } else {
    expect(
      report.stripped_count!,
      `${id}: the sanitiser removed NOTHING from hostile content`,
    ).toBeGreaterThan(0);
  }

  // The exact tamper set. Sorted and de-duplicated so the assertion is about
  // WHICH anomalies exist, not the order the reads happened to witness them.
  const reasons = [...new Set((report.tamper ?? []).map((t) => t.reason))].sort();
  expect(reasons, `${id}: tamper reasons — full array ${JSON.stringify(report.tamper)}`).toEqual(
    [...expected.tamper].sort(),
  );

  // The notice strip, EVERY notice, present or absent. An assertion that a
  // notice is absent is as load-bearing as one that it is shown: a UI that
  // rendered every warning on every report would otherwise pass.
  await expect(page.getByTestId("report-notice-drift")).toHaveCount(drifted ? 1 : 0);
  await expect(page.getByTestId("report-notice-stripped")).toHaveCount(
    expected.sanitiser === "stripped" ? 1 : 0,
  );
  await expect(page.getByTestId("report-notice-unreadable")).toHaveCount(0);
  // `stripped_count` is a real number in every case here, so the "nobody
  // counted" sentence must never appear.
  await expect(page.getByTestId("report-stripped-uncounted")).toHaveCount(0);
  // ONE notice per tamper ENTRY — which is also the invariant that an anomaly
  // is rendered and never dropped.
  await expect(page.getByTestId("report-notice-tamper")).toHaveCount(
    (report.tamper ?? []).length,
  );

  return report;
}

/** Nothing executable survived into the frame, anywhere. */
async function expectNothingExecutable(frame: Frame): Promise<void> {
  const body = await frame.locator("body").innerHTML();
  expect(body, "an inline event handler reached the frame").not.toContain("alert(");
  expect(body, "the hostile remote host reached the frame").not.toContain(HOSTILE_REMOTE_HOST);
  // Scoped to the SLOT, because the template's own inline chart script is
  // legitimate and lives outside it. `data-wolf-slot` survives composition —
  // only a slot's CHILDREN are replaced — so this selector is stable.
  const slot = frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`);
  await expect(slot, "the declared slot is not in the frame at all").toHaveCount(1);
  await expect(slot.locator("script"), "a <script> survived into the slot").toHaveCount(0);
  await expect(slot.locator("img"), "an <img> survived into the slot").toHaveCount(0);
  await expect(slot.locator("a"), "an <a> survived into the slot").toHaveCount(0);
  await expect(slot.locator("[onerror]"), "an onerror handler survived").toHaveCount(0);
  await expect(slot.locator("[onclick]"), "an onclick handler survived").toHaveCount(0);
  // Belt and braces at the DOCUMENT level: no element anywhere in the composed
  // frame carries a handler attribute or fetches from a remote host.
  await expect(frame.locator("[onerror], [onload], [onclick]")).toHaveCount(0);
  await expect(frame.locator('img[src^="https://"]')).toHaveCount(0);
}

// ── The three hypotheses ────────────────────────────────────────────────────

let clean: LiveHypothesis;
let hostile: LiveHypothesis;
let drifting: LiveHypothesis;

test.describe("report layer", () => {
  test("three hypotheses go live: clean, hostile and drifting", async ({ page }) => {
    await signIn(page);

    // Concurrently, because each is an independent nine-step chain and the
    // mock's interview rule keys on a run-scoped marker memory rather than on
    // conversation order — `build-script.py` § "How each container discovers
    // its hypothesis id" is written for exactly this.
    [clean, hostile, drifting] = await Promise.all([
      createAndGoLive(page, {
        title: "W26 report layer — clean",
        thesis: "A probe thesis whose daily report fills the template exactly.",
        interviewMarker: "X1-INTERVIEW-HOLDING",
      }),
      createAndGoLive(page, {
        title: "W26 report layer — hostile slot",
        thesis: "A probe thesis whose daily report fills its slot with hostile HTML.",
        interviewMarker: "W26-INTERVIEW-HOSTILE",
      }),
      createAndGoLive(page, {
        title: "W26 report layer — undeclared slot",
        thesis: "A probe thesis whose daily report fills a slot the template does not declare.",
        interviewMarker: "W26-INTERVIEW-DRIFT",
      }),
    ]);

    // Three DIFFERENT hypotheses, or the legs below are all reading the same
    // one and three of them are vacuous.
    expect(new Set([clean.id, hostile.id, drifting.id]).size).toBe(3);
  });

  test("their first ticks write a dataset and a report each", async ({ page }) => {
    await signIn(page);
    await Promise.all([waitForTick(clean), waitForTick(hostile), waitForTick(drifting)]);
    await Promise.all([
      waitForReport(page, clean.id, "the clean tick"),
      waitForReport(page, hostile.id, "the hostile tick"),
      waitForReport(page, drifting.id, "the drifting tick"),
    ]);
  });

  // ── Leg 1 ────────────────────────────────────────────────────────────────

  test("happy path: the chart renders inside the frame and the headline reaches the board", async ({
    page,
  }) => {
    await signIn(page);

    // The headline on the wire first — it is also what tells us WHICH board
    // section to look in.
    const board = await wolf<BoardRow[]>(page.request, "get", "/api/hypotheses");
    expect(board.status).toBe(200);
    const apiRow = board.body.find((r) => r.id === clean.id);
    expect(apiRow, `${clean.id} is not on the board at all`).toBeDefined();
    expect(apiRow!.headline ?? "", "the board carries no headline for this tick").toMatch(
      CLEAN_HEADLINE,
    );

    // 🔴 THE SECTION HAS TO BE OPENED, AND THIS IS NOT A UI DETAIL.
    // `HypothesisList` groups rows into four tiers and COLLAPSES `holding` by
    // default. A healthy `live` hypothesis with a clean report is exactly a
    // HOLDING row, so its `hypothesis-row` element is not in the DOM at all
    // until the section is expanded, and a locator asserted against the closed
    // board resolves to zero elements until the timeout. (X1's lifecycle spec
    // never hits this: its hypothesis is `challenged`, which is NEEDS A HUMAN,
    // and that section is open.) Measured — this leg failed exactly that way
    // on its first run.
    await page.goto("/");
    const tier = TIERS.includes(apiRow!.attention_tier as (typeof TIERS)[number])
      ? (apiRow!.attention_tier as (typeof TIERS)[number])
      : "needs_human";
    const section = page.getByTestId(`board-section-${tier}`);
    await expect(section, `the board has no ${tier} section`).toBeVisible();
    const toggle = section.getByTestId("board-section-toggle");
    // The `aria-label` IS the open/closed state written down ("Expand …" means
    // closed). Clicking unconditionally would close an already-open section
    // and produce the same zero-element failure from the other direction.
    if (((await toggle.getAttribute("aria-label")) ?? "").startsWith("Expand")) {
      await toggle.click();
    }
    await expect(toggle, `the ${tier} section did not open`).toHaveAttribute(
      "aria-label",
      /^Collapse/,
    );

    // `data-headline-state` is the server's answer rendered as a fact: "absent"
    // is what a row with no report shows, and the row renders a PLACEHOLDER
    // sentence in that case — so asserting the state as well as the text is
    // what stops the placeholder from satisfying this.
    const row = section.locator('[data-testid="hypothesis-row"]').filter({
      has: page.locator(`a[href="/hypotheses/${clean.id}"]`),
    });
    await expect(row, `expected exactly one board row for ${clean.id}`).toHaveCount(1);
    const headline = row.getByTestId("headline");
    await expect(headline).toHaveAttribute("data-headline-state", "present");
    await expect(headline).toHaveText(CLEAN_HEADLINE);

    // The detail page, and the frame.
    await page.goto(`/hypotheses/${clean.id}`);
    const frame = await reportFrame(page);
    await expectFrameRendered(frame);
    await expect(
      frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`),
      "the declared slot did not receive the tick's content",
    ).toContainText(CLEAN_SLOT_TEXT);

    // A clean tick matched the template exactly: no drift, nothing stripped,
    // nothing unreadable and — the assertion this file used to be missing
    // altogether — NO TAMPER. `tamper: []` is exact, so a defect that flagged
    // every report in the product as tampered fails HERE, on the healthy
    // hypothesis, which is the only place it can be caught.
    await expectReportState(page, clean.id, {
      orphanSlots: [],
      unfilledSlots: [],
      sanitiser: "clean",
      tamper: [],
    });
  });

  // ── Leg 3 ────────────────────────────────────────────────────────────────

  test("boundary: the framed document's origin is opaque", async ({ page }) => {
    await signIn(page);
    await page.goto(`/hypotheses/${clean.id}`);
    const frame = await reportFrame(page);
    await expectFrameRendered(frame);

    const origin = await frame.evaluate(() => window.origin);
    expect(origin, "the report frame is NOT origin-isolated").toBe("null");

    // The consequence, stated as a fact rather than left as an inference: a
    // document in an opaque origin cannot reach Wolf's own client storage.
    expect(
      await frame.evaluate(STORAGE_PROBE),
      "the framed document reached Wolf's origin-keyed localStorage",
    ).toBe("denied: SecurityError");
  });

  // ── Leg 4 — the regression test ──────────────────────────────────────────

  test("direct navigation: the CSP sandbox directive, not the iframe attribute, is what isolates the frame", async ({
    page,
  }) => {
    await signIn(page);
    const frameUrl = `${WOLF_BASE}/api/hypotheses/${clean.id}/report/frame`;

    // 1. The HEADER, read off a plain authenticated request. An OBSERVED fact:
    //    the response carries `sandbox allow-scripts` in its CSP.
    const res = await page.request.get(frameUrl);
    expect(res.status(), `GET …/report/frame → ${(await res.text()).slice(0, 200)}`).toBe(200);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp, "the frame response carries no Content-Security-Policy at all").not.toBe("");
    expect(csp, "the CSP has no `sandbox` directive — the frame URL is not safe to open").toContain(
      "sandbox allow-scripts",
    );
    expect(csp).toContain("frame-ancestors 'self'");

    // 2. …and the policy is ONLY a header. A `<meta http-equiv>` copy would
    //    look like a second line of defence while silently ignoring both
    //    `sandbox` and `frame-ancestors` (api/src/report/frame.ts, § "What
    //    this module deliberately does NOT do").
    const html = await res.text();
    expect(html.toLowerCase(), "the document carries a <meta> CSP, which cannot express sandbox")
      .not.toContain("http-equiv=\"content-security-policy\"");

    // 3. THE LEG ITSELF. A TOP-LEVEL navigation — there is no iframe anywhere
    //    in this step, so `sandbox="allow-scripts"` on `ReportPanel`'s element
    //    cannot be what produces the result.
    const navigation = await page.goto(frameUrl);
    expect(navigation, "the navigation produced no response").toBeTruthy();
    expect(navigation!.status()).toBe(200);

    // Positive half: this really is the composed report, not an error page.
    await expectFrameRendered(page.mainFrame());

    // OBSERVED: the top-level document's origin is the opaque one.
    // INFERRED (and it is the point of the leg): the only mechanism left that
    // can produce it is the CSP header's `sandbox` directive.
    const origin = await page.evaluate(() => window.origin);
    expect(
      origin,
      "the frame URL opened as a top-level document is in WOLF'S OWN ORIGIN — the CSP " +
        "`sandbox` directive is missing or ineffective, and model-authored script on this " +
        "page can now reach the session cookie and every signed-in route",
    ).toBe("null");

    // 🔴 The same capability check as leg 3, and the one that MOVES when the
    // directive is deleted: measured GRANTED with `sandbox` removed from the
    // CSP, denied with it present. It sits after the header assertion above,
    // so a `sandbox`-deleting mutation trips that one first — but unlike the
    // cookie check this replaced, it would genuinely fail if it were reached.
    expect(
      await page.evaluate(STORAGE_PROBE),
      "the directly-navigated report reached Wolf's origin-keyed localStorage — it is running " +
        "in Wolf's own origin, not an opaque one",
    ).toBe("denied: SecurityError");
  });

  // ── Leg 2 ────────────────────────────────────────────────────────────────

  test("sanitiser: a hostile slot renders as prose with nothing executable, and the notice is shown", async ({
    page,
  }) => {
    await signIn(page);

    // A script that got through would call `alert`. Playwright auto-dismisses
    // dialogs, so without this listener the loudest possible evidence would be
    // discarded silently.
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    // The server's own count, first. `> 0` — the SIGN is the contract and the
    // magnitude is not (a DOMPurify upgrade moves it).
    await waitForReport(page, hostile.id, "the hostile tick");
    await page.goto(`/hypotheses/${hostile.id}`);

    // 🔴 THE WHOLE BLOCK, not just the half this leg is named after. The
    // hostile tick fills EXACTLY the declared slot, so its drift is the same
    // both-arrays-empty state the happy path pins — and asserting that here
    // is what stops "the sanitiser leg" from being blind to a drift defect
    // that only shows on hostile content. Tamper is `[]` for the same reason
    // it is on the happy path.
    await expectReportState(page, hostile.id, {
      orphanSlots: [],
      unfilledSlots: [],
      sanitiser: "stripped",
      tamper: [],
    });

    // The notice's actual sentence — `expectReportState` pins that exactly one
    // is shown, this pins WHAT it says. A visible empty box satisfies neither.
    await expect(page.getByTestId("report-notice-stripped")).toContainText(
      /content was removed from this report by the sanitiser/i,
    );

    const frame = await reportFrame(page);
    // POSITIVE HALF, and it comes first: the document rendered, the chart drew,
    // and the prose that was supposed to survive is on screen. Everything below
    // is an absence, and absences are free on a page that never rendered.
    await expectFrameRendered(frame);
    await expect(
      frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`),
      "the slot rendered nothing at all — the absences below would be vacuous",
    ).toContainText(HOSTILE_SURVIVES);

    await expectNothingExecutable(frame);
    // Named individually as well, so a failure says WHICH construct got through.
    const slotHtml = await frame
      .locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`)
      .innerHTML();
    expect(slotHtml, "the <script> element survived").not.toContain("<script");
    expect(slotHtml, "script/handler source text survived").not.toContain(HOSTILE_EXECUTABLE);
    expect(slotHtml, "the remote <img> survived").not.toContain("<img");
    expect(slotHtml, "a remote URL survived").not.toContain("https://");

    expect(dialogs, `script from the slot executed: ${JSON.stringify(dialogs)}`).toEqual([]);
  });

  // ── Leg 7 ────────────────────────────────────────────────────────────────

  test("drift: a tick filling an undeclared slot is named in the notice and rendered nowhere", async ({
    page,
  }) => {
    await signIn(page);

    await waitForReport(page, drifting.id, "the drifting tick");
    await page.goto(`/hypotheses/${drifting.id}`);

    // 🔴 THE WHOLE BLOCK. Drift in both directions at once — one orphan, one
    // unfilled — AND `stripped_count: 0`, because this tick's content is clean
    // prose. Pinning the sanitiser here guards the strips-everything direction
    // on a SECOND payload, which the happy path alone cannot do. Tamper `[]`.
    await expectReportState(page, drifting.id, {
      orphanSlots: [DRIFT_SLOT_ID],
      unfilledSlots: [DECLARED_SLOT_ID],
      sanitiser: "clean",
      tamper: [],
    });

    // …and WHAT the notice says. `expectReportState` pins that exactly one is
    // shown; these pin that it names both slots, and names them on the right
    // sides — the two fixes are opposite, so swapping them would be worse than
    // saying nothing.
    const notice = page.getByTestId("report-notice-drift");
    await expect(notice).toContainText(new RegExp(`filled but not declared by the template:.*${DRIFT_SLOT_ID}`));
    await expect(notice).toContainText(
      new RegExp(`declared by the template but not filled:.*${DECLARED_SLOT_ID}`),
    );

    const frame = await reportFrame(page);
    await expectFrameRendered(frame);
    // The orphan is NOT rendered — and the declared slot it did not fill is
    // empty rather than carrying the template's own placeholder children.
    const body = await frame.locator("body").innerHTML();
    expect(body, "the undeclared slot's content was rendered into the frame").not.toContain(
      DRIFT_CONTENT,
    );
    await expect(frame.locator(`[data-wolf-slot="${DRIFT_SLOT_ID}"]`)).toHaveCount(0);
    await expect(
      frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`),
      "the unfilled declared slot must render EMPTY",
    ).toBeEmpty();
  });

  // ── Leg 5 ────────────────────────────────────────────────────────────────
  //
  // Runs after the legs that assert on `clean`'s clean state, because it adds
  // a permanent tamper flag to it.

  test("cross-hypothesis: a report labelled for another hypothesis does not render and is surfaced as tamper", async ({
    page,
  }) => {
    await signIn(page);

    // 🔴 THE WRITER MATTERS, AND IT IS NOT ANY CONTAINER. `isOwnReport`
    // (api/src/hypothesis/store.ts) accepts a report written by EITHER
    // `researcher-<id>` OR the hypothesis's own `hyp-<id>` interview session —
    // so a forgery written from `clean`'s own container would be its OWN
    // report and this leg would prove nothing. It is written from the HOSTILE
    // hypothesis's interview container, whose worker and session match neither
    // clause for `clean`.
    const program =
      IN_CONTAINER_RPC +
      `
# A WELL-FORMED report body: line 1 the headline, the rest a {slotId: html}
# map filling the slot the template really declares. If the cross-hypothesis
# defence were removed, this WOULD render — which is what makes the assertion
# below capable of failing.
created = rpc("memory_create", {
    "labels": {"kind": "report", "name": ${JSON.stringify(clean.id)}},
    "content": ${JSON.stringify(FORGERY_TEXT)} + "\\n" + json.dumps(
        {${JSON.stringify(DECLARED_SLOT_ID)}: "<p>" + ${JSON.stringify(FORGERY_TEXT)} + "</p>"},
        indent=2),
    "embed": False,
})
print(json.dumps({"id": created.get("id"),
                  "created_by_worker": created.get("created_by_worker"),
                  "created_by_session": created.get("created_by_session")}))
`;
    const stdout = await execInSessionContainer(hostile.sessionId, program);
    const forged = JSON.parse(stdout.trim().split("\n").pop()!) as {
      id: string;
      created_by_worker: string;
      created_by_session: string;
    };

    // 🔴 THE PRECONDITION, ASSERTED BEFORE ANYTHING ELSE. A row written with
    // WOLF_API_KEY carries EMPTY provenance and would be a different test; a
    // row written from `clean`'s own session would pass `isOwnReport` and this
    // leg would be asserting that a legitimate report does not render.
    expect(forged.created_by_session, "the forgery carries empty provenance").not.toBe("");
    expect(forged.created_by_session).toBe(hostile.sessionId);
    expect(forged.created_by_session).not.toBe(clean.sessionId);
    expect(forged.created_by_worker).toBe("interviewer");
    expect(forged.created_by_worker).not.toBe(`researcher-${clean.id}`);

    // The row really is in the project, labelled exactly as a real report is.
    const rows = await listMemories(`kind=report,name=${clean.id}`, { includeRetracted: true });
    expect(
      rows.some((r) => r.id === forged.id),
      "the forged report is not in memory — nothing was attacked",
    ).toBe(true);

    // 🔴 ONE READ, THEN PLAIN ASSERTIONS. Removing this defence is immediate,
    // visible damage: the very next request would serve the forgery. Polling
    // for the tamper flag would turn a one-line diagnosis into a timeout that
    // blames the tick pipeline (the D4 lesson `helpers/x1.ts` records).
    await page.goto(`/hypotheses/${clean.id}`);

    // 🔴 THE EXACT SET, not a `.find`. `.find` is satisfied by a list of
    // twenty spurious flags that happens to contain this one, so it cannot
    // tell "the defence works" from "everything is flagged". The happy path
    // pins `[]` on this same hypothesis earlier in the file; this pins that
    // the attack added EXACTLY ONE reason and nothing else.
    const report = await expectReportState(page, clean.id, {
      orphanSlots: [],
      unfilledSlots: [],
      sanitiser: "clean",
      tamper: ["cross_hypothesis_write"],
    });

    // …and that the one flag names the row and the writer, which is what makes
    // it an accusation rather than an alarm.
    const flags = (report.tamper ?? []).filter((t) => t.reason === "cross_hypothesis_write");
    expect(flags, "expected exactly one cross_hypothesis_write flag").toHaveLength(1);
    expect(flags[0]!.memory_id).toBe(forged.id);
    expect(flags[0]!.written_by_session).toBe(hostile.sessionId);

    // …and the frame shows CLEAN's own report, not the forgery. Both halves:
    // the forged text is absent AND the real text is present, so a frame that
    // simply failed to render cannot satisfy this.
    const frame = await reportFrame(page);
    await expectFrameRendered(frame);
    const slot = frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`);
    await expect(slot, "the forged report was RENDERED").not.toContainText(FORGERY_TEXT);
    await expect(slot, "the hypothesis's own report was lost").toContainText(CLEAN_SLOT_TEXT);
  });

  // ── Leg 6 ────────────────────────────────────────────────────────────────

  test("retraction: a template hidden by a hostile retraction still renders, with a tamper warning", async ({
    page,
  }) => {
    await signIn(page);

    // 1. The row to attack: the TRUSTED locked template. Empty provenance is
    //    what identifies it — a forged template would not be the locked one.
    const templates = await listMemories(`kind=report-template,name=${clean.id}`, {
      includeRetracted: true,
    });
    const locked = templates.find(
      (r) => r.created_by_worker === "" && r.created_by_session === "",
    );
    expect(locked, "no trusted report-template to attack").toBeDefined();

    // 2. The attack, from inside a container with that container's own
    //    SESSION_TOKEN. Nothing here reads the token.
    const program =
      IN_CONTAINER_RPC +
      `
created = rpc("memory_create", {
    "labels": {"kind": "w26-hostile-retraction", "name": ${JSON.stringify(clean.id)},
               "retracts": ${JSON.stringify(locked!.id)}},
    "content": "Withdrawing this hypothesis's locked report template. Written from inside a container.",
    "embed": False,
})
print(json.dumps({"id": created.get("id"),
                  "created_by_worker": created.get("created_by_worker"),
                  "created_by_session": created.get("created_by_session")}))
`;
    const stdout = await execInSessionContainer(clean.sessionId, program);
    const retraction = JSON.parse(stdout.trim().split("\n").pop()!) as {
      id: string;
      created_by_worker: string;
      created_by_session: string;
    };

    // 🔴 3. THE ASSERTION THAT MAKES THIS LEG MEAN ANYTHING, AND IT COMES
    //    FIRST. A retraction written with WOLF_API_KEY carries EMPTY
    //    provenance, which Wolf HONOURS BY DESIGN — the template would vanish,
    //    the frame would 404, and a test written that way would "pass" while
    //    proving the opposite of its claim.
    expect(
      retraction.created_by_session,
      "the retraction carries EMPTY provenance — it was not written from inside a container, " +
        "so this leg proves nothing about hostile retraction",
    ).not.toBe("");
    expect(retraction.created_by_session).toBe(clean.sessionId);

    // 4. The attack LANDED: Orange's default read no longer returns the
    //    template. Without this, "the frame still renders" is consistent with
    //    nothing having happened at all.
    const defaultRead = await listMemories(`kind=report-template,name=${clean.id}`);
    expect(
      defaultRead.some((r) => r.id === locked!.id),
      "Orange did not hide the retracted template; this leg is not testing what it claims",
    ).toBe(false);
    const withRetracted = await listMemories(`kind=report-template,name=${clean.id}`, {
      includeRetracted: true,
    });
    expect(withRetracted.some((r) => r.id === locked!.id)).toBe(true);

    // 5. Wolf is unmoved. The template is still served AND the anomaly is named.
    const report = (await detail(page, clean.id)).report;
    expect(
      report.has_template,
      "a hostile retraction removed the locked template — the resurrection attack worked",
    ).toBe(true);
    const flags = (report.tamper ?? []).filter((t) => t.reason === "hostile_retraction");
    expect(
      flags,
      `expected exactly one hostile_retraction on ${clean.id}: ${JSON.stringify(report.tamper)}`,
    ).toHaveLength(1);
    expect(flags[0]!.memory_id).toBe(retraction.id);
    expect(flags[0]!.written_by_session).toBe(clean.sessionId);

    // 6. 🔴 A FRESH COMPOSE, NOT THE CACHE. `composeFor` keys its frame cache
    //    on (structure hash, report memory id, dataset versions) — none of
    //    which a retraction changes — so the frame served immediately after the
    //    attack may be bytes composed BEFORE it. The schedule fires every
    //    minute in this rig, so waiting for the next tick's report to arrive
    //    invalidates the key and forces the retracted template back through
    //    `readTemplate` and `composeFrame`.
    const before = report.updated_at_ms ?? 0;
    await waitFor(
      "a tick after the retraction, so the frame cache key changes and the template is re-read",
      async () => {
        const next = (await detail(page, clean.id)).report;
        return next.updated_at_ms !== null && next.updated_at_ms > before ? next : null;
      },
      9 * 60_000,
      5_000,
    );

    await page.goto(`/hypotheses/${clean.id}`);

    // 🔴 BOTH attacks, and ONLY both. Leg 8 left a `cross_hypothesis_write` on
    // this hypothesis and this leg adds a `hostile_retraction`; the exact set
    // asserts the second attack was caught, the first was not lost, and
    // nothing spurious was invented along the way.
    await expectReportState(page, clean.id, {
      orphanSlots: [],
      unfilledSlots: [],
      sanitiser: "clean",
      tamper: ["cross_hypothesis_write", "hostile_retraction"],
    });

    const frame = await reportFrame(page);
    await expectFrameRendered(frame);
    await expect(
      frame.locator(`[data-wolf-slot="${DECLARED_SLOT_ID}"]`),
      "the retracted template composed an empty report",
    ).toContainText(CLEAN_SLOT_TEXT);
  });

  test("clean up", async ({ page }) => {
    await signIn(page);
    // Every hypothesis this file created, by recorded id. A failure to retire
    // one must not stop the others, so they are settled rather than chained —
    // and `run.sh`'s manifest cleanup is the backstop either way.
    const results = await Promise.allSettled([
      retire(page, clean.id, "W26: report-layer legs finished."),
      retire(page, hostile.id, "W26: report-layer legs finished."),
      retire(page, drifting.id, "W26: report-layer legs finished."),
    ]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.map((r) => (r as PromiseRejectedResult).reason?.message ?? "?")).toEqual([]);
  });
});
