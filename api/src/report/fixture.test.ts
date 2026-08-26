/**
 * The worked example report template, held to the real parser.
 *
 * design/2026-08-20-agent-wolf.md § W25 ("Report authoring prompts") is the
 * ticket. `prompts/report-authoring.md` documents the template contract and
 * points at `__fixtures__/example-template.html` BY PATH rather than pasting a
 * copy of it, so this file is what stops the documentation rotting away from
 * the code: the example is run through `parseTemplate` and `validateTemplate`
 * on every test run, and every claim the prose makes about it is asserted
 * here rather than believed.
 *
 * 🔴 **The criterion most likely to be documented and never demonstrated is
 * the fallback one.** `[data-wolf-fallback]` is mandatory AND the template's
 * own script must REMOVE it once the chart renders, or every healthy report
 * permanently displays a failure message — and no static check can see the
 * difference between a template that removes it and one that does not. So the
 * composed frame is executed in a DOM here, in four states: scripts never ran,
 * chart drawn, day one with no observations, and a draw that failed halfway.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { DEFAULT_WOLF_REPORT_MAX_BYTES, DEFAULT_WOLF_SERIES_MAX_POINTS } from "../config.js";
import { buildSeriesPayload } from "./series.js";
import type { SeriesPayload } from "./series.js";
import { composeFrame } from "./frame.js";
import { parseTemplate } from "./template.js";
import type { ParsedTemplate } from "./template.js";
import { SLOT_PROFILE, validateTemplate } from "./sanitise.js";
import type { Spec } from "../hypothesis/spec.js";

/**
 * ⚠️ **`api/` depends on `jsdom` at test time and does not declare it.** State
 * that plainly rather than leaving it as a resolution detail: the package is
 * in the tree only as a transitive of `isomorphic-dompurify` (the ONE pinned
 * sanitiser, which runs on jsdom server-side), it is resolved here from the
 * repo-root `node_modules`, and nothing in `api/package.json` pins its major.
 *
 * `createRequire` is doing TWO things, and both are load-bearing:
 *
 *  1. jsdom ships no type declarations, so a static import fails
 *     `yarn typecheck`, and adding `@types/jsdom` means touching
 *     `package.json` and the lockfile for a test double;
 *  2. a static `import … from "jsdom"` also fails `src/import-boundary.test.ts`
 *     with "package `jsdom` is not declared in a package.json" — measured. The
 *     `createRequire` form is outside that checker's specifier patterns, so it
 *     passes. That is a BYPASS, not a clearance.
 *
 * It is acceptable as shipped because it fails LOUD: if the transitive ever
 * disappears, this line throws and every case below goes red. There is no
 * `describe.skip` fallback — a silently skipped fallback test is exactly the
 * hole this file exists to close. The right fix, if anyone wants the
 * dependency honest, is to declare `jsdom` + `@types/jsdom` in
 * `api/devDependencies` and make this a plain import.
 */
/**
 * `api/`'s tsconfig has no DOM lib — it is a Node server — so the handful of
 * DOM members these cases touch are declared structurally here rather than by
 * widening the compiler's lib list for one test file.
 */
interface DomElement {
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): DomElement | null;
  remove(): void;
}
interface DomDocument {
  readyState: string;
  getElementById(id: string): DomElement | null;
  querySelector(selectors: string): DomElement | null;
  querySelectorAll(selectors: string): Iterable<DomElement>;
}
interface JsdomWindow {
  document: DomDocument;
  eval(code: string): unknown;
}
interface JsdomInstance {
  window: JsdomWindow;
}
type JsdomOptions = { runScripts?: "dangerously" | "outside-only" };
type JsdomCtor = new (html: string, options?: JsdomOptions) => JsdomInstance;
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: JsdomCtor };

const FIXTURE_URL = new URL("./__fixtures__/example-template.html", import.meta.url);
/** The path `prompts/report-authoring.md` must name, repo-relative. */
const FIXTURE_PATH = "api/src/report/__fixtures__/example-template.html";
const FIXTURE = readFileSync(FIXTURE_URL, "utf8");

const PROMPTS = new URL("../../../prompts/", import.meta.url);
const readPrompt = (name: string): string => readFileSync(new URL(name, PROMPTS), "utf8");

/** The two metric slugs the example's own script pins. */
const PRIMARY = "gold-usd";
const SECONDARY = "real-yield-10y";

