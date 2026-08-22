/**
 * The report template parser — the function that makes a template LOCKABLE.
 *
 * design/2026-08-20-agent-wolf.md § W16 ("Template parser, structure hash,
 * and the report config") is the ticket. Everything downstream trusts what
 * this module decides: W17's `validateTemplate` returns its `ParsedTemplate`,
 * W19 fills the slot ranges it reports, W20 compares a tick's filled slots
 * against its `slotIds`, and W21/W24 show a human the `scriptSrcs` they are
 * approving before go-live. A parser that is merely PERMISSIVE here becomes a
 * forgeable lock later, so every rule below fails closed: anything this module
 * cannot understand is a validation error, never a shrug.
 *
 * `parseTemplate` is PURE and takes its byte budget as a PARAMETER — it reads
 * neither configuration nor the process environment. `WOLF_REPORT_MAX_BYTES`
 * lives in `api/src/config.ts`, and W21's route is what passes it in. A test
 * scans this file's own source and fails if either reader ever appears in it,
 * so the two names are deliberately not written out here.
 *
 * Four properties are load-bearing and are spelled out where they are
 * implemented below:
 *
 *  1. **`structureHash` is sha256 of the stored bytes with NO normalisation.**
 *  2. **A duplicate slot id is an ERROR**, never last-wins.
 *  3. **The template is a FRAGMENT** — `composeFrame` (W19) owns the skeleton.
 *  4. **Every `src`/`href` is `https:`**, with a DISTINCT message per vector.
 *
 * ⚠️ This module does not SANITISE anything and must not start. It never
 * mutates the HTML it is given: it measures, locates and refuses. Slot
 * *content* written by the daily tick is a different input with a different
 * threat model, and W17's `sanitiseSlot` is the only thing that touches it.
 * The whole locking design rests on the asymmetry — the same `<script>` text
 * passes here and is stripped there — so "hardening" this file by stripping
 * would silently break the lock.
 *
 * The scanner below is hand-written rather than DOM-based on purpose: this
 * ticket adds no dependency (W17 owns `api/package.json` and brings in the
 * one sanitiser, `isomorphic-dompurify`), and a validator has no business
 * building a tree it would then have to serialise back. It follows the HTML
 * tokenizer closely enough for the decisions it makes — raw-text elements,
 * void elements, comments, bogus comments, all three attribute-value
 * quotings — and treats anything it cannot tokenise as an error.
 *
 * ⚠️ **A hand-written scanner earns its keep only where it agrees with a real
 * parser about what a TAG is**, and it has been wrong twice, both times in
 * the same shape: a region this file skipped and a browser did not. Round one
 * was the comment close (`commentEnd`); round two was raw text inside SVG and
 * MathML (`FOREIGN_ROOTS`). Both were found by running parse5 over the same
 * bytes and diffing, and both let a remote script through `scriptSrcs`
 * unreported. Before changing anything about what this scanner SKIPS, do that
 * diff again — the rule is that this module may be stricter than a browser,
 * never more permissive.
 */

import { createHash } from "node:crypto";
import { WolfError } from "../errors.js";

/* ------------------------------------------------------------------ */
/* the public shape                                                    */
/* ------------------------------------------------------------------ */

/**
 * `{path, message}`, deliberately the same shape as W3's `SpecError`, so
 * W21's 422 body and W24's review screen render template failures and spec
 * failures through one code path. `path` is a locator (`"template"`,
 * `"[data-wolf-slot]"`, `"script[src]"`), not a JSON pointer — there is no
 * JSON here to point into.
 */
export interface TemplateError {
  path: string;
  message: string;
  /** Character offset into the template of the offending construct, when there is one. */
  offset?: number;
}

/** One `[data-wolf-slot]` region, located in the ORIGINAL bytes. */
export interface TemplateSlot {
  id: string;
  /** Offset of the slot element's first child byte (i.e. just past its start tag). */
  contentStart: number;
  /** Offset just past the slot element's last child byte (i.e. at its end tag). */
  contentEnd: number;
}

export interface ParsedTemplate {
  /** The bytes handed in, verbatim. Never normalised, never re-serialised. */
  html: string;
  /** `Buffer.byteLength(html, "utf8")` — the number the size limit is about. */
  byteLength: number;
  /** sha256 of `html`, lowercase hex. See `structureHash`. */
  structureHash: string;
  /** Slot ids in DOCUMENT ORDER. */
  slotIds: string[];
  /** The same slots, with their content ranges, for W19's filler. */
  slots: TemplateSlot[];
  /** Every external script and stylesheet URL, in document order (W24 shows these to a human). */
  scriptSrcs: string[];
}

