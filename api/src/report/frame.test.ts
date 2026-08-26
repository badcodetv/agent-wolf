import { describe, expect, it } from "vitest";

import { WolfError } from "../errors.js";
import { composeFrame, frameCsp } from "./frame.js";
import type { SeriesPayload } from "./series.js";
import { parseTemplate } from "./template.js";
import type { ParsedTemplate } from "./template.js";

/**
 * W19 — frame composition and the CSP value.
 *
 * ⚠️ **Two things in this file are deliberately not where a reader expects.**
 *
 *  1. **Ruling 2 is tested in TWO files, and that is the point.** The
 *     validator half — a raw-text slot refused by `parseTemplate`, which is
 *     the load-bearing half, because it stops the template ever being locked
 *     — lives in `template.test.ts` under its own heading. What is tested
 *     HERE is `composeFrame`'s matching guard, on a HAND-BUILT
 *     `ParsedTemplate` that never went through the validator. Exercising
 *     that guard through `parseTemplate` would be testing the validator
 *     twice and would leave the guard as a comment (R148).
 *  2. **Every CSP expectation is a whole string literal**, not a value built
 *     from a shared constant or from `frameCsp`'s own pieces. An expectation
 *     assembled from the implementation's parts moves with the bug (R133),
 *     and this is the one value in the feature whose exact bytes W21 asserts
 *     on a live response.
 *
 * The measurements this file pins were taken on 2026-08-26 against parse5 8
 * and the merged `parseTemplate`/`sanitiseSlot`. Neither parse5 nor jsdom is
 * a declared dependency of `api/` — `template.test.ts` sets the convention of
 * pinning an out-of-suite oracle's RESULT — so the parser claims below are
 * recorded, with the document that produced them, rather than re-run here.
 */

const FALLBACK = "<div data-wolf-fallback>no chart</div>";