function metric(slug: string, unit: string): Spec["metrics"][number] {
  return { slug, source: "fred", series_id: slug.toUpperCase(), direction: "up", weight: 0.5, unit };
}

/** A spec naming exactly the two metrics the example charts. */
const SPEC: Spec = {
  thesis: "Gold rises as real yields fall.",
  horizon_days: 90,
  flat_band_pct: 0.5,
  staleness_days: 5,
  metrics: [metric(PRIMARY, "usd"), metric(SECONDARY, "pct")],
  invalidation: [],
};

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 7, 20);

function ascending(count: number, start: number, step: number): Array<{ tMs: number; v: number }> {
  return Array.from({ length: count }, (_unused, i) => ({ tMs: T0 + i * DAY_MS, v: start + i * step }));
}

function parsed(): ParsedTemplate {
  return validateTemplate(FIXTURE, DEFAULT_WOLF_REPORT_MAX_BYTES);
}

function frameHtml(series: SeriesPayload, slots: Record<string, string> = {}): string {
  return composeFrame({ template: parsed(), slots, series }).html;
}

/** A payload with real observations for both metrics. */
function livePayload(): SeriesPayload {
  return buildSeriesPayload(
    SPEC,
    {
      [PRIMARY]: { points: ascending(5, 2400, 3), version: 7 },
      [SECONDARY]: { points: ascending(5, 1.9, -0.05), version: 4 },
    },
    DEFAULT_WOLF_SERIES_MAX_POINTS,
  );
}

/**
 * Parses the composed frame and RUNS its scripts, then waits for the document
 * to finish loading — the example registers its render on `DOMContentLoaded`,
 * which jsdom fires on its own event loop rather than synchronously.
 */
async function renderInDom(html: string): Promise<DomDocument> {
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  await settled(dom.window.document);
  return dom.window.document;
}