export type ParseTemplateResult =
  | { valid: true; template: ParsedTemplate }
  | { valid: false; errors: TemplateError[] };

/**
 * Slot ids: lowercase, digit- and hyphen-bearing, ≤32 characters.
 *
 * The cap is not cosmetic — a slot id is a JSON key in the daily `report`
 * memory and an identifier a human reads on a drift notice, and both want a
 * short, kebab, unambiguous token.
 */
export const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The attribute that declares a slot. */
export const SLOT_ATTRIBUTE = "data-wolf-slot";

/**
 * The attribute marking the "the chart never rendered" element. MANDATORY:
 * a CDN failure is invisible inside an opaque, sandboxed frame, so this
 * element is the operator's only signal. (The template's own script is what
 * removes it once the chart draws — see W25's `report-authoring.md`.)
 */
export const FALLBACK_ATTRIBUTE = "data-wolf-fallback";

/* ------------------------------------------------------------------ */
/* the structure hash                                                  */
/* ------------------------------------------------------------------ */

/**
 * sha256 of the STORED BYTES, with **no normalisation whatsoever**,
 * lowercase hex.
 *
 * ⚠️ Do not add trimming, whitespace collapsing or attribute reordering
 * "for robustness". An earlier draft of the plan called for whitespace
 * normalisation and it was deliberately REMOVED: whitespace inside a
 * `<script>` body is semantically significant (`return\n{}` is not
 * `return {}`), so a normalising hash would let two templates with different
 * chart code hash identically — which is exactly a forged lock. W17's
 * structure-hash comparison is only as strong as this line.
 */
export function structureHash(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * Wraps a failure list as the shared taxonomy's `invalid` kind, for callers
 * that would rather throw than branch. Mirrors W3's `specValidationError`;
 * no new error kind is introduced.
 */
export function templateValidationError(
  errors: TemplateError[],
  message = "report template is not valid",
): WolfError {
  return new WolfError("invalid", message, { details: { errors } });
}

/* ------------------------------------------------------------------ */
/* the tokenizer                                                       */
/* ------------------------------------------------------------------ */

/** Elements that never have children, so `<img data-wolf-slot>` can hold nothing. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose content is text, not markup. Everything between the start
 * and end tag is skipped wholesale — which is why `<script>var b =
 * document.body;</script>` is not read as a `<body>` element, and why the
 * `<div>` inside a `<textarea>` is not read as a slot container.
 *
 * ⚠️ **Only in HTML content.** See `FOREIGN_ROOTS`.
 */
const RAW_TEXT_ELEMENTS = new Set([
  "script", "style", "textarea", "title", "xmp", "noembed", "noframes",
]);

/**
 * The two elements that open FOREIGN CONTENT — SVG and MathML — inside which
 * the HTML tree builder does **not** switch the tokenizer to raw text.
 *
 * ⚠️ **This is a parser differential that walked three acceptance criteria at
 * once** (fix round 2). `style`, `title`, `textarea`, `xmp`, `noembed` and
 * `noframes` are raw-text elements in HTML content and ordinary elements in
 * foreign content, so a browser builds REAL elements out of markup written
 * inside `<svg><style>…</style></svg>` while a scanner that treats raw text
 * unconditionally sees nothing at all. Verified against parse5 on the
 * identical bytes, three rules were bypassable through that one hole:
 *
 *  - `<svg><style><p></p><script src="https://evil…"></script></style></svg>`
 *    builds an HTML `<script>` (the `<p>` is on the tree builder's breakout
 *    list, so what follows it is HTML again) — a remote script the go-live
 *    review screen would have reported as ZERO remote scripts, after which
 *    `structureHash` freezes it in place;
 *  - `<svg><style><img src="http://evil…"></style></svg>` builds an HTML
 *    `<img>` — a non-https fetch, and `<embed src="http://…">` the same;
 *  - `<svg><style><div data-wolf-slot="a">…</div></style></svg>` builds a
 *    second real slot region, so a duplicate id passes and the second region
 *    is never filled and never drifts.
 *
 * So the raw-text skip below is suppressed inside an `<svg>`/`<math>`
 * subtree: everything there is TOKENISED, and every rule sees it. That is
 * strictly the fail-closed direction. It also makes this scanner *stricter*
 * than a browser in two places — inside an SVG integration point (`<title>`,
 * `<desc>`, `<foreignObject>`) HTML rules resume, so a browser would treat a
 * nested `<style>` body as text again, and the tree builder's breakout list
 * can return to HTML content before this scanner's `</svg>` does. Refusing
 * markup a browser would have ignored is a fixable authoring complaint;
 * accepting markup a browser would have FETCHED is a forged lock.
 */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

/** The skeleton `composeFrame` owns. None of these may appear in a fragment. */
const SKELETON_ELEMENTS = new Set(["html", "head", "body"]);

/**
 * Elements whose contents are PARSED but never RENDERED: `<template>` is an
 * inert document fragment, and `<noscript>`'s children are raw text whenever
 * scripting is enabled — which it is, in a frame whose whole purpose is to
 * run a charting library. A `data-wolf-fallback` hidden in one of these
 * satisfies a naive "did I see the attribute" scan while showing the operator
 * nothing at all, so the mandatory-fallback rule looks through them.
 */
const INERT_ELEMENTS = new Set(["template", "noscript"]);

const WHITESPACE = new Set([" ", "\t", "\n", "\f", "\r"]);

interface Attribute {
  /** Lowercased. */
  name: string;
  value: string;
  offset: number;
}

interface StartTag {
  type: "start";
  name: string;
  attributes: Attribute[];
  selfClosing: boolean;
  start: number;
  end: number;
  /**
   * For a `<style>` element only: the CSS text between its tags. CSS is a URL
   * channel of its own (`@import`, `url(…)`) and is checked as one — see
   * `cssUrls`.
   */
  cssText?: string;
}

interface EndTag {
  type: "end";
  name: string;
  start: number;
  end: number;
}

interface Doctype {
  type: "doctype";
  start: number;
  end: number;
}

type Token = StartTag | EndTag | Doctype;

interface ScanResult {
  /** Start tags, end tags and doctypes, in document order. Text and comments are dropped. */
  tokens: Token[];
  errors: TemplateError[];
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.has(ch);
}

function isAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[a-zA-Z]/.test(ch);
}