function parseOk(html: string): ParsedTemplate {
  const result = parseTemplate(html, 100_000);
  if (!result.valid) {
    throw new Error(`fixture did not parse: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  return result.template;
}

/** The empty payload, for the many cases that are not about the series. */
const NO_SERIES: SeriesPayload = {};

/* ================================================================== */
/* the derived CSP                                                     */
/* ================================================================== */

/**
 * The skeleton is `design/2026-08-24-agent-wolf-ui.md` § 6b as amended on
 * 2026-08-26 (R152), and the substitution is TWO lists at four positions:
 * `scriptSrcs`' origins into `script-src`/`style-src`, `remoteOrigins` into
 * `img-src`/`font-src`.
 *
 * Each row states the whole header. The repetition is the point: a directive
 * that silently disappeared — `sandbox`, `base-uri`, `form-action` or
 * `frame-ancestors`, none of which `default-src` covers — would be invisible
 * to a substring check, and a substring check is exactly what W19's criterion
 * says does not satisfy it.
 */
describe("frameCsp — the skeleton with two origin lists substituted", () => {
  it("emits no host at all for a template that references nothing remote", () => {
    const template = parseOk(`${FALLBACK}<div data-wolf-slot="a">x</div>`);
    expect(template.scriptSrcs).toEqual([]);
    expect(template.remoteOrigins).toEqual([]);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; " +
        "form-action 'none'; frame-ancestors 'self'; frame-src 'none'; child-src 'none'; " +
        "object-src 'none'; base-uri 'none'; manifest-src 'none'; media-src 'none'; " +
        "worker-src 'none'",
    );
  });

  it("substitutes one origin into all four positions", () => {
    const template = parseOk(`${FALLBACK}<script src="https://cdn.example/c.js"></script>`);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.example; " +
        "style-src 'unsafe-inline' https://cdn.example; " +
        "img-src https://cdn.example data:; font-src https://cdn.example data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
  });

  it("sorts several origins, whatever order they appear in the document", () => {
    // Document order is z, a, m — `scriptSrcs` keeps that order, and the CSP
    // must not, or one template would have two headers.
    const template = parseOk(
      `${FALLBACK}<script src="https://z.example/c.js"></script>` +
        '<link rel="stylesheet" href="https://a.example/s.css">' +
        "<style>@import url(https://m.example/i.css);</style>",
    );
    expect(template.scriptSrcs).toEqual([
      "https://z.example/c.js",
      "https://a.example/s.css",
      "https://m.example/i.css",
    ]);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://a.example https://m.example https://z.example; " +
        "style-src 'unsafe-inline' https://a.example https://m.example https://z.example; " +
        "img-src https://a.example https://m.example https://z.example data:; " +
        "font-src https://a.example https://m.example https://z.example data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
  });

  it("collapses one origin reached through three different channels to one entry", () => {
    const template = parseOk(
      `${FALLBACK}<script src="https://cdn.example/a.js"></script>` +
        '<script src="https://cdn.example/b.js"></script>' +
        '<link rel="stylesheet" href="https://cdn.example/s.css">',
    );
    expect(template.scriptSrcs).toHaveLength(3);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.example; " +
        "style-src 'unsafe-inline' https://cdn.example; " +
        "img-src https://cdn.example data:; font-src https://cdn.example data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
  });

  /**
   * 🔴 **The R152 row. A table without it does not test the amendment.**
   *
   * `img.example` is fetched as an image and `nav.example` is a meta-refresh
   * navigation target; neither is code, and `remoteOrigins` is deliberately
   * the superset that carries both. A single-list substitution would grant
   * both `script-src`, and with `'unsafe-inline'` already granted the
   * template's own inline script could then pull code from the host a human
   * filed under "images".
   */
  it("grants script execution ONLY to origins that arrived as code (R152)", () => {
    const template = parseOk(
      `${FALLBACK}<script src="https://cdn.example/c.js"></script>` +
        '<img src="https://img.example/p.gif">' +
        '<meta http-equiv="refresh" content="99;url=https://nav.example/x">',
    );
    expect(template.scriptSrcs).toEqual(["https://cdn.example/c.js"]);
    expect(template.remoteOrigins).toEqual([
      "https://cdn.example",
      "https://img.example",
      "https://nav.example",
    ]);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.example; " +
        "style-src 'unsafe-inline' https://cdn.example; " +
        "img-src https://cdn.example https://img.example https://nav.example data:; " +
        "font-src https://cdn.example https://img.example https://nav.example data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
  });

  it("collapses the default https port and keeps a non-default one", () => {
    const template = parseOk(
      `${FALLBACK}<script src="https://a.example:443/c.js"></script>` +
        '<script src="https://a.example:8443/d.js"></script>',
    );
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://a.example https://a.example:8443; " +
        "style-src 'unsafe-inline' https://a.example https://a.example:8443; " +
        "img-src https://a.example https://a.example:8443 data:; " +
        "font-src https://a.example https://a.example:8443 data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
  });

  /**
   * 🔴 **`scriptSrcs` is NOT https-only, and this is the case that proves it.**
   * Measured against the merged `parseTemplate`:
   * `<style>@import url(data:text/css,x)</style>` validates CLEAN and pushes
   * the `data:` URL into `scriptSrcs` — the CSS path allows `data:` because a
   * `data:` URL in CSS is an image or a font. `new URL("data:…").origin` is
   * the four characters `null`, and in a CSP `null` is a HOST NAME, not the
   * keyword `'none'`. A naive `new URL(u).origin` over `scriptSrcs` would put
   * it in `script-src`.
   */
  it("contributes no host for a `data:` entry in scriptSrcs, and never the string `null`", () => {
    const template = parseOk(`${FALLBACK}<style>@import url(data:text/css,x);</style>`);
    expect(template.scriptSrcs).toEqual(["data:text/css,x"]);
    expect(frameCsp(template)).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; " +
        "form-action 'none'; frame-ancestors 'self'; frame-src 'none'; child-src 'none'; " +
        "object-src 'none'; base-uri 'none'; manifest-src 'none'; media-src 'none'; " +
        "worker-src 'none'",
    );
  });

  it("contributes no host for a scheme-only `https:` src, which names none", () => {
    // `<script src="https:">` passes template validation, which reads the
    // scheme and nothing else. Measured: `new URL("https:")` throws.
    const template: Pick<ParsedTemplate, "scriptSrcs" | "remoteOrigins"> = {
      scriptSrcs: ["https:"],
      remoteOrigins: [],
    };
    expect(frameCsp(template)).toContain("script-src 'unsafe-inline'; style-src");
  });

  it("normalises host case and ignores the path, so two URLs on one host are one source", () => {
    const template: Pick<ParsedTemplate, "scriptSrcs" | "remoteOrigins"> = {
      scriptSrcs: ["https://CDN.Example/a.js", "https://cdn.example/deep/b.js"],
      remoteOrigins: ["https://cdn.example"],
    };
    expect(frameCsp(template)).toContain(
      "script-src 'unsafe-inline' https://cdn.example; style-src 'unsafe-inline' https://cdn.example;",
    );
  });
});

describe("frameCsp — the superset invariant (Ruling 1)", () => {
  /**
   * § 6b renders "everything else" on the go-live review screen as the SET
   * DIFFERENCE of `remoteOrigins` and `scriptSrcs`. If a code origin were
   * missing from `remoteOrigins`, that host would execute code in the frame
   * and never appear on the screen the human approves — so the relationship
   * is checked rather than assumed, and it can only be violated by a
   * `ParsedTemplate` that did not come from `parseTemplate`.
   */
  it("throws when a script origin is absent from the remote-host inventory", () => {
    const template: Pick<ParsedTemplate, "scriptSrcs" | "remoteOrigins"> = {
      scriptSrcs: ["https://ghost.example/c.js"],
      remoteOrigins: ["https://cdn.example"],
    };
    expect(() => frameCsp(template)).toThrow(WolfError);
    expect(() => frameCsp(template)).toThrow(/remote-host inventory/);
    try {
      frameCsp(template);
      expect.unreachable("frameCsp should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WolfError);
      expect((error as WolfError).kind).toBe("internal");
      expect((error as WolfError).details).toMatchObject({ missing: ["https://ghost.example"] });
    }
  });

  it("holds for every template `parseTemplate` accepts", () => {
    const fixtures = [
      `${FALLBACK}<div data-wolf-slot="a">x</div>`,
      `${FALLBACK}<script src="https://cdn.example/c.js"></script>`,
      `${FALLBACK}<link rel="stylesheet" href="https://s.example/a.css">`,
      `${FALLBACK}<style>@import url(https://i.example/a.css);</style>`,
      `${FALLBACK}<style>@import url(data:text/css,x);</style>`,
      `${FALLBACK}<img src="https://img.example/p.gif">`,
      `${FALLBACK}<iframe srcdoc="&lt;script src=&quot;https://n.example/n.js&quot;&gt;&lt;/script&gt;"></iframe>`,
    ];
    for (const html of fixtures) {
      const template = parseOk(html);
      const codeOrigins = template.scriptSrcs
        .filter((url) => /^https:/i.test(url))
        .map((url) => new URL(url).origin);
      for (const origin of codeOrigins) {
        expect(template.remoteOrigins).toContain(origin);
      }
    }
  });
});

