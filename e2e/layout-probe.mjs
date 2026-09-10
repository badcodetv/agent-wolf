#!/usr/bin/env node
/**
 * layout-probe — MEASURE the running UI's layout instead of guessing at it.
 *
 *   node e2e/layout-probe.mjs <hypothesis-id> [screenshot.png]
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Two layout bugs were reported from screenshots and both were misdiagnosed by
 * reading the code. The reports were "we scroll sideways to reach Send" and
 * "there's an unnecessary vertical scroll", and the plausible-looking culprits
 * — the rail's width, the shell's height, the composer's textarea — were all
 * either innocent or only half the story. What actually found it was measuring
 * `scrollWidth` against `clientWidth` on both documents and then walking the
 * ancestor chain printing computed `min-width`.
 *
 * 🔴 **The chat panel is a CROSS-ORIGIN iframe** (Wolf on :8081 embedding
 * Orange on :8080), so page JavaScript cannot see inside it — `contentDocument`
 * throws. Playwright can: `page.frames()` reaches every frame regardless of
 * origin, which is the whole reason this is a Playwright script and not a
 * snippet in the console.
 *
 * ── What it found, kept here as the worked example ──────────────────────────
 *
 * At a 459px rail the embed document measured `scrollWidth 628 / clientWidth
 * 459`. Walking up from the composer `<form>`:
 *
 *     div w=628 minW=auto  flex=1 1 0%  <- the culprit: min-content floor
 *     div w=628 minW=0px   flex=1 1 0%  <- already had minWidth: 0
 *     form w=628
 *
 * A flex item defaults to `min-width: auto`, i.e. its min-content width, and
 * refuses to shrink below it. `AgentChat`'s chat COLUMN carried `minWidth: 0`;
 * its root ROW did not. A shrinkable child inside an unshrinkable parent
 * shrinks nothing — which is why the panel looked fixed after the first
 * attempt and was not.
 *
 * ── Requirements ───────────────────────────────────────────────────────────
 *
 * The stack must be up with the password login mounted, because Playwright
 * cannot obtain a real Google ID token:
 *
 *     WOLF_TEST_LOGIN="you@example.com:somepassword" \
 *       ../agent-bob/stack wolf up --skip-image
 *
 * It loads an EXISTING hypothesis and sends no message, so it makes no model
 * call and bills nothing.
 */

import { chromium } from "playwright";

const WOLF = process.env.WOLF_BASE ?? "http://localhost:8081";
const EMAIL = process.env.WOLF_LOGIN_EMAIL ?? "";
const PASSWORD = process.env.WOLF_LOGIN_PASSWORD ?? "";
const ID = process.argv[2];
const SHOT = process.argv[3];

if (!ID) {
  console.error("usage: node e2e/layout-probe.mjs <hypothesis-id> [screenshot.png]");
  console.error("  WOLF_LOGIN_EMAIL / WOLF_LOGIN_PASSWORD must match WOLF_TEST_LOGIN");
  process.exit(2);
}
if (!EMAIL || !PASSWORD) {
  console.error("set WOLF_LOGIN_EMAIL and WOLF_LOGIN_PASSWORD (the two halves of WOLF_TEST_LOGIN)");
  process.exit(2);
}

// A range, not one size. Both bugs were width-dependent and invisible at the
// width their author happened to be looking at.
const SIZES = [
  [1908, 950],
  [1440, 900],
  [1100, 800],
  [900, 800],
];

const browser = await chromium.launch();
let failures = 0;

for (const [width, height] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${WOLF}/`);
  await page.evaluate(
    async ([email, password]) => {
      await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    },
    [EMAIL, PASSWORD],
  );
  await page.goto(`${WOLF}/hypotheses/${ID}`);
  // The frame mints an embed token and loads a transcript; there is no event
  // to wait on from out here.
  await page.waitForTimeout(5000);

  const outer = await page.evaluate(() => {
    const de = document.documentElement;
    const rail = document.querySelector('[data-testid="chat-rail"]');
    return {
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      scrollH: de.scrollHeight,
      clientH: de.clientHeight,
      railW: rail === null ? null : Math.round(rail.getBoundingClientRect().width),
      railMode: rail === null ? null : rail.getAttribute("data-rail-mode"),
    };
  });

  const frame = page.frames().find((f) => f.url().includes("/embed/session/"));
  const inner =
    frame === undefined
      ? null
      : await frame.evaluate(() => {
          const de = document.documentElement;
          // Anything wider than the viewport, worst first — the shortlist of
          // suspects, so a failure names them instead of just measuring.
          const overWide = [...document.querySelectorAll("*")]
            .map((el) => ({
              w: Math.round(el.getBoundingClientRect().width),
              tag: el.tagName.toLowerCase(),
              minW: getComputedStyle(el).minWidth,
            }))
            .filter((r) => r.w > de.clientWidth)
            .sort((a, b) => b.w - a.w)
            .slice(0, 5);
          return { scrollW: de.scrollWidth, clientW: de.clientWidth, overWide };
        });

  const docOk = outer.scrollW === outer.clientW && outer.scrollH === outer.clientH;
  const frameOk = inner === null || inner.scrollW <= inner.clientW;
  if (!docOk || !frameOk) failures += 1;

  console.log(
    `${String(width).padStart(4)}x${height}  rail=${String(outer.railW).padStart(4)} (${outer.railMode})` +
      `  doc ${outer.scrollW}/${outer.clientW} ${outer.scrollH}/${outer.clientH} ${docOk ? "OK" : "OVERFLOW"}` +
      `  frame ${inner === null ? "-" : `${inner.scrollW}/${inner.clientW}`} ${frameOk ? "OK" : "SIDEWAYS"}`,
  );
  if (inner !== null && inner.overWide.length > 0) {
    for (const r of inner.overWide) {
      console.log(`        over-wide: <${r.tag}> ${r.w}px  min-width: ${r.minW}`);
    }
  }

  if (SHOT !== undefined && width === SIZES[0][0]) {
    await page.screenshot({ path: SHOT });
    console.log(`        screenshot → ${SHOT}`);
  }
  await page.close();
}

await browser.close();
// Non-zero on any overflow: a probe that always exits 0 is a report, not a check.
process.exit(failures === 0 ? 0 : 1);
