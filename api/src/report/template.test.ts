import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WolfError } from "../errors.js";
import {
  SLOT_ID_PATTERN,
  parseTemplate,
  structureHash,
  templateValidationError,
  type ParsedTemplate,
  type TemplateError,
} from "./template.js";

/** Comfortably above every fixture below; the size rule has its own block. */
const BIG = 1_000_000;

const VALID = [
  '<section class="wolf-report">',
  '  <div data-wolf-fallback>The chart did not render.</div>',
  '  <h2 data-wolf-slot="headline"></h2>',
  '  <div data-wolf-slot="commentary"><p>placeholder</p></div>',
  '  <link rel="stylesheet" href="https://cdn.example.com/chart.css">',
  '  <script src="https://cdn.example.com/chart.js"></script>',
  "  <script>",
  "    window.__WOLF_SERIES__ && document.querySelector('[data-wolf-fallback]').remove();",
  "  </script>",
  "</section>",
].join("\n");

function parseOk(html: string, maxBytes = BIG): ParsedTemplate {
  const result = parseTemplate(html, maxBytes);
  if (!result.valid) {
    throw new Error(`expected a valid template, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.template;
}

function errorsOf(html: string, maxBytes = BIG): TemplateError[] {
  const result = parseTemplate(html, maxBytes);
  if (result.valid) throw new Error("expected parseTemplate to reject this template");
  return result.errors;
}

/** Every error message joined, for "the failure says X" assertions. */
function messages(html: string, maxBytes = BIG): string {
  return errorsOf(html, maxBytes)
    .map((e) => `${e.path}: ${e.message}`)
    .join("\n");
}

/** Wraps a fragment in the minimum a template needs to be otherwise valid. */
function withFallback(fragment: string): string {
  return `<div data-wolf-fallback>no chart</div>\n${fragment}`;
}

describe("parseTemplate — the happy path and the shape it returns", () => {
  it("accepts a well-formed fragment and returns its slots, hash and external URLs", () => {
    const template = parseOk(VALID);
    expect(template.html).toBe(VALID);
    expect(template.slotIds).toEqual(["headline", "commentary"]);
    expect(template.byteLength).toBe(Buffer.byteLength(VALID, "utf8"));
    expect(template.structureHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts slot ids in DOCUMENT ORDER, not sorted and not source-of-declaration order", () => {
    const html = withFallback(
      '<div data-wolf-slot="zulu"></div><div data-wolf-slot="alpha"></div><div data-wolf-slot="mike"></div>',
    );
    expect(parseOk(html).slotIds).toEqual(["zulu", "alpha", "mike"]);
  });

  it("finds a slot however its attribute is cased and however the value is quoted", () => {
    const html = withFallback(
      "<section><ul><li DATA-WOLF-SLOT=outer></li></ul></section><span data-wolf-slot='inner-x'></span>",
    );
    expect(parseOk(html).slotIds).toEqual(["outer", "inner-x"]);
  });

  it("records each slot's content range, so a filler can replace children without touching the rest", () => {
    const html = withFallback('<div data-wolf-slot="headline">OLD</div>');
    const template = parseOk(html);
    const slot = template.slots[0];
    expect(slot?.id).toBe("headline");
    expect(html.slice(slot?.contentStart ?? 0, slot?.contentEnd ?? 0)).toBe("OLD");
  });

  it("accepts a slot with no children at all (an empty element is the normal unfilled state)", () => {
    expect(parseOk(withFallback('<div data-wolf-slot="headline"></div>')).slotIds).toEqual([
      "headline",
    ]);
  });

  it("is pure: it reads no configuration and no environment", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "template.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/from\s+"\.\.\/config\.js"/);
    expect(source).not.toMatch(/loadConfig/);
  });

  it("takes the limit as a PARAMETER: the same bytes pass under one limit and fail under another", () => {
    const size = Buffer.byteLength(VALID, "utf8");
    expect(parseTemplate(VALID, size).valid).toBe(true);
    expect(parseTemplate(VALID, size - 1).valid).toBe(false);
  });
});

describe("parseTemplate — slot ids", () => {
  it("rejects a DUPLICATE slot id, naming it — last-wins would make drift undetectable", () => {
    const html = withFallback(
      '<div data-wolf-slot="headline"></div><p data-wolf-slot="headline"></p>',
    );
    const text = messages(html);
    expect(text).toMatch(/duplicate/i);
    expect(text).toContain("headline");
    // …and the failure is about the DUPLICATE, not about the id being malformed.
    expect(text).not.toMatch(/must match/i);
  });

  it("SLOT_ID_PATTERN is exactly ^[a-z][a-z0-9-]{0,31}$", () => {
    expect(SLOT_ID_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,31}$");
  });

  it.each([
    ["Headline", "an uppercase letter"],
    ["1chart", "a leading digit"],
    ["-chart", "a leading hyphen"],
    ["chart_1", "an underscore"],
    ["chart.1", "a dot"],
    ["chart 1", "a space"],
    ["", "an empty value"],
    ["a".repeat(33), "33 characters — one over the cap"],
  ])("rejects the slot id %j (%s), naming it", (id) => {
    const html = withFallback(`<div data-wolf-slot="${id}"></div>`);
    const text = messages(html);
    expect(text).toMatch(/slot id/i);
    if (id !== "") expect(text).toContain(id);
  });

  it.each([["a"], ["chart"], ["chart-1"], ["a".repeat(32)]])(
    "accepts the slot id %j",
    (id) => {
      expect(parseOk(withFallback(`<div data-wolf-slot="${id}"></div>`)).slotIds).toEqual([id]);
    },
  );

  it("rejects a slot NESTED inside another slot — two fillers would fight over the same bytes", () => {
    const html = withFallback(
      '<div data-wolf-slot="outer"><span data-wolf-slot="inner"></span></div>',
    );
    expect(messages(html)).toMatch(/nested/i);
  });

  it("rejects a slot element that is never closed", () => {
    expect(messages(withFallback('<div data-wolf-slot="headline">'))).toMatch(/never closed/i);
  });

  it("rejects a slot on a VOID element, which can hold no filled content", () => {
    expect(messages(withFallback('<img data-wolf-slot="headline" src="https://x.test/a.png">'))).toMatch(
      /void|children|container/i,
    );
  });
});

describe("parseTemplate — the template is a FRAGMENT", () => {
  it.each([
    ["<!doctype html>", /doctype/i],
    ["<!DOCTYPE HTML>", /doctype/i],
    ["<html></html>", /<html>/i],
    ["<HTML>", /<html>/i],
    ["<head><title>t</title></head>", /<head>/i],
    ["<body>x</body>", /<body>/i],
    ["</body>", /<body>/i],
  ])("rejects %j — composeFrame owns the document skeleton", (skeleton, pattern) => {
    expect(messages(withFallback(skeleton))).toMatch(pattern);
  });

  it("does not mistake the WORD body inside text or a script for a body element", () => {
    const html = withFallback(
      "<p>the body of the argument</p><script>var body = document.body;</script>",
    );
    expect(parseOk(html).slotIds).toEqual([]);
  });

  it("reports ONE error per skeleton ELEMENT, not one per tag", () => {
    // `<body>x</body>` is a single mistake. A review screen printing it twice
    // reads as two, and the reporting contract is one path per finding.
    const bodyErrors = errorsOf(withFallback("<body>x</body>")).filter((e) => e.path === "body");
    expect(bodyErrors).toHaveLength(1);
  });

  it("still reports a stray end tag that never had a start tag", () => {
    const bodyErrors = errorsOf(withFallback("</body>")).filter((e) => e.path === "body");
    expect(bodyErrors).toHaveLength(1);
  });

  it("reports two separate <body> elements twice", () => {
    const bodyErrors = errorsOf(withFallback("<body>a</body><body>b</body>")).filter(
      (e) => e.path === "body",
    );
    expect(bodyErrors).toHaveLength(2);
  });
});

describe("parseTemplate — every src and href must be https:", () => {
  it("accepts https:", () => {
    expect(parseOk(withFallback('<script src="https://cdn.example.com/c.js"></script>')).scriptSrcs)
      .toEqual(["https://cdn.example.com/c.js"]);
  });

  it("rejects http: with its OWN message", () => {
    expect(messages(withFallback('<script src="http://cdn.example.com/c.js"></script>'))).toMatch(
      /`http:`/,
    );
  });

  it("rejects a protocol-relative //host with its OWN message", () => {
    const text = messages(withFallback('<script src="//cdn.example.com/c.js"></script>'));
    expect(text).toMatch(/protocol-relative/i);
    expect(text).not.toMatch(/`http:`/);
  });

  it("rejects javascript: with its OWN message", () => {
    const text = messages(withFallback('<a href="javascript:alert(1)">x</a>'));
    expect(text).toMatch(/`javascript:`/);
    expect(text).not.toMatch(/protocol-relative/i);
    expect(text).not.toMatch(/`http:`/);
  });

  it("the three messages are genuinely DISTINCT, not one shared 'bad URL'", () => {
    const http = messages(withFallback('<img src="http://h.test/a.png">'));
    const relative = messages(withFallback('<img src="//h.test/a.png">'));
    const js = messages(withFallback('<a href="javascript:0">x</a>'));
    expect(new Set([http, relative, js]).size).toBe(3);
  });

  it("permits data: on an img — and ONLY on an img", () => {
    expect(parseOk(withFallback('<img src="data:image/gif;base64,R0lGOD">')).slotIds).toEqual([]);
    const text = messages(withFallback('<script src="data:text/javascript,alert(1)"></script>'));
    expect(text).toMatch(/`data:`/);
    expect(text).toMatch(/img/i);
  });

  it("checks the ELEMENT, not just the scheme: data: on an <a href> is still rejected", () => {
    expect(messages(withFallback('<a href="data:text/html,<b>x</b>">x</a>'))).toMatch(/`data:`/);
  });

  it("rejects a relative URL — an opaque-origin frame has nothing to resolve it against", () => {
    expect(messages(withFallback('<script src="/local/c.js"></script>'))).toMatch(/https:/);
    expect(messages(withFallback('<a href="#chart">x</a>'))).toMatch(/https:/);
  });

  it("is case-insensitive about the scheme", () => {
    expect(messages(withFallback('<img src="HTTP://h.test/a.png">'))).toMatch(/`http:`/);
    expect(messages(withFallback('<a href="JaVaScRiPt:alert(1)">x</a>'))).toMatch(/`javascript:`/);
  });

  it("sees through the whitespace a browser strips before it resolves a URL", () => {
    expect(messages(withFallback('<a href="  javascript:alert(1)">x</a>'))).toMatch(/`javascript:`/);
    expect(messages(withFallback('<a href="java\nscript:alert(1)">x</a>'))).toMatch(
      /`javascript:`/,
    );
    expect(messages(withFallback('<a href="java\tscript:alert(1)">x</a>'))).toMatch(
      /`javascript:`/,
    );
  });

  it("treats a backslash authority as protocol-relative, the way a URL parser does", () => {
    expect(messages(withFallback('<img src="\\\\evil.test/a.png">'))).toMatch(/protocol-relative/i);
  });

  it("applies the same rule to the other URL-bearing attributes", () => {
    expect(messages(withFallback('<video poster="http://h.test/p.png"></video>'))).toMatch(/`http:`/);
    expect(messages(withFallback('<form action="http://h.test/x"></form>'))).toMatch(/`http:`/);
  });
});

describe("parseTemplate — the fallback element", () => {
  it("rejects a template with no [data-wolf-fallback] element", () => {
    const text = messages('<div data-wolf-slot="headline"></div>');
    expect(text).toMatch(/data-wolf-fallback/);
  });

  it("accepts any element carrying the attribute, whatever its value", () => {
    expect(parseTemplate('<p data-wolf-fallback="yes">nope</p>', BIG).valid).toBe(true);
  });

  it.each([
    ["<template>", "<template><div data-wolf-fallback>no chart</div></template><p>x</p>"],
    ["<noscript>", "<noscript><div data-wolf-fallback>no chart</div></noscript><p>x</p>"],
    ["the container itself", "<template data-wolf-fallback>no chart</template><p>x</p>"],
  ])(
    "rejects a fallback that only exists inside %s — it renders NOTHING",
    (_label, html) => {
      // The criterion's whole purpose is a visible signal that the chart never
      // drew. `<template>` is an inert fragment and `<noscript>`'s children are
      // raw text with scripting on, so neither puts a pixel on the page.
      const text = messages(html);
      expect(text).toMatch(/renders nothing/);
      expect(text).toMatch(/data-wolf-fallback/);
    },
  );

  it("accepts a real fallback even when an inert copy also exists", () => {
    const html =
      "<template><div data-wolf-fallback>copy</div></template>" +
      "<div data-wolf-fallback>no chart</div>";
    expect(parseTemplate(html, BIG).valid).toBe(true);
  });

  it("counts a fallback that merely FOLLOWS a closed inert container", () => {
    const html = "<template><p>t</p></template><div data-wolf-fallback>no chart</div>";
    expect(parseTemplate(html, BIG).valid).toBe(true);
  });
});

describe("parseTemplate — the size limit", () => {
  it("names BOTH the limit and the actual size", () => {
    const html = withFallback("<p>" + "x".repeat(500) + "</p>");
    const size = Buffer.byteLength(html, "utf8");
    const text = messages(html, 100);
    expect(text).toContain(String(size));
    expect(text).toContain("100");
  });

  it("measures BYTES, not characters — a multibyte template is bigger than its length", () => {
    const html = withFallback(`<p>${"€".repeat(100)}</p>`);
    const chars = html.length;
    const bytes = Buffer.byteLength(html, "utf8");
    expect(bytes).toBeGreaterThan(chars);
    expect(parseTemplate(html, chars).valid).toBe(false);
    expect(parseTemplate(html, bytes).valid).toBe(true);
  });

  it("accepts a template of exactly maxBytes", () => {
    const html = withFallback("<p>x</p>");
    expect(parseTemplate(html, Buffer.byteLength(html, "utf8")).valid).toBe(true);
  });

  it("reports the size on its own: an oversized template is not also parsed for slot errors", () => {
    const html = withFallback('<div data-wolf-slot="NOPE"></div>');
    expect(errorsOf(html, 10)).toHaveLength(1);
  });

  it("refuses a nonsensical limit rather than silently accepting everything", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseTemplate(VALID, bad)).toThrow(WolfError);
    }
  });
});

describe("structureHash — sha256 of the STORED BYTES, no normalisation", () => {
  it("is the plain sha256 of the bytes handed in, lowercase hex", () => {
    const expected = createHash("sha256").update(VALID, "utf8").digest("hex");
    expect(structureHash(VALID)).toBe(expected);
    expect(parseOk(VALID).structureHash).toBe(expected);
    expect(structureHash(VALID)).toBe(structureHash(VALID).toLowerCase());
  });

  it("DIFFERS when only whitespace inside a <script> body changes — the lock is not forgeable", () => {
    const a = withFallback("<script>\n  draw(1)\n</script>");
    const b = withFallback("<script>\ndraw(1)\n</script>");
    expect(a).not.toBe(b);
    expect(structureHash(a)).not.toBe(structureHash(b));
  });

  it("DIFFERS on leading/trailing whitespace, indentation and attribute order", () => {
    const base = withFallback('<div id="a" class="b"></div>');
    expect(structureHash(base)).not.toBe(structureHash(`${base}\n`));
    expect(structureHash(base)).not.toBe(structureHash(` ${base}`));
    expect(structureHash(base)).not.toBe(
      structureHash(withFallback('<div class="b" id="a"></div>')),
    );
    expect(structureHash(base)).not.toBe(
      structureHash(withFallback('<div  id="a" class="b"></div>')),
    );
  });

  it("is stable across calls and equals sha256 of the utf8 bytes for multibyte input", () => {
    const html = withFallback("<p>€ £ ¥</p>");
    const expected = createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
    expect(structureHash(html)).toBe(expected);
    expect(structureHash(html)).toBe(structureHash(html));
  });
});

describe("parseTemplate — scriptSrcs, for the go-live review screen", () => {
  it("lists every external script AND stylesheet URL, in document order", () => {
    expect(parseOk(VALID).scriptSrcs).toEqual([
      "https://cdn.example.com/chart.css",
      "https://cdn.example.com/chart.js",
    ]);
  });

  it("does not list an INLINE script — there is no remote code for a human to approve", () => {
    expect(parseOk(withFallback("<script>draw()</script>")).scriptSrcs).toEqual([]);
  });

  it("does not list a non-stylesheet <link>", () => {
    const html = withFallback('<link rel="preconnect" href="https://cdn.example.com">');
    expect(parseOk(html).scriptSrcs).toEqual([]);
  });

  it("lists a stylesheet whose rel carries more than one token", () => {
    const html = withFallback('<link rel="alternate stylesheet" href="https://cdn.test/a.css">');
    expect(parseOk(html).scriptSrcs).toEqual(["https://cdn.test/a.css"]);
  });
});

/**
 * THE COMMENT-CLOSE DIFFERENTIAL (fix round 1).
 *
 * The first cut of `scan()` closed a comment only on the literal `-->`. The
 * HTML tokenizer closes one in three more ways, and everything between such a
 * close and the next literal `-->` is MARKUP to a browser and was invisible to
 * the validator: `<!---><script src="http://evil…"></script><!-- pad -->`
 * validated clean, with an EMPTY `scriptSrcs`, while jsdom/parse5 on the same
 * bytes reported the script. That single gap walked four acceptance criteria
 * — https-only, fragment-only, duplicate-slot, and the go-live review list —
 * and `structureHash` would then have frozen the forged template.
 *
 * Each closer below is crossed with each vector, so a regression in any one
 * comment state fails four ways at once.
 */
const COMMENT_CLOSERS: Array<[label: string, prefix: string]> = [
  ["<!-->  — abrupt closing of an empty comment", "<!-->"],
  ["<!--->  — abrupt close from the comment start dash state", "<!--->"],
  ["--!>  — the comment end bang state", "<!-- a --!>"],
  ["-->  — the ordinary close", "<!-- a -->"],
];

const HIDDEN_VECTORS: Array<[label: string, markup: string, expected: RegExp]> = [
  [
    "an http: remote script",
    '<script src="http://evil.example/x.js"></script>',
    /`http:` URLs are not permitted/,
  ],
  [
    "a protocol-relative script",
    '<script src="//evil.example/x.js"></script>',
    /protocol-relative/,
  ],
  [
    "a javascript: href",
    '<a href="javascript:alert(1)">x</a>',
    /`javascript:` URLs are not permitted/,
  ],
  ["a <body> element", '<body data-x="1"></body>', /must not contain a `<body>`/],
  [
    "a duplicate slot id",
    '<div data-wolf-slot="a"></div><div data-wolf-slot="a"></div>',
    /duplicate slot id "a"/,
  ],
];

describe("parseTemplate — a comment ends in FOUR ways, not one", () => {
  for (const [closerLabel, prefix] of COMMENT_CLOSERS) {
    for (const [vectorLabel, markup, expected] of HIDDEN_VECTORS) {
      it(`still refuses ${vectorLabel} hidden behind ${closerLabel}`, () => {
        // The trailing `<!-- pad -->` is the second half of the original
        // bypass: it was the literal `-->` the old scanner skipped ahead to.
        const html = withFallback(`${prefix}${markup}<!-- pad -->`);
        expect(messages(html)).toMatch(expected);
      });
    }
  }

  for (const [closerLabel, prefix] of COMMENT_CLOSERS) {
    it(`LISTS a remote script that follows ${closerLabel} in scriptSrcs`, () => {
      // The go-live review screen exists to show a human every remote URL. An
      // empty list for a template that loads code is the worst failure here.
      const html = withFallback(
        `${prefix}<script src="https://cdn.example/x.js"></script><!-- pad -->`,
      );
      expect(parseOk(html).scriptSrcs).toEqual(["https://cdn.example/x.js"]);
    });
  }

  it("closes `<!--<!--->` where the tokenizer does, so what follows is scanned", () => {
    const html = withFallback('<!--<!---><script src="http://evil.example/x.js"></script>');
    expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
  });

  it("still treats an ORDINARY comment as a comment — markup inside it is inert", () => {
    const html = withFallback(
      '<!-- <script src="http://evil.example/x.js"></script> --><p>ok</p>',
    );
    const template = parseOk(html);
    expect(template.scriptSrcs).toEqual([]);
    expect(template.slotIds).toEqual([]);
  });

  it("accepts an empty comment written in either abrupt form", () => {
    expect(parseOk(withFallback("<!--><p>a</p>")).slotIds).toEqual([]);
    expect(parseOk(withFallback("<!---><p>a</p>")).slotIds).toEqual([]);
  });

  it("does not swallow a slot that follows an abrupt close", () => {
    const html = withFallback('<!---><div data-wolf-slot="chart">x</div>');
    expect(parseOk(html).slotIds).toEqual(["chart"]);
  });

  it("still reports a comment that is opened and never closed", () => {
    expect(messages(withFallback("<!-- never closed"))).toMatch(/never closed/);
  });
});

describe("parseTemplate — reporting", () => {
  it("returns EVERY error at once, each with a path a review screen can print", () => {
    const html = [
      '<div data-wolf-slot="Bad"></div>',
      '<script src="http://h.test/a.js"></script>',
      "<body>x</body>",
    ].join("\n");
    const errors = errorsOf(html);
    expect(errors.length).toBeGreaterThanOrEqual(4); // bad id, http:, <body>, no fallback
    for (const error of errors) {
      expect(typeof error.path).toBe("string");
      expect(error.path).not.toBe("");
      expect(typeof error.message).toBe("string");
      expect(error.message).not.toBe("");
    }
  });

  it("never throws for hostile or malformed input — a caller mistake is not a 500", () => {
    for (const html of [
      "",
      "<",
      "<<<>>>",
      "<div",
      "<!-- unterminated",
      '<div data-wolf-slot="x"',
      "<script>",
      "</>",
      "<a href=>x</a>",
      "<div a='b\">",
    ]) {
      expect(() => parseTemplate(html, BIG)).not.toThrow();
      expect(parseTemplate(html, BIG).valid).toBe(false);
    }
  });

  it("templateValidationError wraps the list as the taxonomy's `invalid` kind", () => {
    const errors = errorsOf("<p>no fallback</p>");
    const err = templateValidationError(errors);
    expect(err).toBeInstanceOf(WolfError);
    expect(err.kind).toBe("invalid");
    expect(err.details).toEqual({ errors });
  });
});


/**
 * THE FOREIGN-CONTENT DIFFERENTIAL (fix round 2).
 *
 * `style`, `title`, `textarea`, `xmp`, `noembed` and `noframes` are RAW TEXT
 * in HTML content and ORDINARY ELEMENTS inside `<svg>`/`<math>`, where the
 * tree builder never switches the tokenizer. The first cut of `scan()`
 * treated them as raw text unconditionally, so markup written inside
 * `<svg><style>…</style></svg>` was invisible here while a browser built real
 * elements out of it. Confirmed against parse5 on the identical bytes; three
 * acceptance criteria were bypassable through the one hole:
 *
 *   - a remote script that `scriptSrcs` reported as ZERO remote scripts,
 *   - a non-https `src` that passed the https-only rule,
 *   - a duplicate slot id whose second region was never filled and never
 *     drifted.
 *
 * Every case below is a fragment parse5 turns into real elements.
 */
const FOREIGN_WRAPPERS = ["svg", "math"] as const;
/** Raw text in HTML; NOT raw text inside foreign content. */
const RAW_TEXT_HOSTS = ["style", "title", "textarea", "xmp", "noembed", "noframes"] as const;

describe("parseTemplate — raw text is not raw inside <svg>/<math>", () => {
  for (const wrapper of FOREIGN_WRAPPERS) {
    for (const host of RAW_TEXT_HOSTS) {
      it(`sees an http: src smuggled through <${wrapper}><${host}>`, () => {
        const html = withFallback(
          `<${wrapper}><${host}><img src="http://evil.example/beacon.png"></${host}></${wrapper}>`,
        );
        expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
      });
    }
  }

  it("LISTS a remote script hidden in <svg><style> — the go-live screen must see it", () => {
    // The verifier's own fixture. The `<p>` is on the tree builder's breakout
    // list, so what follows it is an ordinary HTML <script> to a browser.
    const html = withFallback(
      '<svg><style><p></p><script src="https://evil.example/x.js"></script></style></svg>',
    );
    expect(parseOk(html).scriptSrcs).toEqual(["https://evil.example/x.js"]);
  });

  it("refuses a DUPLICATE slot id whose second region hides in <svg><style>", () => {
    const html = withFallback(
      '<div data-wolf-slot="a">1</div><svg><style><div data-wolf-slot="a">2</div></style></svg>',
    );
    expect(messages(html)).toMatch(/duplicate slot id "a"/);
  });

  it("refuses a <body> element hidden in <svg><style>", () => {
    const html = withFallback("<svg><style><body></body></style></svg>");
    expect(messages(html)).toMatch(/must not contain a `<body>`/);
  });

  it("refuses an <embed src=\"http:\"> hidden in <svg><style>", () => {
    const html = withFallback('<svg><style><embed src="http://evil.example/x"></style></svg>');
    expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
  });

  it("checks a foreign <script>'s own src too — SVG script is not raw text either", () => {
    expect(messages(withFallback('<svg><script src="http://evil.example/x.js"></script></svg>'))).toMatch(
      /`http:` URLs are not permitted/,
    );
    expect(
      parseOk(withFallback('<svg><script src="https://cdn.example/x.js"></script></svg>')).scriptSrcs,
    ).toEqual(["https://cdn.example/x.js"]);
  });

  it("still accepts an ordinary SVG chart: a title, a stylesheet body and shapes", () => {
    const html = withFallback(
      '<svg viewBox="0 0 10 10"><title>Equity curve</title><style>.bar{fill:#333}</style>' +
        '<g><rect class="bar"/></g></svg><div data-wolf-slot="commentary"></div>',
    );
    expect(parseOk(html).slotIds).toEqual(["commentary"]);
  });

  it("treats `<svg/>` as opening nothing, so a following <style> is raw text again", () => {
    // parse5 agrees: in foreign content a self-closing start tag really does
    // close the element, and the <img> below is then #text inside <style>.
    const html = withFallback('<svg/><style><img src="http://evil/x.png"></style>');
    expect(parseTemplate(html, BIG).valid).toBe(true);
  });

  it("does not end the outer subtree at an INNER </svg>", () => {
    const html = withFallback(
      '<svg><g><svg></svg></g><style><img src="http://evil/x.png"></style></svg>',
    );
    expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
  });

  it("refuses an <svg> that is never closed rather than guessing where it ends", () => {
    expect(messages(withFallback("<svg><circle/>"))).toMatch(/`<svg>` is opened and never closed/);
    expect(messages(withFallback("<math><mi>x</mi>"))).toMatch(/`<math>` is opened and never closed/);
  });

  it("leaves HTML-content raw text raw: script and style bodies are still text", () => {
    // The other half of the invariant. Narrowing the raw-text rule must not
    // start reading a <script> body as markup — chart code is full of `<`.
    const script = parseOk(withFallback("<script>var b = document.body; if (a<b) { }</script>"));
    expect(script.slotIds).toEqual([]);
    const style = parseOk(withFallback('<style>.a::before{content:"<img src=x>"}</style>'));
    expect(style.scriptSrcs).toEqual([]);
  });
});

describe("parseTemplate — a slot must RENDER, like the fallback", () => {
  for (const [label, fragment] of [
    ["<template>", '<template><div data-wolf-slot="chart">x</div></template>'],
    ["<noscript>", '<noscript><div data-wolf-slot="chart">x</div></noscript>'],
  ] as const) {
    it(`refuses a slot inside ${label}, naming it`, () => {
      // A <noscript>'s children are TEXT when scripting is enabled, which it
      // is in a frame whose purpose is to run a charting library — so the
      // daily tick would write bytes that render as literal markup, and the
      // drift check on that slot would mean nothing.
      const text = messages(withFallback(fragment));
      expect(text).toMatch(/renders nothing/);
      expect(text).toContain("chart");
    });
  }

  it("still accepts a slot that merely FOLLOWS an inert element", () => {
    const html = withFallback('<template><p>t</p></template><div data-wolf-slot="chart">x</div>');
    expect(parseOk(html).slotIds).toEqual(["chart"]);
  });
});

/**
 * The CSS at-rule, spelled in two halves ON PURPOSE.
 *
 * `tools/import-boundary`'s scanner is text-based: it reads the word
 * `import` followed by a quote as an ESM specifier, wherever it appears —
 * including inside a string literal. Writing the at-rule out in a fixture
 * (or in a table LABEL that ends with it) makes api/'s own
 * `import-boundary.test.ts` fail on CSS that is not an import at all. That
 * is a defect in the checker, logged as a discovered issue; this constant is
 * the local workaround, and it keeps the fixtures readable.
 */
const AT = `@${"im"}port`;

describe("parseTemplate — CSS is a URL channel too", () => {
  const CSS_VECTORS: Array<[label: string, css: string, expected: RegExp]> = [
    ["an http: at-rule", `${AT} url(http://evil.example/x.css);`, /`http:` URLs are not permitted/],
    ["a quoted http: at-rule", `${AT} "http://evil.example/x.css";`, /`http:` URLs are not permitted/],
    ["a protocol-relative background", ".a{background:url(//evil.example/x.png)}", /protocol-relative/],
    ["a javascript: url", ".a{background:url(javascript:alert(1))}", /`javascript:`/],
    ["a relative url", ".a{background:url(x.png)}", /must be an absolute `https:` URL/],
  ];

  for (const [label, css, expected] of CSS_VECTORS) {
    it(`refuses ${label} in a <style> body`, () => {
      expect(messages(withFallback(`<style>${css}</style>`))).toMatch(expected);
    });
  }

  it("refuses an http: url in a style ATTRIBUTE, and names the element", () => {
    const errors = errorsOf(withFallback('<div style="background:url(http://evil/x.png)">y</div>'));
    expect(errors.map((e) => e.message).join("\n")).toMatch(/`http:` URLs are not permitted/);
    expect(errors.map((e) => e.path)).toContain("div[style]");
  });

  it("allows a `#fragment` paint reference — how every SVG chart names its own gradient", () => {
    expect(parseTemplate(withFallback('<div style="fill:url(#grad)">y</div>'), BIG).valid).toBe(true);
    expect(
      parseTemplate(withFallback("<style>.bar{fill:url(#grad)}</style>"), BIG).valid,
    ).toBe(true);
  });

  it("allows a data: url in CSS (an image or a font, which cannot execute)", () => {
    const html = withFallback('<div style="background:url(data:image/png;base64,AAA)">y</div>');
    expect(parseTemplate(html, BIG).valid).toBe(true);
  });

  it("LISTS an https: at-rule URL in scriptSrcs — it is an external stylesheet", () => {
    expect(
      parseOk(withFallback(`<style>${AT} url("https://cdn.example/a.css");</style>`)).scriptSrcs,
    ).toEqual(["https://cdn.example/a.css"]);
    expect(parseOk(withFallback(`<style>${AT} "https://cdn.example/b.css";</style>`)).scriptSrcs)
      .toEqual(["https://cdn.example/b.css"]);
  });

  it("does not list an ordinary url() — an image is not a script or a stylesheet", () => {
    const html = withFallback('<style>.a{background:url("https://cdn.example/x.png")}</style>');
    expect(parseOk(html).scriptSrcs).toEqual([]);
  });

  it("checks CSS inside <svg><style> as CSS as well as scanning it as markup", () => {
    const html = withFallback('<svg><style>.a{background:url(http://evil/x.png)}</style></svg>');
    expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
  });
});

describe("parseTemplate — character references are not decoded, and that is fail-closed", () => {
  it("refuses an ENTITY-encoded javascript: href, by the generic rule", () => {
    // A browser decodes `&#10;` and sees `javascript:`; this scanner does not
    // decode, sees "some other scheme", and refuses it anyway — which is the
    // whole reason not decoding is safe. Pinned because the module's comment
    // used to claim the javascript: branch caught this one.
    const text = messages(withFallback('<a href="java&#10;script:alert(1)">x</a>'));
    expect(text).toMatch(/must be an absolute `https:` URL/);
    expect(parseTemplate(withFallback('<a href="java&#10;script:alert(1)">x</a>'), BIG).valid).toBe(
      false,
    );
  });

  it("refuses an entity-encoded scheme even when it would decode to https", () => {
    expect(parseTemplate(withFallback('<img src="&#104;ttps://cdn.example/x.png">'), BIG).valid).toBe(
      false,
    );
  });
});

/**
 * THE PARSE5 DIFFERENTIAL SWEEP, pinned.
 *
 * Every row below is a wrapper that was run through parse5 (7.3.0,
 * `parseFragment`, `scriptingEnabled: true`) with the marker `<img
 * src="http://evil.example/beacon.png">` inside it, on 2026-08-22, and in
 * every one parse5 built a REAL element carrying that http: URL — i.e. a
 * browser fetches it. `parseTemplate` must therefore refuse every row.
 *
 * parse5 is not a dependency of `api/` (W17 owns `package.json` and adds one
 * sanitiser, nothing else), so the oracle cannot run inside this suite; what
 * is pinned here is its RESULT. The harness that produced it is described in
 * the fix-round-2 notes, and re-running it is the required first step before
 * anything about what `scan()` skips is changed.
 */
const BROWSER_BUILDS_IT: Array<[label: string, wrapper: string]> = [
  ["bare markup", "%s"],
  ["after an abrupt comment close", "<!-->%s<!-- pad -->"],
  ["after `<!--->`", "<!--->%s<!-- pad -->"],
  ["after `--!>`", "<!-- a --!>%s<!-- pad -->"],
  ["after an ordinary comment", "<!-- a -->%s"],
  ["inside <svg><style>", "<svg><style>%s</style></svg>"],
  ["inside <svg><title>", "<svg><title>%s</title></svg>"],
  ["inside <svg><textarea>", "<svg><textarea>%s</textarea></svg>"],
  ["inside <svg><desc>", "<svg><desc>%s</desc></svg>"],
  ["inside <svg><foreignObject>", "<svg><foreignObject>%s</foreignObject></svg>"],
  ["inside <svg><script>", "<svg><script>%s</script></svg>"],
  ["inside <math><style>", "<math><style>%s</style></math>"],
  ["inside <math><mtext>", "<math><mtext>%s</mtext></math>"],
  [
    "inside <math><annotation-xml>",
    '<math><annotation-xml encoding="text/html">%s</annotation-xml></math>',
  ],
  ["inside an UNCLOSED <svg>", "<svg><style>%s"],
  ["after an inner </svg> that does not close the outer one", "<svg><g><svg></svg></g><style>%s</style></svg>"],
  ["inside <SVG><STYLE> (uppercase)", "<SVG><STYLE>%s</STYLE></SVG>"],
  ["inside <svg/ ><style> (a stray solidus is not self-closing)", "<svg/ ><style>%s</style></svg>"],
  ["as an unquoted attribute value's tail", "<div id=a%s>x</div>"],
  ["inside a <table>", "<table>%s</table>"],
];

describe("parseTemplate — refuses every fragment parse5 builds a real element from", () => {
  const MARKER = '<img src="http://evil.example/beacon.png">';
  for (const [label, wrapper] of BROWSER_BUILDS_IT) {
    it(`refuses an http: fetch ${label}`, () => {
      const html = withFallback(wrapper.replace("%s", MARKER));
      expect(parseTemplate(html, BIG).valid).toBe(false);
    });
  }
});

/**
 * W30 — `remoteOrigins`, the full remote-host inventory.
 *
 * design/2026-08-20-agent-wolf.md § W30. THREE tickets consume this list and
 * each of them fails in a different direction if it is wrong, which is why
 * every case below pins an exact array rather than a `toContain`:
 *
 *  - **W19** derives the frame's CSP from it. A host MISSING here becomes a
 *    CSP that is too narrow, the browser blocks the fetch, and the report
 *    silently does not render — it **fails closed**: safe, and invisible.
 *  - **W24** lists it on the go-live review screen. The same missing host is
 *    an **understatement**: a human approves a template that contacts a host
 *    they were never shown — it **fails open**, and that is the reason R118
 *    flagged this at all.
 *  - **W21** serves it, so it must be stable for the same bytes.
 *
 * `scriptSrcs` is NOT this list and must not become it. It means "remote
 * CODE — scripts and stylesheets — which a human is approving as code", and
 * W24 renders the two separately. Every case below that adds a URL channel
 * also asserts what `scriptSrcs` did (and did not) do with it.
 */
describe("W30: remoteOrigins — every host a template will contact", () => {
  it("lists the host of an <img> that carries no code at all — the gap this closes", () => {
    // The ticket's own worked example. Before W30 the go-live screen showed
    // this template ZERO remote hosts, because `scriptSrcs` correctly reports
    // no remote code: a human approved a template that phones home.
    const template = parseOk(withFallback('<img src="https://evil.example/px.gif">'));
    expect(template.scriptSrcs).toEqual([]);
    expect(template.remoteOrigins).toEqual(["https://evil.example"]);
  });

  it("lists the origin of every URL channel the validator already walks", () => {
    const html = withFallback(
      [
        '<script src="https://s.example/a.js"></script>',
        '<link rel="stylesheet" href="https://l.example/a.css">',
        '<img src="https://i.example/a.png">',
        '<img srcset="https://one.example/a.png 1x, https://two.example/a.png 2x">',
        '<video poster="https://p.example/a.png"></video>',
        '<form action="https://f.example/post"><button formaction="https://fa.example/post">go</button></form>',
        '<svg><use xlink:href="https://x.example/a.svg#g"></use></svg>',
        '<table background="https://b.example/a.png"></table>',
        '<a href="https://h.example/page" ping="https://ping.example/track">t</a>',
        '<object data="https://o.example/a.pdf"></object>',
        '<div style="background:url(https://css.example/a.png)">y</div>',
        `<style>${AT} url("https://at.example/a.css");</style>`,
      ].join("\n"),
    );
    expect(parseOk(html).remoteOrigins).toEqual([
      "https://at.example",
      "https://b.example",
      "https://css.example",
      "https://f.example",
      "https://fa.example",
      "https://h.example",
      "https://i.example",
      "https://l.example",
      "https://o.example",
      "https://one.example",
      "https://p.example",
      "https://ping.example",
      "https://s.example",
      "https://two.example",
      "https://x.example",
    ]);
  });

  it("collapses two paths on one host, and a default :443, into ONE entry", () => {
    const html = withFallback(
      [
        '<img src="https://a.example/one.png">',
        '<img src="https://a.example/two.png?q=1#frag">',
        '<img src="https://a.example:443/three.png">',
        '<img src="https://A.EXAMPLE/four.png">',
      ].join("\n"),
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://a.example"]);
  });

  it("keeps a NON-default port as a separate origin — a different port is a different origin", () => {
    const html = withFallback(
      '<img src="https://a.example/x.png"><img src="https://a.example:8443/x.png">',
    );
    expect(parseOk(html).remoteOrigins).toEqual([
      "https://a.example",
      "https://a.example:8443",
    ]);
  });

  it("is SORTED, not in document order — it is a set, and W19's CSP must be byte-stable", () => {
    const html = withFallback(
      '<img src="https://zulu.example/a.png"><img src="https://alpha.example/a.png">' +
        '<img src="https://mike.example/a.png">',
    );
    expect(parseOk(html).remoteOrigins).toEqual([
      "https://alpha.example",
      "https://mike.example",
      "https://zulu.example",
    ]);
  });

  it("is the same list whichever order the same hosts appear in", () => {
    const one = parseOk(withFallback('<img src="https://a.example/x"><img src="https://b.example/x">'));
    const two = parseOk(withFallback('<img src="https://b.example/x"><img src="https://a.example/x">'));
    expect(one.remoteOrigins).toEqual(two.remoteOrigins);
  });

  it("gives a data: URL and a CSS #fragment NO origin — neither contacts anybody", () => {
    const html = withFallback(
      '<img src="data:image/png;base64,AAA" style="fill:url(#grad)">' +
        "<style>.bar{fill:url(#grad)}</style>",
    );
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual([]);
    expect(template.scriptSrcs).toEqual([]);
  });

  it("leaves R118(3) exactly as it found it: a fragment-only href is still REFUSED", () => {
    // NOT this ticket's to fix — the attribute path and the CSS path disagree
    // about `#fragment`, and that disagreement belongs to W25's authoring
    // contract. It is pinned here so W30 cannot silently change it in either
    // direction: `href="#chart"` still fails, which is also why the criterion
    // "a fragment-only href contributes no origin" cannot be asserted through
    // `remoteOrigins` at all — a template containing one has no `remoteOrigins`
    // to inspect. The CSS half above is the half that CAN be asserted.
    expect(messages(withFallback('<a href="#chart">jump</a>'))).toMatch(
      /must be an absolute `https:` URL/,
    );
  });

  it("reports the same host once however many channels reach it", () => {
    const html = withFallback(
      '<script src="https://cdn.example/a.js"></script>' +
        '<img src="https://cdn.example/a.png">' +
        '<link rel="stylesheet" href="https://cdn.example/a.css">',
    );
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual(["https://cdn.example"]);
    // …while `scriptSrcs` still lists BOTH pieces of remote code, by URL, in
    // document order. The two lists are not redundant: one is hosts, the
    // other is the code a human is approving.
    expect(template.scriptSrcs).toEqual([
      "https://cdn.example/a.js",
      "https://cdn.example/a.css",
    ]);
  });

  it("lists nothing for a template that fetches nothing", () => {
    expect(parseOk(withFallback("<p>local only</p><script>draw()</script>")).remoteOrigins).toEqual(
      [],
    );
  });

  it("reports the shared fixture's single host", () => {
    expect(parseOk(VALID).remoteOrigins).toEqual(["https://cdn.example.com"]);
  });

  it("splits a multi-URL ping — both hosts are POSTed to when the link is followed", () => {
    // Held as one string, `new URL` refuses the whole value and BOTH hosts go
    // unlisted. Whitespace is the separator, and it is read from the RAW
    // value: the classification helper deletes newlines, which would weld two
    // candidates into one nonsense host.
    const html = withFallback(
      '<a href="https://h.example/p" ping="https://p1.example/t\nhttps://p2.example/t">t</a>',
    );
    expect(parseOk(html).remoteOrigins).toEqual([
      "https://h.example",
      "https://p1.example",
      "https://p2.example",
    ]);
  });

  it("refuses an http: candidate hiding in a multi-URL ping", () => {
    const html = withFallback(
      '<a href="https://h.example/p" ping="https://p1.example/t http://p2.example/t">t</a>',
    );
    expect(messages(html)).toMatch(/`http:` URLs are not permitted/);
  });

  it("gives an unparseable https: value no origin — it names no host", () => {
    // `classifyUrl` accepts anything whose scheme is https:, so `src="https:"`
    // is a VALID template today. It resolves against the frame's own base URL
    // rather than reaching a remote host, so there is no origin to report and
    // inventing one would put a host in W19's CSP that nothing fetches.
    expect(parseOk(withFallback('<img src="https:">')).remoteOrigins).toEqual([]);
  });
});

/**
 * W30 / R118(2) — the three channels W16's walker never visited.
 *
 * R118 recorded four minor defects standing in W16's parser. This is (2), and
 * it is the one that "silently understates the review screen": a template can
 * contact a remote host through `iframe[srcdoc]`, `meta[http-equiv=refresh]`
 * or `object > param[value]`, and none of the three was read by any rule in
 * the module — so the inventory this ticket adds would have been FALSE on its
 * own terms.
 *
 * Each channel is tested in BOTH directions, because they fail in opposite
 * ones: the origin must now appear (or W24 understates and W19's CSP blocks
 * the fetch), and `scriptSrcs` must not have quietly changed meaning (or W24
 * tells a human that a page navigation is remote code).
 */
/**
 * Escapes one HTML document so it can be carried as a `srcdoc` ATTRIBUTE
 * VALUE, exactly as an author must escape it — and exactly as a browser
 * un-escapes it when it parses the attribute. Nesting one srcdoc inside
 * another therefore escapes the inner document TWICE, which is what makes
 * these fixtures unreadable by hand and is why they are built rather than
 * written out.
 */
function srcdocFrame(document: string): string {
  const escaped = document
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<iframe srcdoc="${escaped}"></iframe>`;
}

describe("W30 / R118(2): iframe[srcdoc] — a whole nested document", () => {
  it("folds a nested <img>'s host into the parent's inventory, WITHOUT touching scriptSrcs", () => {
    const html = withFallback(
      `<iframe srcdoc='<img src="https://nested.example/px.gif">'></iframe>`,
    );
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual(["https://nested.example"]);
    // An `<img>` is not code, wherever it lives.
    expect(template.scriptSrcs).toEqual([]);
  });

  it("puts a nested <script src> in scriptSrcs AS WELL — it really is remote code", () => {
    // The one judgement call in this ticket, written down where W24 will read
    // it. A `<script src>` inside a srcdoc is fetched and EXECUTED by the
    // browser, in a document that inherits the embedder's CSP; a human
    // approving the template is approving that code exactly as they approve a
    // top-level one. Reporting it only as a host would show them a host and
    // hide the fact that code runs from it. The `<img>` in the same document
    // is not code and stays out — the rule is what the URL DOES, not where it
    // was found.
    const html = withFallback(
      `<iframe srcdoc='<script src="https://nested.example/a.js"></script><img src="https://pic.example/a.png">'></iframe>`,
    );
    const template = parseOk(html);
    expect(template.scriptSrcs).toEqual(["https://nested.example/a.js"]);
    expect(template.remoteOrigins).toEqual([
      "https://nested.example",
      "https://pic.example",
    ]);
  });

  it("reads an ENTITY-ENCODED srcdoc identically to the literal-angle spelling", () => {
    // parse5 hands back byte-identical attribute values for these two, which
    // is why the nested walk decodes character references — and ONLY for
    // srcdoc. Not decoding would lose the whole nested document, which is the
    // direction that fails open.
    const encoded = withFallback(
      '<iframe srcdoc="&lt;img src=&quot;https://nested.example/px.gif&quot;&gt;"></iframe>',
    );
    const literal = withFallback(
      `<iframe srcdoc='<img src="https://nested.example/px.gif">'></iframe>`,
    );
    expect(parseOk(encoded).remoteOrigins).toEqual(["https://nested.example"]);
    expect(parseOk(encoded).remoteOrigins).toEqual(parseOk(literal).remoteOrigins);
  });

  it("refuses an http: URL inside a srcdoc, naming the srcdoc in the path", () => {
    const html = withFallback(`<iframe srcdoc='<img src="http://evil.example/px.gif">'></iframe>`);
    const errors = errorsOf(html);
    expect(errors.map((e) => e.path)).toContain("iframe[srcdoc] > img[src]");
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /inside an `<iframe srcdoc>` document: `http:` URLs are not permitted/,
    );
  });

  it("reports a nested failure at the IFRAME's offset, not at an offset into the srcdoc value", () => {
    const fragment = `<iframe srcdoc='<img src="http://evil.example/px.gif">'></iframe>`;
    const html = withFallback(fragment);
    const error = errorsOf(html).find((e) => e.path.startsWith("iframe[srcdoc]"));
    expect(error?.offset).toBe(html.indexOf("<iframe"));
  });

  it("folds up a DOUBLY nested srcdoc — the guard's stated depth really is walked", () => {
    const html = withFallback(
      srcdocFrame(
        `${srcdocFrame('<img src="https://deep.example/px.gif">')}<img src="https://mid.example/a.png">`,
      ),
    );
    expect(parseOk(html).remoteOrigins).toEqual([
      "https://deep.example",
      "https://mid.example",
    ]);
  });

  it("REFUSES a triply nested srcdoc rather than under-reporting it", () => {
    // The guard bites here, and it bites by refusing. Silently not walking
    // the third level would leave a host out of the inventory, which is the
    // fail-open direction; a template this module cannot fully inspect is a
    // template it declines to bless.
    const html = withFallback(
      srcdocFrame(srcdocFrame(srcdocFrame('<img src="https://deepest.example/px.gif">'))),
    );
    const text = errorsOf(html)
      .map((e) => e.message)
      .join("\n");
    expect(text).toMatch(/nested 3 deep/);
    expect(text).toMatch(/inspected 2 levels deep/);
  });

  it("counts nested bytes against the SAME maxBytes budget", () => {
    // A nested document is parsed like any other, so it cannot be used to
    // slip past a byte limit the parent respects.
    const filler = "x".repeat(400);
    const html = withFallback(`<iframe srcdoc='<p>${filler}</p>'></iframe><p>${filler}</p>`);
    const limit = Buffer.byteLength(html, "utf8") + 100;
    // The template itself fits…
    expect(html.length).toBeLessThan(limit);
    // …and is still refused, because the nested document is counted too.
    const text = messages(html, limit);
    expect(text).toMatch(/nested `<iframe srcdoc>` documents bring the total parsed size/);
    expect(text).toMatch(new RegExp(`exceeds the limit of ${limit} bytes`));
  });

  it("accumulates the budget across SIBLING srcdocs, not per document", () => {
    // Two nested documents that each fit comfortably, and together do not.
    // A per-document check would pass both; the budget is one budget for the
    // whole parse, which is what "a nested document cannot be used to blow
    // it" means.
    const filler = "y".repeat(60);
    const html = withFallback(
      `<iframe srcdoc="<p>${filler}</p>"></iframe><iframe srcdoc="<p>${filler}</p>"></iframe>`,
    );
    const limit = Buffer.byteLength(html, "utf8") + 100;
    expect(parseTemplate(html, limit + 200).valid).toBe(true);
    expect(messages(html, limit)).toMatch(
      /nested `<iframe srcdoc>` documents bring the total parsed size/,
    );
  });

  it("does NOT apply the fragment rules inside a srcdoc — a nested document IS a document", () => {
    // `<!doctype>`, `<html>` and `<body>` are errors in the TEMPLATE because
    // composeFrame owns the skeleton. A srcdoc holds a whole document of its
    // own, where all three are ordinary and correct.
    const html = withFallback(
      `<iframe srcdoc='<!doctype html><html><body><img src="https://nested.example/a.png"></body></html>'></iframe>`,
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://nested.example"]);
  });

  it("does NOT read a nested [data-wolf-slot] as a slot", () => {
    // Its content range would land inside an attribute value, so W19's filler
    // could not write it without corrupting the tag it lives in.
    const html = withFallback(
      `<div data-wolf-slot="real"></div><iframe srcdoc='<div data-wolf-slot="phantom"></div>'></iframe>`,
    );
    expect(parseOk(html).slotIds).toEqual(["real"]);
  });

  it("does NOT accept a fallback that only exists inside a srcdoc", () => {
    // Same reasoning as the `<template>`/`<noscript>` rule: the fallback is
    // the operator's signal, and one buried in a nested browsing context is
    // not the fragment's own.
    const html = `<iframe srcdoc='<div data-wolf-fallback>no chart</div>'></iframe>`;
    expect(messages(html)).toMatch(/must contain an element carrying `data-wolf-fallback`/);
  });

  it("still refuses the iframe's own src by the ordinary rule", () => {
    expect(messages(withFallback('<iframe src="http://evil.example/x"></iframe>'))).toMatch(
      /`http:` URLs are not permitted/,
    );
  });
});

describe("W30 / R118(2): meta[http-equiv=refresh] — a navigation is a fetch", () => {
  it("lists the host a refresh navigates to, and does NOT call it code", () => {
    const html = withFallback('<meta http-equiv="refresh" content="0;URL=https://evil.example/x">');
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual(["https://evil.example"]);
    expect(template.scriptSrcs).toEqual([]);
  });

  it("reads the spellings the refresh grammar actually allows", () => {
    const CASES: Array<[label: string, content: string]> = [
      ["url= in upper case", "0;URL=https://evil.example/x"],
      ["url= in lower case", "0;url=https://evil.example/x"],
      ["spaces around the keyword", "0 ;  url  =  https://evil.example/x"],
      ["a comma separator", "0,url=https://evil.example/x"],
      ["NO url= keyword at all", "0; https://evil.example/x"],
      ["a single-quoted URL", "0;url='https://evil.example/x'"],
      ["a fractional time", "1.5;url=https://evil.example/x"],
    ];
    for (const [label, content] of CASES) {
      const html = withFallback(`<meta http-equiv="refresh" content="${content}">`);
      expect(parseOk(html).remoteOrigins, label).toEqual(["https://evil.example"]);
    }
  });

  it("reads a DOUBLE-quoted refresh URL, written inside a single-quoted attribute", () => {
    // Written this way because this module does not decode character
    // references: `content="0;url=&quot;…&quot;"` is a `"` to a browser and
    // six literal characters here. That asymmetry is documented on
    // `urlForClassification` and is fail-closed — the entity spelling is
    // refused as "not an absolute https: URL" rather than silently accepted.
    const html = withFallback(
      `<meta http-equiv="refresh" content='0;url="https://evil.example/x"'>`,
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://evil.example"]);
  });

  it("finds the refresh however the http-equiv is cased or padded", () => {
    const html = withFallback(
      '<meta http-equiv=" ReFrEsH " content="0;url=https://evil.example/x">',
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://evil.example"]);
  });

  it("refuses an http: refresh target", () => {
    const errors = errorsOf(
      withFallback('<meta http-equiv="refresh" content="0;url=http://evil.example/x">'),
    );
    expect(errors.map((e) => e.path)).toContain("meta[http-equiv=refresh]");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/`http:` URLs are not permitted/);
  });

  it("refuses a javascript: refresh target", () => {
    expect(
      messages(withFallback('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">')),
    ).toMatch(/`javascript:` URLs are not permitted/);
  });

  it("leaves a refresh with no URL alone — it reloads in place and contacts nobody new", () => {
    const template = parseOk(withFallback('<meta http-equiv="refresh" content="30">'));
    expect(template.remoteOrigins).toEqual([]);
  });

  it("does not read a content-bearing meta that is NOT a refresh as a navigation", () => {
    // `<meta name="x" content="0;url=…">` navigates nowhere; reading it as a
    // URL would put a host in W19's CSP that nothing ever fetches.
    const html = withFallback('<meta name="generator" content="0;url=https://nowhere.example/x">');
    expect(parseOk(html).remoteOrigins).toEqual([]);
  });

  it("does not read a URL where the refresh grammar has no time", () => {
    // `content="https://…"` is not a refresh: the time is mandatory.
    const html = withFallback('<meta http-equiv="refresh" content="https://nowhere.example/x">');
    expect(parseOk(html).remoteOrigins).toEqual([]);
  });

  it("does not read a URL where the time is MISSING but a separator is present", () => {
    // The discriminating case for the mandatory time: `;url=…` has the
    // separator and the keyword and still navigates nowhere, because the
    // grammar collects digits (or a leading `.`) first and gives up when
    // there are none. Without that rule this reads as a refresh and puts a
    // host into W19's CSP that no browser ever contacts. (The previous case
    // does NOT discriminate — it fails the separator test as well.)
    const html = withFallback('<meta http-equiv="refresh" content=" ;url=https://nowhere.example/x">');
    expect(parseOk(html).remoteOrigins).toEqual([]);
  });
});