/* ================================================================== */
/* the document skeleton                                               */
/* ================================================================== */

describe("composeFrame — the document skeleton", () => {
  it("owns the doctype, html, head and body that the template is forbidden to carry", () => {
    const template = parseOk(`${FALLBACK}<p>hello</p>`);
    const { html } = composeFrame({ template, slots: {}, series: NO_SERIES });

    expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n')).toBe(true);
    expect(html.endsWith("\n</body>\n</html>\n")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');

    // The template is a FRAGMENT and `parseTemplate` refuses these, so the
    // skeleton is the only place each may appear.
    expect(html.match(/<html[\s>]/g)).toHaveLength(1);
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html.match(/<body>/g)).toHaveLength(1);
  });

  it("places the template fragment inside <body>", () => {
    const template = parseOk(`${FALLBACK}<p>hello</p>`);
    const { html } = composeFrame({ template, slots: {}, series: NO_SERIES });
    expect(bodyOf(html)).toBe(`${FALLBACK}<p>hello</p>`);
  });

  /**
   * The CSP travels as a HEADER (W21) and never as a `<meta http-equiv>`. A
   * meta policy silently ignores `sandbox` and `frame-ancestors`, two of the
   * four directives `default-src` does not cover, so a meta copy would read
   * as a second line of defence while being neither.
   */
  it("emits no meta CSP, which would silently drop sandbox and frame-ancestors", () => {
    const template = parseOk(`${FALLBACK}<p>hello</p>`);
    const { html } = composeFrame({ template, slots: {}, series: NO_SERIES });
    expect(html).not.toMatch(/http-equiv/i);
  });
});

/** The bytes between the skeleton's own `<body>\n` and its `\n</body>`. */
function bodyOf(html: string): string {
  const open = html.indexOf("<body>\n") + "<body>\n".length;
  const close = html.lastIndexOf("\n</body>");
  return html.slice(open, close);
}

/* ================================================================== */
/* byte-exactness of everything outside a slot                         */
/* ================================================================== */

