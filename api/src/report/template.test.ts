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