/** Parses a tag's attributes, starting just after its name. */
function parseAttributes(
  html: string,
  from: number,
): { attributes: Attribute[]; selfClosing: boolean; end: number } | null {
  const attributes: Attribute[] = [];
  let i = from;
  let selfClosing = false;

  for (;;) {
    while (isWhitespace(html[i])) i += 1;
    if (i >= html.length) return null; // unterminated tag
    if (html[i] === ">") return { attributes, selfClosing, end: i + 1 };
    if (html[i] === "/") {
      if (html[i + 1] === ">") return { attributes, selfClosing: true, end: i + 2 };
      i += 1; // a stray solidus between attributes; the HTML tokenizer ignores it
      continue;
    }

    const nameStart = i;
    while (
      i < html.length &&
      !isWhitespace(html[i]) &&
      html[i] !== "=" &&
      html[i] !== ">" &&
      html[i] !== "/"
    ) {
      i += 1;
    }
    if (i === nameStart) {
      // Not whitespace, not `=`, `>` or `/`, yet consumed nothing: only
      // reachable if the character classes above ever drift apart. Advance
      // so a malformed tag can never spin forever.
      i += 1;
      continue;
    }
    const name = html.slice(nameStart, i).toLowerCase();

    while (isWhitespace(html[i])) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (isWhitespace(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0) return null; // unterminated quoted value
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isWhitespace(html[i]) && html[i] !== ">") i += 1;
        value = html.slice(valueStart, i);
      }
    }
    // A repeated attribute name is dropped by the HTML parser (first wins),
    // but every occurrence is kept here: the URL rules below must see the
    // ones a browser would ignore too, because "ignored" depends on a parser
    // agreeing with this one, and fail-closed does not.
    attributes.push({ name, value, offset: nameStart });
  }
}

/**
 * Consumes an HTML comment whose `<!--` begins at `start`, and returns the
 * index just past its close — or `null` if it is never closed.
 *
 * ⚠️ **A comment ends in FOUR ways, not one.** An earlier version of this
 * scanner searched for the literal `-->` and nothing else, which let anything
 * between an abrupt close and the next literal `-->` be markup to a browser
 * and invisible here: `<!---><script src="http://evil…"></script><!-- pad -->`
 * validated clean with an EMPTY `scriptSrcs`, and the same six characters
 * smuggled a `<body>` element and a duplicate slot id past their rules. That
 * is the exact failure this module exists to prevent — the go-live review
 * screen would show a human zero remote scripts for a template that loads
 * one, and `structureHash` would then freeze it.
 *
 * So this follows the tokenizer's comment states literally
 * (https://html.spec.whatwg.org/multipage/parsing.html#comment-start-state):
 *
 *  - `<!-->`   — comment start state sees `>`: abrupt-closing-of-empty-comment.
 *  - `<!--->`  — comment start dash state sees `>`: same.
 *  - `--!>`    — comment end bang state sees `>`: incorrectly-closed-comment.
 *  - `-->`     — comment end state sees `>`: the ordinary close.
 *
 * The `comment less-than sign` family of states is deliberately not modelled:
 * those states only raise *nested-comment* parse errors and always reconsume
 * in `comment end`/`comment` state, so they never move where a comment ENDS,
 * which is the only question asked here. (`<!--<!--->` closes at the same
 * index either way.)
 */