describe("composeFrame — every byte outside a slot's children is emitted unchanged", () => {
  /**
   * `structureHash` is sha256 of the stored bytes with no normalisation
   * whatsoever, so a frame that re-serialised the fragment would render
   * something whose hash no longer matches the lock. Every construct below is
   * one a re-serialising composer would quietly change: a comment, single
   * quotes, run-together whitespace inside a tag, an unexpanded character
   * reference, an attribute order, and a newline inside a `<script>` body
   * where whitespace is semantically significant.
   *
   * ⚠️ **Three properties of this fixture are load-bearing and easy to lose
   * while editing it.** Each of them is the only thing standing between a
   * whole class of re-serialisation and a green suite:
   *
   *  - **UPPERCASE, outside a slot.** `<SECTION>` and `Math.max` are here so
   *    that `body.toLowerCase()` reddens. That is not a hypothetical edit —
   *    lowercasing tag names is exactly what a DOM re-serialiser does, and it
   *    would rewrite every template's inline chart code (`Math.max`,
   *    `window.__WOLF_SERIES__`) and break every report in the product. The
   *    slot children carry uppercase too, but they are REMOVED, so they
   *    cannot cover this.
   *  - **A LEADING newline**, so `.trimStart()` on the prefix slice reddens.
   *  - **A TRAILING newline**, so `.trimEnd()` on the tail slice reddens.
   */
  const AWKWARD =
    `\n${FALLBACK}\n` +
    "<!-- keep me -->\n" +
    "<SECTION class='a'   id=\"s\" data-x>&amp;&nbsp;<b>Bold</b></SECTION>\n" +
    '<div data-wolf-slot="headline">OLD CONTENT</div>\n' +
    '<script>var s = Math.max(1, 2); if (a\n) { return\n{} }</script>\n' +
    '<p data-wolf-slot="commentary">OLD TOO</p>\n';

  it("reproduces the fragment exactly, minus the slot children, when nothing is filled", () => {
    const template = parseOk(AWKWARD);
    const { html } = composeFrame({ template, slots: {}, series: NO_SERIES });

    // The expectation is derived from the PARSER's ranges, not from
    // composeFrame's own splicing: cut each slot's children out of the stored
    // bytes and everything left must survive verbatim.
    let expected = "";
    let cursor = 0;
    for (const slot of template.slots) {
      expected += AWKWARD.slice(cursor, slot.contentStart);
      cursor = slot.contentEnd;
    }
    expected += AWKWARD.slice(cursor);

    expect(bodyOf(html)).toBe(expected);
  });

  it("keeps each awkward construct verbatim, and drops the old slot children", () => {
    const template = parseOk(AWKWARD);
    const { html } = composeFrame({
      template,
      slots: { headline: "<p>fresh</p>" },
      series: NO_SERIES,
    });
    const body = bodyOf(html);

    expect(body).toContain("<!-- keep me -->");
    expect(body).toContain("<SECTION class='a'   id=\"s\" data-x>&amp;&nbsp;<b>Bold</b></SECTION>");
    expect(body).toContain('<script>var s = Math.max(1, 2); if (a\n) { return\n{} }</script>');
    expect(body.startsWith("\n")).toBe(true);
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain('<div data-wolf-slot="headline"><p>fresh</p></div>');
    expect(body).not.toContain("OLD CONTENT");
    expect(body).not.toContain("OLD TOO");
  });

  it("does not touch a template with no slots at all", () => {
    const html = `${FALLBACK}<p>&lt;not a tag&gt;</p><!-- c -->`;
    const template = parseOk(html);
    expect(template.slots).toEqual([]);
    expect(bodyOf(composeFrame({ template, slots: {}, series: NO_SERIES }).html)).toBe(html);
  });
});

/* ================================================================== */
/* the injection site                                                  */
/* ================================================================== */

describe("composeFrame — the series injection is the last child of <head>", () => {
  const SERIES: SeriesPayload = {
    gold: { unit: "USD/oz", version: 3, points: [{ tMs: 1_700_000_000_000, v: 2_040.5 }] },
  };

  it("sits immediately before </head>, asserted by index", () => {
    const template = parseOk(`${FALLBACK}<script>window.CHART = 1;</script>`);
    const { html } = composeFrame({ template, slots: {}, series: SERIES });

    const injectionEnd = html.indexOf("</script>") + "</script>".length;
    const headEnd = html.indexOf("</head>");
    // Nothing but the skeleton's own newline separates them, and the head
    // ends before the body starts — so no template content can ever sit
    // between the assignment and the first script that reads it.
    expect(html.slice(injectionEnd, headEnd)).toBe("\n");
    expect(injectionEnd).toBeLessThan(headEnd);
    expect(headEnd).toBeLessThan(html.indexOf("<body>"));
  });

  it("is the only script in the head, and comes after both metas", () => {
    const template = parseOk(`${FALLBACK}<script>window.CHART = 1;</script>`);
    const { html } = composeFrame({ template, slots: {}, series: SERIES });
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head.match(/<script/g)).toHaveLength(1);
    expect(head.indexOf("<script")).toBeGreaterThan(head.indexOf('<meta name="viewport"'));
  });

  it("assigns the payload to window.__WOLF_SERIES__, verbatim", () => {
    const template = parseOk(`${FALLBACK}<p>x</p>`);
    const { html } = composeFrame({ template, slots: {}, series: SERIES });
    expect(html).toContain(
      '<script>window.__WOLF_SERIES__ = ' +
        '{"gold":{"unit":"USD/oz","version":3,"points":[{"tMs":1700000000000,"v":2040.5}]}};' +
        "</script>",
    );
  });

  it("injects an empty object when there are no metrics, never `undefined`", () => {
    const template = parseOk(`${FALLBACK}<p>x</p>`);
    const { html } = composeFrame({ template, slots: {}, series: NO_SERIES });
    expect(html).toContain("<script>window.__WOLF_SERIES__ = {};</script>");
  });
});