describe("W30 / R118(2): object > param[value] — the plugin channel", () => {
  it("lists a param's host, and does NOT call it code", () => {
    const html = withFallback(
      '<object data="https://o.example/a.swf"><param name="movie" value="https://p.example/b.swf"></object>',
    );
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual(["https://o.example", "https://p.example"]);
    expect(template.scriptSrcs).toEqual([]);
  });

  it("reads a param nested below the object, not only its direct child", () => {
    // parse5 keeps a `<param>` wherever it is written inside the object's
    // content, and reading the whole subtree is the fail-closed direction.
    const html = withFallback(
      '<object><div><param name="src" value="https://deep.example/b.swf"></div></object>',
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://deep.example"]);
  });

  it("ignores a LOOSE param outside any object — nothing resolves it", () => {
    const html = withFallback('<param name="movie" value="https://loose.example/b.swf">');
    const template = parseOk(html);
    expect(template.remoteOrigins).toEqual([]);
    // …and it is not an error either: this ticket adds an inventory, it does
    // not start refusing markup that fetches nothing.
    expect(parseTemplate(html, BIG).valid).toBe(true);
  });

  it("stops reading params once the object is closed", () => {
    const html = withFallback(
      '<object></object><param name="movie" value="https://after.example/b.swf">',
    );
    expect(parseOk(html).remoteOrigins).toEqual([]);
  });

  it("leaves a param that is not a URL at all alone", () => {
    // `<param name="quality" value="high">` is a plugin setting. Classifying
    // it as a URL would refuse a template for a value that fetches nothing.
    const html = withFallback('<object><param name="quality" value="high"></object>');
    expect(parseTemplate(html, BIG).valid).toBe(true);
    expect(parseOk(html).remoteOrigins).toEqual([]);
  });

  it("reads a scheme-bearing value under ANY param name", () => {
    const html = withFallback(
      '<object><param name="whatever" value="https://any.example/b.swf"></object>',
    );
    expect(parseOk(html).remoteOrigins).toEqual(["https://any.example"]);
  });

  it("refuses an http: param value", () => {
    const errors = errorsOf(
      withFallback('<object><param name="movie" value="http://evil.example/b.swf"></object>'),
    );
    expect(errors.map((e) => e.path)).toContain("object > param[value]");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/`http:` URLs are not permitted/);
  });
});