function commentEnd(html: string, start: number): number | null {
  type State = "start" | "startDash" | "comment" | "endDash" | "end" | "endBang";
  let state: State = "start";

  for (let i = start + 4; i < html.length; i += 1) {
    const ch = html[i];
    switch (state) {
      case "start":
        if (ch === "-") state = "startDash";
        else if (ch === ">") return i + 1; // <!-->
        else state = "comment";
        break;
      case "startDash":
        if (ch === "-") state = "end";
        else if (ch === ">") return i + 1; // <!--->
        else state = "comment";
        break;
      case "comment":
        if (ch === "-") state = "endDash";
        break;
      case "endDash":
        state = ch === "-" ? "end" : "comment";
        break;
      case "end":
        if (ch === ">") return i + 1; // -->
        else if (ch === "!") state = "endBang";
        else if (ch === "-") state = "end";
        else state = "comment";
        break;
      case "endBang":
        if (ch === ">") return i + 1; // --!>
        else if (ch === "-") state = "endDash";
        else state = "comment";
        break;
    }
  }
  return null; // EOF inside a comment: fail closed, the caller reports it.
}

/**
 * Walks the template once and yields its tags. Comments, bogus comments,
 * raw-text bodies and ordinary text are consumed and discarded — this
 * function's only job is to decide, correctly, what IS a tag.
 */