describe("composeFrame — the injected text cannot steer the HTML tokenizer", () => {
  /** The text between the injection script's tags. */
  function injectedScript(html: string): string {
    const open = html.indexOf("<script>") + "<script>".length;
    return html.slice(open, html.indexOf("</script>"));
  }

  /**
   * One assertion covering the whole class. `<` is the only character that
   * can start a tokenizer transition out of script data, so a script body
   * with no `<` in it cannot be ended early, cannot open a comment, and
   * cannot enter the double-escaped state.
   */
  it("contains no `<` at all, whatever the payload holds", () => {
    const template = parseOk(`${FALLBACK}<p>x</p>`);
    const hostile: SeriesPayload = {
      "a": { unit: "</script><img src=x onerror=alert(1)>", version: 1, points: [] },
      "b": { unit: "<!--<script>", version: 1, points: [] },
      "c": { unit: "</SCRIPT >", version: 1, points: [] },
      "d": { unit: "<!-- <script> -->", version: 1, points: [] },
    };
    const { html } = composeFrame({ template, slots: {}, series: hostile });
    expect(injectedScript(html)).not.toContain("<");
  });

  /**
   * 🔴 **The item W18's Notes handed to W19, and it is real.** W18's
   * `serialiseSeriesPayload` neutralises `</script`; it does not touch
   * `<!--`, which is a DIFFERENT tokenizer transition — it enters *script
   * data escaped* state, and a following `<script` enters *script data
   * double escaped* state, in which `</script>` no longer ends the element.
   *
   * MEASURED with parse5 8 on 2026-08-26, on the exact document this module
   * composes. With a `unit` of `<!--<script>` and no escaping, the parsed
   * document contained **`html, head, script, body` and NOTHING ELSE** — the
   * template fragment, its `[data-wolf-fallback]` element and its own chart
   * `<script>` were all swallowed into the injection script's text. With `<`
   * escaped, the identical document parsed to
   * **`html, head, script, body, div, script`**.
   *
   * A model chooses `Metric.unit` in the locked spec, so this is reachable
   * from content and not only from a bug.
   */
  it("neutralises `<!--<script>`, which W18's `</script` escape does not cover", () => {
    const template = parseOk(`${FALLBACK}<script>window.CHART = 1;</script>`);
    const series: SeriesPayload = {
      gold: { unit: "USD/oz <!--<script>", version: 1, points: [] },
    };
    const { html } = composeFrame({ template, slots: {}, series });
    expect(html).not.toContain("<!--<script>");
    expect(injectedScript(html)).toContain("\\u003c!--\\u003cscript>");
  });

  it("round-trips the payload through JSON.parse unchanged", () => {
    const template = parseOk(`${FALLBACK}<p>x</p>`);
    const series: SeriesPayload = {
      gold: { unit: "</script> & <!--<script>   ok", version: 7, points: [{ tMs: 5, v: -1.5 }] },
    };
    const { html } = composeFrame({ template, slots: {}, series });
    expect(JSON.parse(injectedScript(html).replace(/^window\.__WOLF_SERIES__ = /, "").replace(/;$/, ""))).toEqual(
      series,
    );
  });

  /**
   * The escape must survive evaluation as JavaScript, not merely as JSON —
   * the browser evaluates it as an object literal. `new Function` over a
   * fixed fixture is the cheapest honest oracle for that; there is no
   * network and no dynamic input.
   */
  it("evaluates as JavaScript to the same payload", () => {
    const template = parseOk(`${FALLBACK}<p>x</p>`);
    const series: SeriesPayload = {
      gold: { unit: "</script><!--<script>", version: 2, points: [{ tMs: 1, v: 2 }] },
    };
    const { html } = composeFrame({ template, slots: {}, series });
    const globals: { __WOLF_SERIES__?: SeriesPayload } = {};
    new Function("window", injectedScript(html))(globals);
    expect(globals.__WOLF_SERIES__).toEqual(series);
  });
});

/* ================================================================== */
/* slot filling                                                        */
/* ================================================================== */