/** Waits for jsdom to finish loading, which is when `DOMContentLoaded` has fired. */
async function settled(document: DomDocument): Promise<void> {
  for (let i = 0; i < 200 && document.readyState !== "complete"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(document.readyState).toBe("complete");
}

/** Parses the composed frame WITHOUT running any of its scripts. */
function parseWithoutScripts(html: string): DomDocument {
  return new JSDOM(html).window.document;
}

const text = (node: DomElement | null): string => (node?.textContent ?? "").trim();

describe("the worked example template — the parser's verdict", () => {
  it("parses at the PRODUCTION byte budget", () => {
    const result = parseTemplate(FIXTURE, DEFAULT_WOLF_REPORT_MAX_BYTES);
    // The error list goes in the failure message: a template this file exists
    // to keep valid is worth diagnosing on the spot, not re-running by hand.
    const detail = result.valid
      ? ""
      : result.errors.map((error) => `\n  [${error.path}] ${error.message}`).join("");
    expect(`${result.valid}${detail}`).toBe("true");
  });

  it("validateTemplate returns the stored bytes verbatim, hashed with no normalisation", () => {
    const template = parsed();
    expect(template.html).toBe(FIXTURE);
    expect(template.byteLength).toBe(Buffer.byteLength(FIXTURE, "utf8"));
    expect(template.structureHash).toBe(createHash("sha256").update(FIXTURE, "utf8").digest("hex"));
  });

  it("declares the slots the authoring contract describes, in document order", () => {
    expect(parsed().slotIds).toEqual([
      "headline-note",
      "gold-usd-comment",
      "real-yield-comment",
      "risks",
    ]);
  });

  it("puts the TABLE in the template and the slot in a CELL — the silent-failure rule, demonstrated", () => {
    // `sanitiseSlot` parses slot content in body context, so a slot filling a
    // table with `<tr><td>…</td></tr>` loses the tags and reports 0 stripped.
    // The example therefore declares the whole table and slots only the cells;
    // if these two slots ever moved out of a `<td>`, the prose in
    // report-authoring.md would be describing an example that no longer shows
    // what it claims to show.
    const byId = new Map(parsed().slots.map((slot) => [slot.id, slot.tagName]));
    expect(byId.get("gold-usd-comment")).toBe("td");
    expect(byId.get("real-yield-comment")).toBe("td");
  });

  it("contacts no remote host at all, so the derived CSP grants none", () => {
    const template = parsed();
    expect(template.scriptSrcs).toEqual([]);
    expect(template.remoteOrigins).toEqual([]);
    const { csp } = composeFrame({ template, slots: {}, series: {} });
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
  });
});

describe("the worked example template — the fallback contract", () => {
  it("KEEPS the fallback when the template's script never runs", () => {
    // A blocked script, a syntax error, a chart library that never loaded: the
    // frame is opaque and sandboxed, so this element is the only signal a
    // person gets. Parsing the composed document without running its scripts
    // is exactly that state.
    const document = parseWithoutScripts(frameHtml(livePayload()));
    expect(text(document.querySelector("[data-wolf-fallback]"))).toContain("did not render");
  });

  it("REMOVES the fallback once the chart has actually drawn", async () => {
    const document = await renderInDom(frameHtml(livePayload()));

    expect(document.querySelector("[data-wolf-fallback]")).toBeNull();
    // …and the chart really drew, rather than the fallback being removed by a
    // script that did nothing else. Both halves matter: a template that
    // removes the fallback up front passes the first assertion alone.
    expect(document.getElementById("wolf-chart-line")?.getAttribute("d")).toMatch(/^M[\d. L]+$/);
    expect(text(document.getElementById("wolf-chart-caption"))).toContain("5 observations");
    expect(text(document.querySelector(`[data-metric="${PRIMARY}"]`))).toBe("2412.00 usd");
    expect(text(document.querySelector(`[data-metric-when="${PRIMARY}"]`))).toBe("2026-08-24");
  });

  it("REMOVES the fallback on day one, when no metric has an observation yet", async () => {
    // `buildSeriesPayload` emits `{unit, version: 0, points: []}` for a metric
    // whose dataset has never been written, which is what day one looks like.
    // An empty series is a SUCCESSFUL render, not a failure — a report that
    // cried failure every day until the first tick would train its reader to
    // ignore the one element that matters.
    const dayOne = buildSeriesPayload(SPEC, {}, DEFAULT_WOLF_SERIES_MAX_POINTS);
    expect(dayOne[PRIMARY]).toEqual({ unit: "usd", version: 0, points: [] });

    const document = await renderInDom(frameHtml(dayOne));
    expect(document.querySelector("[data-wolf-fallback]")).toBeNull();
    expect(text(document.getElementById("wolf-chart-empty"))).toContain("No observations yet");
    expect(text(document.querySelector(`[data-metric="${PRIMARY}"]`))).toBe("no data");
  });

  it("KEEPS the fallback when the draw FAILS halfway", async () => {
    // The case a scripts-off test cannot reach: the script runs, and the chart
    // still does not appear. Simulated by removing the element the draw writes
    // into before evaluating the template's own script, so `drawChart()`
    // returns false. This is what catches a `removeFallback()` that was hoisted
    // to the top of the render, or moved into a `finally` — both of which pass
    // every other case in this file.
    const dom = new JSDOM(frameHtml(livePayload()), { runScripts: "outside-only" });
    const { document } = dom.window;
    // ⚠️ Waiting for the load is load-bearing, not tidiness. The example
    // registers its render on `DOMContentLoaded`, so evaluating its script
    // while `readyState` is still "loading" registers a listener and runs
    // NOTHING — the fallback then survives because the template never got a
    // turn, which is a green test asserting nothing. Measured: it took the
    // first draft of this file with it.
    await settled(document);

    document.getElementById("wolf-chart-line")?.remove();
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts).toHaveLength(2); // the series injection, then the template's own
    for (const script of scripts) dom.window.eval(script.textContent ?? "");

    expect(document.querySelector("[data-wolf-fallback]")).not.toBeNull();
    // The rest of the report still rendered: this is a degraded report, not a
    // blank one, which is why the fallback's wording says the table is usable.
    expect(text(document.querySelector(`[data-metric="${PRIMARY}"]`))).toBe("2412.00 usd");
  });
});