function scan(html: string): ScanResult {
  const tokens: Token[] = [];
  const errors: TemplateError[] = [];
  /** The open `<svg>`/`<math>` elements, innermost last. See `FOREIGN_ROOTS`. */
  const foreign: Array<{ name: string; offset: number }> = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt;

    const next = html[i + 1];

    if (next === "!") {
      if (html.startsWith("<!--", i)) {
        const end = commentEnd(html, i);
        if (end === null) {
          errors.push({
            path: "template",
            message: "a comment is opened with `<!--` and never closed",
            offset: i,
          });
          break;
        }
        i = end;
        continue;
      }
      const isDoctype = html.slice(i, i + 9).toLowerCase() === "<!doctype";
      const close = html.indexOf(">", i);
      if (close < 0) {
        errors.push({
          path: "template",
          message: `a \`<!\` declaration is opened and never closed`,
          offset: i,
        });
        break;
      }
      if (isDoctype) tokens.push({ type: "doctype", start: i, end: close + 1 });
      i = close + 1;
      continue;
    }

    if (next === "?") {
      const close = html.indexOf(">", i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }

    if (next === "/") {
      if (!isAsciiLetter(html[i + 2])) {
        // `</>` and friends: the HTML tokenizer treats these as a bogus comment.
        const close = html.indexOf(">", i);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      let j = i + 2;
      while (
        j < html.length &&
        !isWhitespace(html[j]) &&
        html[j] !== ">" &&
        html[j] !== "/"
      ) {
        j += 1;
      }
      const name = html.slice(i + 2, j).toLowerCase();
      const parsed = parseAttributes(html, j);
      if (parsed === null) {
        errors.push({
          path: "template",
          message: `the end tag \`</${name}\` is never closed with \`>\``,
          offset: i,
        });
        break;
      }
      tokens.push({ type: "end", name, start: i, end: parsed.end });
      i = parsed.end;
      if (FOREIGN_ROOTS.has(name)) {
        // Innermost matching open element, if any; an unmatched `</svg>` is
        // ignored exactly as the tree builder ignores it.
        for (let f = foreign.length - 1; f >= 0; f -= 1) {
          if (foreign[f]?.name === name) {
            foreign.length = f;
            break;
          }
        }
      }
      continue;
    }

    if (!isAsciiLetter(next)) {
      // A lone `<` is literal text.
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < html.length && !isWhitespace(html[j]) && html[j] !== ">" && html[j] !== "/") {
      j += 1;
    }
    const name = html.slice(i + 1, j).toLowerCase();
    const parsed = parseAttributes(html, j);
    if (parsed === null) {
      errors.push({
        path: "template",
        message: `the tag \`<${name}\` is never closed with \`>\``,
        offset: i,
      });
      break;
    }
    const token: StartTag = {
      type: "start",
      name,
      attributes: parsed.attributes,
      selfClosing: parsed.selfClosing,
      start: i,
      end: parsed.end,
    };
    tokens.push(token);
    i = parsed.end;

    // In foreign content a self-closing start tag really does close the
    // element, so `<svg/>` opens nothing.
    if (FOREIGN_ROOTS.has(name) && !parsed.selfClosing) {
      foreign.push({ name, offset: token.start });
      continue;
    }

    // The raw-text skip — suppressed inside foreign content (FOREIGN_ROOTS),
    // where these are ordinary elements whose children a browser really
    // builds. `<style>` is special twice over: its body is CSS, a URL channel
    // of its own, so it is CAPTURED here whether or not it is skipped.
    const isRawText = RAW_TEXT_ELEMENTS.has(name) && !parsed.selfClosing;
    const inForeign = foreign.length > 0;
    if (isRawText && (!inForeign || name === "style")) {
      const closer = new RegExp(`</${name}[\\s/>]`, "i");
      const rest = html.slice(i);
      const match = closer.exec(rest);
      if (!match) {
        errors.push({
          path: "template",
          message: `\`<${name}>\` is opened and never closed`,
          offset: parsed.end,
        });
        break;
      }
      if (name === "style") token.cssText = rest.slice(0, match.index);
      // Inside foreign content the body is scanned as markup as well: the
      // element is a real one there, and its children are real children.
      if (!inForeign) i += match.index;
    }
  }

  if (errors.length === 0 && foreign.length > 0) {
    const open = foreign[0];
    errors.push({
      path: "template",
      message:
        `\`<${open?.name}>\` is opened and never closed: inside SVG and MathML the parser ` +
        "cannot tell where foreign content ends, so an unclosed one is refused rather than " +
        "guessed at",
      offset: open?.offset,
    });
  }

  return { tokens, errors };
}

/* ------------------------------------------------------------------ */
/* URL classification                                                  */
/* ------------------------------------------------------------------ */

/**
 * The attributes whose value a browser resolves and fetches. `src` and `href`
 * are the two the ticket pins; the rest are here because W25's authoring
 * contract states the rule as "every URL must be `https:`", and an unchecked
 * `poster=` or `formaction=` is the same daily, human-unreviewed egress
 * channel that the pinned two exist to close. `data` is only a URL on
 * `<object>`, so it is handled per-element below.
 */
const URL_ATTRIBUTES = new Set([
  "src", "href", "srcset", "poster", "action", "formaction",
  "xlink:href", "background", "ping",
]);

type UrlVerdict =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Strips exactly what a browser strips before it resolves a URL attribute:
 * leading and trailing ASCII whitespace, and every tab/newline/CR ANYWHERE
 * in the value. Without this, a RAW newline or tab inside `java\nscript:` —
 * a real, historical bypass — would classify as "some other scheme" instead
 * of as `javascript:`.
 *
 * ⚠️ Character references are **not** decoded, here or anywhere in this
 * module: the scanner keeps attribute values as written. A browser decodes
 * them, so `java&#10;script:alert(1)` really is a `javascript:` URL to a
 * browser and is merely "some other scheme" here — it is still REFUSED, by
 * the generic branch of `classifyUrl`, because anything that is not an
 * absolute `https:` URL is refused. That is the only reason not decoding is
 * safe: no undecoded spelling of a hostile URL can start with `https:`, so
 * the fail-closed default catches every one of them. Do not "improve" this
 * into a permissive decoder.
 *
 * This is a classification-only view. The stored bytes are never touched.
 */
function urlForClassification(raw: string): string {
  return raw.replace(/[\t\n\r]/g, "").trim();
}

/**
 * Classifies ONE URL value. The four vectors get four DISTINCT messages.
 *
 * `subject` names what is being classified in the generic (not-a-known-vector)
 * message, so a CSS `url(…)` failure does not tell an author to fix an `href`
 * they never wrote.
 */
function classifyUrl(
  raw: string,
  tag: string,
  subject = "every src and href in a report template",
): UrlVerdict {
  const value = urlForClassification(raw);
  const lower = value.toLowerCase();

  if (lower.startsWith("https:")) return { ok: true };

  if (lower.startsWith("http:")) {
    return {
      ok: false,
      message:
        "`http:` URLs are not permitted in a report template: every src and href must be " +
        "`https:` (the frame is served over https and a mixed-content request is blocked anyway)",
    };
  }

  // `//host`, and the backslash spellings a URL parser treats identically.
  if (/^[/\\]{2}/.test(value)) {
    return {
      ok: false,
      message:
        "protocol-relative URLs (`//host/…`) are not permitted: write the scheme out as " +
        "`https:` so the template says what it fetches",
    };
  }

  if (lower.startsWith("javascript:")) {
    return {
      ok: false,
      message: "`javascript:` URLs are not permitted in a report template",
    };
  }

  if (lower.startsWith("data:")) {
    if (tag === "img") return { ok: true };
    return {
      ok: false,
      message: `\`data:\` URLs are permitted on \`img\` only, not on \`${tag}\``,
    };
  }

  return {
    ok: false,
    message:
      `${subject} must be an absolute \`https:\` URL; ` +
      `${JSON.stringify(value)} is not one`,
  };
}

/* ------------------------------------------------------------------ */
/* CSS is a URL channel too                                            */
/* ------------------------------------------------------------------ */

/**
 * Every URL a stylesheet can fetch: `@import` (in both its spellings) and
 * `url(…)` in any of its three quotings.
 *
 * ⚠️ This is not in the ticket's wording — that names `src` and `href` — but
 * `<style>@import url(http://evil/x.css)</style>` and
 * `<div style="background:url(http://evil/x.png)">` are the same daily,
 * human-unreviewed egress channel the https-only rule exists to close, and
 * W25's authoring contract states the rule as "every URL must be `https:`".
 * A CSS URL is therefore held to the same rule, with one carve-out the
 * attribute rule does not need: a bare `#fragment` is allowed, because
 * `fill:url(#gradient)` is how every SVG chart references its own paint
 * server and resolves inside the document rather than over the network.
 */
function cssUrls(css: string): Array<{ value: string; isImport: boolean }> {
  const found: Array<{ value: string; isImport: boolean }> = [];
  const pattern =
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)|"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
  for (const match of css.matchAll(pattern)) {
    const value =
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ??
      match[6] ?? match[7] ?? match[8] ?? "";
    found.push({ value, isImport: /^@import/i.test(match[0]) });
  }
  return found;
}