describe("composeFrame — slot content is sanitised on the way in", () => {
  const TEMPLATE = `${FALLBACK}<div data-wolf-slot="headline">OLD</div>`;

  /**
   * ⚠️ **R146: check WHY the hostile tokens are absent.** A composer that
   * dropped the slot's content entirely would pass every "not.toContain"
   * below while rendering nothing at all, so the benign half of the same
   * input is asserted PRESENT in the same test. Measured: `sanitiseSlot`
   * turns this exact input into `<p>keep</p>e` with `strippedCount: 6`.
   */
  it("strips script, handlers and URLs while keeping the prose of the same input", () => {
    const template = parseOk(TEMPLATE);
    const hostile =
      '<p>keep</p><img src=x onerror=alert(1)><script>alert(2)</script>' +
      '<a href="https://evil.example">e</a>';
    const { html, strippedCount } = composeFrame({
      template,
      slots: { headline: hostile },
      series: NO_SERIES,
    });

    expect(html).toContain('<div data-wolf-slot="headline"><p>keep</p>e</div>');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("alert(2)");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<img");
    expect(strippedCount).toBe(6);
  });

  it("reports per-slot strip counts, and zero for a filled slot that was clean", () => {
    const template = parseOk(
      `${FALLBACK}<div data-wolf-slot="a">x</div><div data-wolf-slot="b">y</div>` +
        '<div data-wolf-slot="c">z</div>',
    );
    const { strippedCount, strippedBySlot } = composeFrame({
      template,
      slots: { a: "<p>clean</p>", b: "<script>alert(1)</script>" },
      series: NO_SERIES,
    });

    expect(strippedBySlot["a"]).toBe(0);
    expect(strippedBySlot["b"]).toBeGreaterThan(0);
    // `c` was never filled, so it is absent — "filled and clean" and "never
    // filled" must stay distinguishable, the same distinction W20 keeps.
    expect(Object.keys(strippedBySlot).sort()).toEqual(["a", "b"]);
    expect(strippedCount).toBe((strippedBySlot["a"] ?? -1) + (strippedBySlot["b"] ?? -1));
  });

  it("renders an unfilled slot as an empty element, never the string `undefined`", () => {
    const template = parseOk(TEMPLATE);
    const { html, strippedCount } = composeFrame({ template, slots: {}, series: NO_SERIES });
    expect(html).toContain('<div data-wolf-slot="headline"></div>');
    expect(html).not.toContain("undefined");
    expect(strippedCount).toBe(0);
  });

  it("treats an explicit null the same as an absent key (the spec-null convention)", () => {
    const template = parseOk(TEMPLATE);
    const { html, strippedCount, strippedBySlot } = composeFrame({
      template,
      slots: { headline: null },
      series: NO_SERIES,
    });
    expect(html).toContain('<div data-wolf-slot="headline"></div>');
    expect(html).not.toContain("null</div>");
    // ⚠️ The COUNTS are what make this row a test of the `!== null` half of
    // the guard rather than of the `!== undefined` half. `sanitiseSlot(null)`
    // returns `{html: "", strippedCount: 1}` — identical HTML, different
    // count — so without these two lines, deleting `raw !== null` leaves the
    // whole suite green and a slot the tick simply did not write that day
    // fires W23's "content was stripped" badge.
    expect(strippedCount).toBe(0);
    expect(strippedBySlot).toEqual({});
  });

  /**
   * 🔴 **`SLOT_ID_PATTERN` accepts `constructor`, and it is the ONE
   * `Object.prototype` key that does** — lowercase, starts with a letter, at
   * most 32 characters. A bare `slots[slot.id]` therefore returns the
   * inherited constructor for a slot the tick did not write.
   *
   * MEASURED on the unguarded build, 2026-08-26: this exact template composed
   * to `<div data-wolf-slot="constructor">function Object() { [native code] }
   * </div>`, with `strippedCount: 0` and `strippedBySlot: {"constructor": 0}`.
   *
   * It is a worse sentinel than the `undefined` this block already forbids:
   * prose-shaped, so a human reads it as the day's analysis; silent, because
   * it strips to nothing and W23's degraded notice is gated on
   * `stripped_count > 0`; and permanent, because the template is
   * model-authored and frozen by `structureHash`, so an approved one ships it
   * on every tick until an amendment renames the slot. Not XSS — it
   * stringifies without a `<`.
   */
  it("renders a slot named `constructor` empty, not as Object.prototype's", () => {
    const template = parseOk(`${FALLBACK}<div data-wolf-slot="constructor">OLD</div>`);
    const { html, strippedCount, strippedBySlot } = composeFrame({
      template,
      slots: {},
      series: NO_SERIES,
    });
    expect(html).toContain('<div data-wolf-slot="constructor"></div>');
    expect(html).not.toContain("native code");
    expect(html).not.toContain("function Object");
    expect(strippedCount).toBe(0);
    expect(strippedBySlot).toEqual({});
  });

  it("still fills a slot named `constructor` when the tick did write one", () => {
    const template = parseOk(`${FALLBACK}<div data-wolf-slot="constructor">OLD</div>`);
    const { html, strippedBySlot } = composeFrame({
      template,
      slots: { constructor: "<p>real content</p>" },
      series: NO_SERIES,
    });
    expect(html).toContain('<div data-wolf-slot="constructor"><p>real content</p></div>');
    expect(strippedBySlot).toEqual({ constructor: 0 });
  });

  it("renders an empty string as an empty element", () => {
    const template = parseOk(TEMPLATE);
    const { html } = composeFrame({ template, slots: { headline: "" }, series: NO_SERIES });
    expect(html).toContain('<div data-wolf-slot="headline"></div>');
  });

  it("ignores a slot id the template does not declare (W20 reports it as drift)", () => {
    const template = parseOk(TEMPLATE);
    const { html } = composeFrame({
      template,
      slots: { headline: "<p>in</p>", ghost: "<p>SHOULD NOT APPEAR</p>" },
      series: NO_SERIES,
    });
    expect(html).toContain("<p>in</p>");
    expect(html).not.toContain("SHOULD NOT APPEAR");
  });

  /**
   * THE COMPOSED-DOCUMENT SWEEP, pinned.
   *
   * Every vector below was composed into a full frame — twice over, crossed
   * with five hostile series `unit` values — and the RESULT parsed with
   * parse5 8 on 2026-08-26: **95 combinations, zero problems.** The oracle
   * asserted, on the parsed tree rather than on the text: exactly three
   * `<script>` elements (the injection, the template's remote one and the
   * template's inline one); no `img`, `iframe`, `object`, `form`, `base`,
   * `style`, `svg` or `math` anywhere; no attribute whose name starts with
   * `on`; the `[data-wolf-fallback]` element still present, which is what
   * proves the document was not swallowed; and exactly two `data-wolf-slot`
   * attributes, which is what proves no phantom slot region was manufactured.
   *
   * ⚠️ **The oracle was checked to be live**, which is the point of running
   * it: with the injection-site escape removed it reported **38** problems,
   * and with `sanitiseSlot` bypassed **70**, including `script count 5` —
   * a real XSS. A sweep that cannot go red is not a sweep.
   *
   * parse5 is not a declared dependency of `api/` (`template.test.ts` sets
   * that convention), so what runs here is the text-level residue of the same
   * vectors. It is weaker than the parse, and it is a regression net, not the
   * proof — the proof is the measurement above.
   */
  const HOSTILE_SLOTS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "</section><script>alert(1)</script><section>",
    "</h1></body></html><script>alert(1)</script>",
    "<svg><script>alert(1)</script></svg>",
    "<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>",
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    "<style>@import url(https://evil.example/x.css)</style>",
    '<a href="javascript:alert(1)">x</a>',
    '<form action="https://evil.example"><input name=a></form>',
    '<div id="chart">decoy</div>',
    '<p data-wolf-slot="fake">phantom</p>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<object data="https://evil.example/x"></object>',
    "<noscript><img src=x onerror=alert(1)></noscript>",
    "<template><script>alert(1)</script></template>",
    "<!--><script>alert(1)</script>",
  ];

  it.each(HOSTILE_SLOTS)("leaves nothing executable behind for %j", (hostile) => {
    const template = parseOk(
      `${FALLBACK}<h1 data-wolf-slot="headline">H</h1><section data-wolf-slot="body">B</section>`,
    );
    const { html } = composeFrame({
      template,
      slots: { headline: hostile, body: hostile },
      series: { gold: { unit: "<!--<script></script>", version: 1, points: [] } },
    });

    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("javascript:");
    // The template's own two slot attributes and no third: a slot cannot
    // manufacture a slot region, which would otherwise read as W20 drift on
    // a healthy report.
    expect(html.match(/data-wolf-slot/g)).toHaveLength(2);
    // The fallback survived, so the document was not swallowed.
    expect(html).toContain("data-wolf-fallback");
  });

  it("fills several slots independently, each with its own content", () => {
    const template = parseOk(
      `${FALLBACK}<div data-wolf-slot="one">1</div><span>between</span>` +
        '<div data-wolf-slot="two">2</div>',
    );
    const { html } = composeFrame({
      template,
      slots: { one: "<p>first</p>", two: "<p>second</p>" },
      series: NO_SERIES,
    });
    expect(bodyOf(html)).toBe(
      `${FALLBACK}<div data-wolf-slot="one"><p>first</p></div><span>between</span>` +
        '<div data-wolf-slot="two"><p>second</p></div>',
    );
  });
});