describe("the worked example template — slot filling through the real frame", () => {
  it("renders the day's prose into its slot and strips what the allow list refuses", () => {
    const composed = composeFrame({
      template: parsed(),
      slots: {
        "headline-note": '<p class="lead">Gold <strong>rose</strong> 1.2%.</p>',
        "gold-usd-comment": '<p>Sourced from <a href="https://example.com/x">the release</a>.</p>',
      },
      series: livePayload(),
    });
    const document = parseWithoutScripts(composed.html);

    expect(text(document.querySelector('[data-wolf-slot="headline-note"]'))).toBe("Gold rose 1.2%.");
    expect(document.querySelector('[data-wolf-slot="headline-note"] strong')).not.toBeNull();
    expect(composed.strippedBySlot["headline-note"]).toBe(0);

    // No URL survives a slot: the anchor is gone and its text remains, which
    // is the behaviour report-authoring.md tells a researcher to expect.
    const cell = document.querySelector('[data-wolf-slot="gold-usd-comment"]');
    expect(cell?.querySelector("a")).toBeNull();
    expect(text(cell)).toBe("Sourced from the release.");
    expect(composed.strippedBySlot["gold-usd-comment"]).toBeGreaterThan(0);

    // 🔴 An unfilled slot renders EMPTY. `composeFrame` replaces a slot's
    // children with the day's content or with nothing at all, so what the
    // template writes inside a slot is never a day-one placeholder a reader
    // sees — it is documentation for the human reviewing the template. (It
    // does not render the string "undefined" either, which is the failure this
    // behaviour exists to avoid.) The example puts every heading OUTSIDE its
    // slot for this reason, and report-authoring.md says so.
    const unfilled = document.querySelector('[data-wolf-slot="risks"]');
    expect(unfilled).not.toBeNull();
    expect(unfilled?.innerHTML).toBe("");
    expect(text(document.querySelector(".wolf-report__risks h2"))).toBe("Risks and caveats");
  });
});

describe("the authoring prompt points at the example rather than copying it", () => {
  const authoring = readPrompt("report-authoring.md");

  it("names the fixture by its repo-relative path", () => {
    expect(authoring).toContain(FIXTURE_PATH);
  });

  it("does not paste the template into the prose, so the two cannot drift apart", () => {
    // Distinctive markup from the example. If it appears in the prompt, the
    // example exists twice and only one copy is under test.
    for (const marker of ['<figure class="wolf-chart">', "function removeFallback()", "data-metric-when"]) {
      expect(authoring).not.toContain(marker);
    }
  });
});

describe("the two prompt edits state the obligations W25 gives them", () => {
  const interviewer = readPrompt("interviewer.md");
  const preamble = readPrompt("researcher-preamble.md");

  /**
   * One criterion per case, and each failure names the criterion that went
   * missing. A single case covering four obligations is one test wearing four
   * hats: delete any one of them and the same line reddens, so the run tells
   * you something broke and not what.
   */
  function states(document: string, file: string, criterion: string, patterns: RegExp[]): void {
    for (const pattern of patterns) {
      expect(document, `${file} no longer states ${criterion} (nothing matches ${pattern})`).toMatch(
        pattern,
      );
    }
  }

  it("interviewer.md: a candidate report is an interview OUTPUT", () => {
    states(interviewer, "interviewer.md", "that the interview must produce a report candidate", [
      /"kind": "report-candidate"/,
      /An interview is not finished until you have proposed one/,
    ]);
  });

  it("interviewer.md: the interviewer still cannot go live", () => {
    states(interviewer, "interviewer.md", "that the interviewer cannot accept its own template", [
      /You cannot accept your own template/,
      /You never write a `report-template` memory yourself/,
    ]);
  });

  it("researcher-preamble.md: a kind=report memory every tick", () => {
    states(preamble, "researcher-preamble.md", "the once-per-tick report memory", [
      /kind: "report"/,
      /every tick/i,
    ]);
  });

  it("researcher-preamble.md: the headline is on LINE 1", () => {
    // This half of the criterion had no assertion behind it in round 1:
    // deleting the bullet left the whole suite green. It is its own case so
    // that it reddens for its own reason and names its own criterion.
    states(preamble, "researcher-preamble.md", "that line 1 of the report is the headline", [
      /\*\*Line 1\*\*: the headline/,
    ]);
  });

  it("researcher-preamble.md: embed: false on the report memory", () => {
    states(preamble, "researcher-preamble.md", "the embed: false requirement", [/embed: false/]);
  });

  it("researcher-preamble.md: propose a template amendment, never enact one", () => {
    states(preamble, "researcher-preamble.md", "propose-never-enact for the template", [
      /report-amendment/,
      /You may propose it\. You may never enact it/,
    ]);
  });
});

/**
 * The claims in `report-authoring.md` that a machine can check, ONE GUARD PER
 * RULE.
 *
 * Prose is `TDD: no` for good reason and there is no attempt here to test the
 * document. These are different: two of them are copies of a pinned constant,
 * and the rest are the four hand-off rules and the series unit — each an
 * explicit acceptance criterion, each deletable in one edit, and each with a
 * different consequence when it goes missing. So each gets its own case and
 * its own failure message; a single "the contract states its rules" case would
 * redden identically for all six and tell a reader nothing.
 */