describe("W30: scriptSrcs keeps its meaning across all three new channels", () => {
  it("adds a navigation and a plugin parameter to the HOSTS, and only nested code to the CODE", () => {
    // The single assertion W24's screen depends on. A human reading that
    // screen sees two lists: "remote code you are approving" and "hosts this
    // will contact". A meta refresh and an object param are hosts, not code.
    // A nested `<script src>` is both.
    const html = withFallback(
      [
        '<meta http-equiv="refresh" content="0;url=https://meta.example/x">',
        '<object><param name="movie" value="https://param.example/b.swf"></object>',
        `<iframe srcdoc='<script src="https://nested.example/a.js"></script><img src="https://pic.example/a.png">'></iframe>`,
      ].join("\n"),
    );
    const template = parseOk(html);
    expect(template.scriptSrcs).toEqual(["https://nested.example/a.js"]);
    expect(template.remoteOrigins).toEqual([
      "https://meta.example",
      "https://nested.example",
      "https://param.example",
      "https://pic.example",
    ]);
  });

  it("leaves the shared fixture's scriptSrcs byte-for-byte as W16 left it", () => {
    expect(parseOk(VALID).scriptSrcs).toEqual([
      "https://cdn.example.com/chart.css",
      "https://cdn.example.com/chart.js",
    ]);
  });
});