/* ================================================================== */
/* Ruling 2 — the raw-text slot, refused twice                         */
/* ================================================================== */

/**
 * A `ParsedTemplate` assembled by hand, which is the whole point of the
 * composition-time guard: it never went through the validator, so the guard
 * is reachable on its own rather than being a second test of the validator
 * (R148 — a guard that can only fail through the other check is a comment).
 */
function handBuiltTemplate(html: string, slot: { id: string; tagName: string }): ParsedTemplate {
  const open = html.indexOf(">") + 1;
  const close = html.indexOf("</", open);
  return {
    html,
    byteLength: Buffer.byteLength(html, "utf8"),
    structureHash: "0".repeat(64),
    slotIds: [slot.id],
    slots: [{ id: slot.id, tagName: slot.tagName, contentStart: open, contentEnd: close }],
    scriptSrcs: [],
    remoteOrigins: [],
  };
}

describe("composeFrame — refuses a slot on an element whose children are text (Ruling 2)", () => {
  /**
   * `sanitiseSlot`'s output is safe in ELEMENT CONTENT and nowhere else.
   * R150(3) built the breakout end to end and it failed — but only because
   * of a DOMPurify attribute regex, i.e. the path is closed by a library
   * rather than by anything this codebase wrote.
   *
   * `noscript` and `template` are in this list and NOT in `template.ts`'s:
   * there the inert-element rule already refuses both, so an entry would only
   * change the message; here there is no inert rule in front of the guard, so
   * both are load-bearing.
   */
  const UNFILLABLE = [
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
    "noscript",
    "template",
  ];

  it.each(UNFILLABLE)("throws for a slot declared on <%s>", (tagName) => {
    const template = handBuiltTemplate(`<${tagName} data-wolf-slot="a">old</${tagName}>`, {
      id: "a",
      tagName,
    });
    expect(() => composeFrame({ template, slots: { a: "<p>x</p>" }, series: NO_SERIES })).toThrow(
      new RegExp(`slot "a" is declared on \`<${tagName}>\``),
    );
  });

  it("throws even when the slot is unfilled — the template itself is the defect", () => {
    const template = handBuiltTemplate('<style data-wolf-slot="a">old</style>', {
      id: "a",
      tagName: "style",
    });
    try {
      composeFrame({ template, slots: {}, series: NO_SERIES });
      expect.unreachable("composeFrame should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WolfError);
      expect((error as WolfError).kind).toBe("internal");
    }
  });

  it("does not throw for an ordinary container", () => {
    const template = handBuiltTemplate('<div data-wolf-slot="a">old</div>', {
      id: "a",
      tagName: "div",
    });
    expect(() =>
      composeFrame({ template, slots: { a: "<p>x</p>" }, series: NO_SERIES }),
    ).not.toThrow();
  });
});

/* ================================================================== */
/* the slot-range guard                                                */
/* ================================================================== */

describe("composeFrame — refuses slot ranges it cannot splice", () => {
  /**
   * `parseTemplate` emits slots in document order and refuses nesting, so
   * neither shape below can come from it. Without the guard, a
   * `ParsedTemplate` that broke either would have this function splice
   * overlapping ranges and emit corrupt markup, silently — the failure mode
   * a locked, hashed template exists to make impossible.
   */
  function twoSlots(html: string, ranges: Array<[number, number]>): ParsedTemplate {
    return {
      html,
      byteLength: Buffer.byteLength(html, "utf8"),
      structureHash: "0".repeat(64),
      slotIds: ["a", "b"],
      slots: ranges.map(([contentStart, contentEnd], index) => ({
        id: index === 0 ? "a" : "b",
        tagName: "div",
        contentStart,
        contentEnd,
      })),
      scriptSrcs: [],
      remoteOrigins: [],
    };
  }

  const HTML = '<div data-wolf-slot="a">11</div><div data-wolf-slot="b">22</div>';

  it("throws when a later slot starts before an earlier one ended", () => {
    const template = twoSlots(HTML, [
      [24, 26],
      [10, 12],
    ]);
    expect(() => composeFrame({ template, slots: {}, series: NO_SERIES })).toThrow(
      /document order and disjoint/,
    );
  });

  it("throws when a slot's range runs backwards", () => {
    const template = twoSlots(HTML, [
      [26, 24],
      [56, 58],
    ]);
    expect(() => composeFrame({ template, slots: {}, series: NO_SERIES })).toThrow(
      /document order and disjoint/,
    );
  });

  it("accepts two disjoint ranges in document order", () => {
    const template = twoSlots(HTML, [
      [24, 26],
      [56, 58],
    ]);
    expect(() => composeFrame({ template, slots: {}, series: NO_SERIES })).not.toThrow();
  });
});

/* ================================================================== */
/* purity                                                              */
/* ================================================================== */

describe("composeFrame — purity", () => {
  it("is deterministic: the same input composes byte-identically twice", () => {
    const template = parseOk(`${FALLBACK}<div data-wolf-slot="a">x</div>`);
    const input = {
      template,
      slots: { a: "<p>y</p><img src=x onerror=alert(1)>" },
      series: { m: { unit: "u", version: 1, points: [{ tMs: 1, v: 2 }] } },
    };
    const first = composeFrame(input);
    const second = composeFrame(input);
    expect(second.html).toBe(first.html);
    expect(second.csp).toBe(first.csp);
    expect(second.strippedCount).toBe(first.strippedCount);
  });

  it("does not mutate the template it was handed", () => {
    const template = parseOk(`${FALLBACK}<div data-wolf-slot="a">x</div>`);
    const before = JSON.stringify(template);
    composeFrame({ template, slots: { a: "<p>y</p>" }, series: NO_SERIES });
    expect(JSON.stringify(template)).toBe(before);
  });

  it("returns the same CSP `frameCsp` derives for that template", () => {
    const template = parseOk(`${FALLBACK}<script src="https://cdn.example/c.js"></script>`);
    expect(composeFrame({ template, slots: {}, series: NO_SERIES }).csp).toBe(frameCsp(template));
  });
});