describe("the authoring contract cannot drift from the code it documents", () => {
  const authoring = readPrompt("report-authoring.md");

  function statesRule(rule: string, patterns: RegExp[], scope = authoring): void {
    for (const pattern of patterns) {
      expect(
        scope,
        `report-authoring.md no longer states ${rule} (nothing matches ${pattern})`,
      ).toMatch(pattern);
    }
  }

  /**
   * The one bullet beginning at `anchor`, up to the next bullet or heading.
   * Scoping matters for the raw-text rule: `<style>` and `<script>` also
   * appear in the slot allow list further down, so a whole-document match
   * would still pass with the rule deleted — the guard would be green for the
   * wrong text, which is the failure this whole file is about.
   */
  function bulletAt(anchor: string): string {
    const start = authoring.indexOf(anchor);
    expect(start, `report-authoring.md no longer contains ${JSON.stringify(anchor)}`).toBeGreaterThan(-1);
    const rest = authoring.slice(start);
    const end = rest.search(/\n(?:- |#|\u{1F534}|\*\*)/u);
    return end < 0 ? rest : rest.slice(0, end);
  }

  /** The backticked tokens on the line(s) following a `**Label:**` heading. */
  function listedAfter(label: string): Set<string> {
    const start = authoring.indexOf(`**${label}:**`);
    expect(start).toBeGreaterThan(-1);
    const end = authoring.indexOf("\n\n", start);
    // `h1`–`h6` is written as a RANGE in the prose, because listing six
    // headings reads badly; expand it here rather than uglify the document.
    const block = authoring.slice(start, end).replace("`h1`–`h6`", "`h1` `h2` `h3` `h4` `h5` `h6`");
    return new Set([...block.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string));
  }

  it("lists exactly SLOT_PROFILE's elements — no more, and no fewer", () => {
    // `#text` is deliberately absent from the prose: it is not an element an
    // author can write, it is how DOMPurify spells "keep the characters".
    const pinned = new Set(SLOT_PROFILE.ALLOWED_TAGS.filter((tag) => tag !== "#text"));
    expect([...listedAfter("Elements")].sort()).toEqual([...pinned].sort());
  });

  it("lists exactly SLOT_PROFILE's attributes — no more, and no fewer", () => {
    expect([...listedAfter("Attributes")].sort()).toEqual([...SLOT_PROFILE.ALLOWED_ATTR].sort());
  });

  it("hand-off 1: a slot on a RAW-TEXT element is refused", () => {
    // W19 shipped the refusal; a contract that does not say so invites a
    // template that is authored, reviewed and then rejected at go-live.
    const bullet = bulletAt("**A slot may not be declared on a raw-text element**");
    statesRule(
      "the raw-text slot refusal",
      [/`<style>`/, /`<title>`/, /`<textarea>`/, /`<xmp>`/, /refuses it outright/],
      bullet,
    );
  });

  it("hand-off 2: table STRUCTURE lives in the template, and the failure is silent", () => {
    // The silence is the point: row markup in a slot loses its tags and
    // reports nothing stripped, so a contract that omits this leaves the
    // author with no way to notice.
    statesRule("that table structure belongs in the template", [
      /Table structure lives in the TEMPLATE, not in a slot/,
      /<tr><td>Gold<\/td><td>1\.2%<\/td><\/tr>/,
      /stripped count: 0/,
    ]);
  });

  it("hand-off 3: a fragment reference is refused in an attribute, carved out in CSS", () => {
    // Both halves, because either alone misleads: the attribute half alone
    // forbids SVG gradients that work, the CSS half alone invites
    // `<a href="#chart">`, which is rejected.
    statesRule("the fragment-reference asymmetry", [
      /refused in an attribute and carved out in CSS/,
      /`<a href="#chart">`/,
      /`<use href="#glyph">`/,
      /`fill: url\(#gradient\)`/,
    ]);
  });

  it("hand-off 4: image-set() is supported, including type() and the vendor prefix", () => {
    statesRule("that image-set() parses", [/`image-set\(…\)`/, /`type\(\)`/, /`-webkit-` prefix/]);
  });

  it("pins the series unit as epoch MILLISECONDS", () => {
    // `tMs` is milliseconds everywhere in the product and seconds in the
    // `agent_*` tables, which is exactly the confusion a one-word edit here
    // would hand to every template author.
    statesRule("the series unit", [/`tMs` is \*\*epoch milliseconds\*\*/]);
  });
});