/** Classifies ONE CSS URL. See `cssUrls` for why `#fragment` is allowed. */
function classifyCssUrl(raw: string): UrlVerdict {
  const value = urlForClassification(raw);
  if (value === "" || value.startsWith("#")) return { ok: true };
  // `img` as the tag: a `data:` URL in CSS is an image or a font, and cannot
  // execute — the same allowance `<img src="data:…">` gets.
  return classifyUrl(value, "img", "every URL in a report template's CSS");
}

/**
 * `srcset` is a comma-separated candidate list, and a `data:` URL may itself
 * contain commas — so splitting one is meaningless. A `data:` srcset is
 * therefore classified whole (and so is still `img`-only); everything else is
 * split, and each candidate's URL half is classified.
 */
function classifySrcset(raw: string, tag: string): UrlVerdict[] {
  const value = urlForClassification(raw);
  if (value === "") return [classifyUrl(raw, tag)];
  if (value.toLowerCase().startsWith("data:")) return [classifyUrl(raw, tag)];
  const verdicts: UrlVerdict[] = [];
  for (const candidate of value.split(",")) {
    const url = candidate.trim().split(/\s+/)[0] ?? "";
    if (url === "") continue;
    verdicts.push(classifyUrl(url, tag));
  }
  return verdicts.length > 0 ? verdicts : [classifyUrl(raw, tag)];
}

function isUrlAttribute(tag: string, name: string): boolean {
  if (URL_ATTRIBUTES.has(name)) return true;
  return tag === "object" && name === "data";
}

/* ------------------------------------------------------------------ */
/* the parser                                                          */
/* ------------------------------------------------------------------ */

function attributeValue(tag: StartTag, name: string): string | undefined {
  for (const attribute of tag.attributes) {
    if (attribute.name === name) return attribute.value;
  }
  return undefined;
}

function hasAttribute(tag: StartTag, name: string): boolean {
  return attributeValue(tag, name) !== undefined;
}

/**
 * Finds the end tag that closes `tokens[index]`, by counting same-name start
 * tags. Returns the closing token's index, or −1 when the element is never
 * closed.
 *
 * This is deliberately NOT a whole-document balance check: HTML lets a great
 * many end tags be omitted (`<p>`, `<li>`, `<td>`…) and rejecting a template
 * for that would be wrong. A SLOT, though, must be closed explicitly, because
 * its children are the bytes W19 replaces — an implied close leaves no
 * unambiguous end for that range.
 */
function findClosingTag(tokens: Token[], index: number, name: string): number {
  let depth = 0;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.type === "doctype") continue;
    if (token.name !== name) continue;
    if (token.type === "start") {
      if (!token.selfClosing && !VOID_ELEMENTS.has(name)) depth += 1;
      continue;
    }
    if (depth === 0) return i;
    depth -= 1;
  }
  return -1;
}

/**
 * Parses and validates a report template fragment.
 *
 * Never throws for bad TEMPLATE input — a caller mistake is a 422, not a 500
 * (the same non-throwing contract W3's `validateSpec` holds) — and returns
 * EVERY error at once so a human fixes the template in one pass rather than
 * one round trip per mistake. The single exception is a nonsensical
 * `maxBytes`, which is a programming error in Wolf itself and throws.
 *
 * @param html     the template fragment, exactly as it is stored
 * @param maxBytes the byte budget — a PARAMETER, never read from config here
 */
export function parseTemplate(html: string, maxBytes: number): ParseTemplateResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new WolfError(
      "internal",
      "parseTemplate: maxBytes must be a positive whole number of bytes",
      { details: { maxBytes } },
    );
  }

  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maxBytes) {
    // Reported ALONE and on its own: an oversized template has not been
    // read, so any further finding would be about bytes nobody has looked
    // at, and a review screen listing them would be lying about coverage.
    return {
      valid: false,
      errors: [
        {
          path: "template",
          message:
            `report template is ${byteLength} bytes, which exceeds the limit of ` +
            `${maxBytes} bytes`,
        },
      ],
    };
  }

  const { tokens, errors } = scan(html);
  const slots: TemplateSlot[] = [];
  const scriptSrcs: string[] = [];
  const seenSlotIds = new Set<string>();
  const openSkeletons = new Map<string, number>();
  let sawFallback = false;
  let sawInertFallback = false;
  let inertDepth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    // (3) THE TEMPLATE IS A FRAGMENT.
    if (token.type === "doctype") {
      errors.push({
        path: "doctype",
        message:
          "a report template is an HTML FRAGMENT and must not carry a `<!doctype>` — " +
          "composeFrame owns the document skeleton",
        offset: token.start,
      });
      continue;
    }
    if (SKELETON_ELEMENTS.has(token.name)) {
      // Reported ONCE PER ELEMENT, not once per tag: `<body>x</body>` is one
      // mistake, and a review screen printing it twice reads as two. A stray
      // `</body>` with no start tag of its own is still reported — it is a
      // skeleton tag either way, and silence there would be a hole.
      const open = openSkeletons.get(token.name) ?? 0;
      if (token.type === "end" && open > 0) {
        openSkeletons.set(token.name, open - 1);
        continue;
      }
      if (token.type === "start") openSkeletons.set(token.name, open + 1);
      errors.push({
        path: token.name,
        message:
          `a report template is an HTML FRAGMENT and must not contain a \`<${token.name}>\` ` +
          "element — composeFrame owns the document skeleton",
        offset: token.start,
      });
      continue;
    }

    if (token.type === "end") {
      if (INERT_ELEMENTS.has(token.name) && inertDepth > 0) inertDepth -= 1;
      continue;
    }

    // (5) THE FALLBACK MUST BE ONE A HUMAN WOULD SEE — see INERT_ELEMENTS.
    const inert = inertDepth > 0 || INERT_ELEMENTS.has(token.name);
    if (hasAttribute(token, FALLBACK_ATTRIBUTE)) {
      if (inert) sawInertFallback = true;
      else sawFallback = true;
    }
    if (
      INERT_ELEMENTS.has(token.name) &&
      !token.selfClosing &&
      !VOID_ELEMENTS.has(token.name)
    ) {
      inertDepth += 1;
    }

    // (4) EVERY src AND href MUST BE https:.
    for (const attribute of token.attributes) {
      if (!isUrlAttribute(token.name, attribute.name)) continue;
      const verdicts =
        attribute.name === "srcset"
          ? classifySrcset(attribute.value, token.name)
          : [classifyUrl(attribute.value, token.name)];
      for (const verdict of verdicts) {
        if (verdict.ok) continue;
        errors.push({
          path: `${token.name}[${attribute.name}]`,
          message: verdict.message,
          offset: attribute.offset,
        });
      }
    }

    // (4b) CSS IS A URL CHANNEL TOO — see `cssUrls`.
    const styleAttribute = attributeValue(token, "style");
    const cssSources: Array<{ path: string; css: string }> = [];
    if (styleAttribute !== undefined && styleAttribute !== "") {
      cssSources.push({ path: `${token.name}[style]`, css: styleAttribute });
    }
    if (token.name === "style" && token.cssText !== undefined) {
      cssSources.push({ path: "style", css: token.cssText });
    }
    for (const source of cssSources) {
      for (const { value, isImport } of cssUrls(source.css)) {
        const verdict = classifyCssUrl(value);
        if (!verdict.ok) {
          errors.push({ path: source.path, message: verdict.message, offset: token.start });
          continue;
        }
        // An `@import` fetches an external STYLESHEET, which is exactly what
        // the go-live review screen exists to show a human.
        const url = urlForClassification(value);
        if (isImport && url !== "" && !url.startsWith("#")) scriptSrcs.push(url);
      }
    }

    // The URLs a human approves at go-live: remote script, remote stylesheet.
    if (token.name === "script") {
      const src = attributeValue(token, "src");
      if (src !== undefined && src !== "") scriptSrcs.push(src);
    } else if (token.name === "link") {
      const rel = (attributeValue(token, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attributeValue(token, "href");
      if (rel.includes("stylesheet") && href !== undefined && href !== "") {
        scriptSrcs.push(href);
      }
    }

    // (2) SLOTS — document order, validated ids, NO DUPLICATES.
    const slotId = attributeValue(token, SLOT_ATTRIBUTE);
    if (slotId === undefined) continue;

    if (!SLOT_ID_PATTERN.test(slotId)) {
      errors.push({
        path: `[${SLOT_ATTRIBUTE}]`,
        message:
          `slot id ${JSON.stringify(slotId)} must match ${SLOT_ID_PATTERN.source} ` +
          "(lowercase, starting with a letter, at most 32 characters)",
        offset: token.start,
      });
      continue;
    }
    if (inert) {
      // Same reasoning as the fallback rule above, applied to slots: a
      // `<template>`'s content is an inert fragment and a `<noscript>`'s
      // children are TEXT whenever scripting is enabled — which it is, in a
      // frame whose whole purpose is to run a charting library. Filling a
      // slot in there writes bytes that render as literal markup or not at
      // all, and W20's drift check on that slot would be meaningless.
      errors.push({
        path: `[${SLOT_ATTRIBUTE}="${slotId}"]`,
        message:
          `slot ${JSON.stringify(slotId)} is inside a \`<template>\` or \`<noscript>\`, which ` +
          "renders nothing: the daily tick would fill bytes no operator ever sees",
        offset: token.start,
      });
      continue;
    }
    if (seenSlotIds.has(slotId)) {
      errors.push({
        path: `[${SLOT_ATTRIBUTE}="${slotId}"]`,
        message:
          `duplicate slot id ${JSON.stringify(slotId)}: two regions sharing an id makes drift ` +
          "undetectable, so the later one is rejected rather than silently winning",
        offset: token.start,
      });
      continue;
    }
    if (VOID_ELEMENTS.has(token.name) || token.selfClosing) {
      errors.push({
        path: `[${SLOT_ATTRIBUTE}="${slotId}"]`,
        message:
          `slot ${JSON.stringify(slotId)} is declared on \`<${token.name}>\`, which has no ` +
          "children — a slot must be a container element the daily tick can fill",
        offset: token.start,
      });
      continue;
    }
    const closing = findClosingTag(tokens, index, token.name);
    if (closing < 0) {
      errors.push({
        path: `[${SLOT_ATTRIBUTE}="${slotId}"]`,
        message:
          `slot ${JSON.stringify(slotId)} is declared on a \`<${token.name}>\` that is never ` +
          "closed; a slot's children are the bytes the daily tick replaces, so its end tag " +
          "cannot be implied",
        offset: token.start,
      });
      continue;
    }
    const closingToken = tokens[closing];
    const enclosing = slots.find(
      (slot) => token.start >= slot.contentStart && token.start < slot.contentEnd,
    );
    if (enclosing) {
      errors.push({
        path: `[${SLOT_ATTRIBUTE}="${slotId}"]`,
        message:
          `slot ${JSON.stringify(slotId)} is nested inside slot ` +
          `${JSON.stringify(enclosing.id)}; two fillers would write the same bytes`,
        offset: token.start,
      });
      continue;
    }

    seenSlotIds.add(slotId);
    slots.push({
      id: slotId,
      contentStart: token.end,
      contentEnd: closingToken ? closingToken.start : token.end,
    });
  }

  // (5) THE FALLBACK IS MANDATORY — AND MUST RENDER.
  if (!sawFallback) {
    errors.push({
      path: "template",
      message: sawInertFallback
        ? `the only element carrying \`${FALLBACK_ATTRIBUTE}\` is inside a \`<template>\` or ` +
          "`<noscript>`, which renders nothing: move it into the document body of the fragment, " +
          "because it is the operator's only signal that the chart never rendered"
        : `a report template must contain an element carrying \`${FALLBACK_ATTRIBUTE}\`: a CDN ` +
          "failure is invisible inside an opaque frame, so that element is the operator's only " +
          "signal that the chart never rendered",
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    template: {
      html,
      byteLength,
      // (1) NO NORMALISATION. See `structureHash`.
      structureHash: structureHash(html),
      slotIds: slots.map((slot) => slot.id),
      slots,
      scriptSrcs,
    },
  };
}
