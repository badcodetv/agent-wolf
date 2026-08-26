/**
 * Frame composition and the CSP value — the module that turns a locked
 * template, a day's slot content and a series payload into the one HTML
 * document a person's browser executes.
 *
 * design/2026-08-20-agent-wolf.md § W19 is the ticket; the CSP skeleton is
 * `design/2026-08-24-agent-wolf-ui.md` § 6b (amended 2026-08-26, R152), and
 * its per-clause rationale is the main plan's § "The CSP header,
 * byte-for-byte". W21 serves what this returns: `html` as the body and `csp`
 * as the `Content-Security-Policy` header.
 *
 * `composeFrame` is PURE — no I/O, no clock, no config read. Everything it
 * needs arrives as an argument, which is what lets W21's route-level test
 * ("no credential reaches the frame") mean something: a pure function cannot
 * see a credential at all.
 *
 * ## The three things this module is responsible for
 *
 * 1. **The CSP is DERIVED from the approved template, not constant.** Two
 *    lists are substituted at four positions, and they are DIFFERENT lists —
 *    see `frameCsp`. A constant `script-src https:` would let any host on
 *    earth serve code into the frame; a single-list substitution would grant
 *    script execution to a host the template merely fetches an image from.
 * 2. **The document skeleton is ours, and the template fragment is not.**
 *    Every byte of the template outside a slot's children is emitted
 *    unchanged — no re-serialisation, no normalisation — because
 *    `structureHash` is sha256 of exactly those bytes and a frame that
 *    rewrote them would render something no human approved.
 * 3. **The injection site.** The series lands in one pinned position, the
 *    last child of `<head>`, and the text that lands there cannot end the
 *    `<script>` element early nor open a comment inside it. See
 *    `escapeForScriptElement` — this is the item W18's Notes handed here.
 *
 * ## What this module deliberately does NOT do
 *
 * It emits **no** `<meta http-equiv="Content-Security-Policy">`. A meta
 * policy silently ignores `sandbox` and `frame-ancestors`, which are two of
 * the four directives `default-src` does not cover, so a meta copy would
 * read like a second line of defence while providing neither. The header
 * W21 sets is the only policy.
 */

import { WolfError } from "../errors.js";
import { sanitiseSlot } from "./sanitise.js";
import { serialiseSeriesPayload } from "./series.js";
import type { SeriesPayload } from "./series.js";
import type { ParsedTemplate } from "./template.js";

/* ------------------------------------------------------------------ */
/* the derived CSP                                                     */
/* ------------------------------------------------------------------ */

/**
 * The origin one `scriptSrcs` entry contributes to `script-src`/`style-src`,
 * or `undefined` for the entries that name no remote host.
 *
 * Mirrors `template.ts`'s own `remoteOrigin` deliberately rather than
 * importing it: W19 is authorised exactly one additive edit to that file and
 * widening its exports is not it. The divergence risk that creates is the
 * reason `assertCodeOriginsAreASubset` exists and runs on every compose —
 * two derivations of the same set that disagree are caught loudly rather
 * than shipped as a CSP.
 *
 * ⚠️ **The scheme test is load-bearing and was measured, not assumed.**
 * `scriptSrcs` is NOT https-only: `<style>@import url(data:text/css,x)</style>`
 * validates clean and pushes the `data:` URL into `scriptSrcs` (measured
 * against the merged `parseTemplate`, 2026-08-26), and `new URL` gives a
 * `data:` URL the origin `"null"` — the literal four characters `null`,
 * which as a CSP source expression is a host name, not the keyword
 * `'none'`. Without this test that string would be substituted into
 * `script-src`.
 *
 * The whitespace strip matches what a browser strips before resolving a URL
 * attribute, and is the same normalisation `template.ts` applies before its
 * own classification, so the two agree on what a value even is.
 */
function codeOrigin(raw: string): string | undefined {
  const value = raw.replace(/[\t\n\r]/g, "").trim();
  if (!/^https:/i.test(value)) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    // `<script src="https:">` passes template validation, which only reads
    // the scheme, and names no host. Measured: `new URL("https:")` throws.
    return undefined;
  }
}

/**
 * `scriptSrcs` holds **absolute URLs in document order, neither
 * deduplicated nor sorted** (`template.ts`), so this does both. Sorting is
 * not cosmetic: a CSP that varied with the order URLs happen to appear in
 * would not be byte-stable for one frozen template, and W21 asserts the
 * header a template produces.
 *
 * 🔴 **Exported for W24 and for one reason: so there is not a third mapping.**
 * The go-live review screen shows a human `scriptSrcs` (the raw URLs) and
 * separately the origins that will be permitted to execute code, and those
 * two are NOT the same set — `scriptSrcs` is not https-only. A screen that
 * derived the second from the first itself would be a second opinion about
 * the policy the human is approving, and the first time the two disagreed the
 * human would approve one thing and Wolf would enforce another.
 */
export function codeOrigins(scriptSrcs: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of scriptSrcs) {
    const origin = codeOrigin(url);
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins].sort();
}

/**
 * `scriptSrcs`' origins must be a strict subset of `remoteOrigins` — every
 * URL that reaches `scriptSrcs` also passes through the URL-attribute or CSS
 * channel that fills `remoteOrigins`, so the two cannot legitimately
 * disagree.
 *
 * It is checked rather than assumed because the consequence of it being
 * false is not local: § 6b's review screen renders "everything else" as a
 * SET DIFFERENCE of the two lists, so a code origin missing from
 * `remoteOrigins` would be a host that executes code in the frame and never
 * appears on the screen the human approves. `internal` is the right kind —
 * reaching here means Wolf has a bug, not that the caller sent something bad
 * (main plan § "Shared error taxonomy": an unrecognised state is `internal`,
 * never `unavailable`).
 */
function assertCodeOriginsAreASubset(code: readonly string[], fetchable: readonly string[]): void {
  const known = new Set(fetchable);
  const missing = code.filter((origin) => !known.has(origin));
  if (missing.length > 0) {
    throw new WolfError(
      "internal",
      "composeFrame: a script origin is absent from the template's remote-host inventory, so " +
        "the go-live review screen would not have shown it",
      { details: { missing, scriptOrigins: code, remoteOrigins: fetchable } },
    );
  }
}

/** `name` plus its non-empty values, space-joined — an empty list adds no source and no space. */
function directive(name: string, ...values: string[]): string {
  return [name, ...values.filter((value) => value !== "")].join(" ");
}

/**
 * The frame's `Content-Security-Policy`, derived from the approved template.
 *
 * The skeleton is `design/2026-08-24-agent-wolf-ui.md` § 6b, **as amended on
 * 2026-08-26 (R152)**, and there are **two** substituted lists at four
 * positions, not one:
 *
 * | Directive | List | Why |
 * | --- | --- | --- |
 * | `script-src 'unsafe-inline' <CODE>` | origins of `scriptSrcs` | remote **code**: what a human approves as code |
 * | `style-src 'unsafe-inline' <CODE>` | the same | `scriptSrcs` already carries stylesheet hrefs and CSS `@import` targets |
 * | `img-src <ORIGINS> data:` | `remoteOrigins` | non-executable fetches; the broad list is right here |
 * | `font-src <ORIGINS> data:` | the same | as above |
 *
 * ⚠️ **Do not collapse them back into one list.** `remoteOrigins` is
 * deliberately a superset that includes `meta[http-equiv=refresh]` targets
 * and `object > param` values (W30, R118(2)). A navigation target is not
 * code, and with `'unsafe-inline'` already granted, the template's own
 * inline script could otherwise load code from a host the reviewing human
 * filed under "images".
 *
 * ⚠️ **Four directives here are NOT covered by the `default-src` fallback**
 * and must stay written out: `sandbox`, `base-uri`, `form-action` and
 * `frame-ancestors`. Deleting any of them as redundant silently removes the
 * protection — `frame-ancestors 'self'` in particular is what stops a
 * third-party page embedding a signed-in user's report, and the frame route
 * is authenticated. The rest fall back to `default-src 'none'` and are
 * listed anyway so the intent is readable at the point of use.
 *
 * ⚠️ **`'unsafe-inline'` on `script-src` is correct here.** The template's
 * chart code is inline and `structureHash` freezes it byte-for-byte, and the
 * series injection is inline by construction; a nonce varies per response
 * and a hash varies daily with the data, so either would trade a checkable
 * invariant for the appearance of hardening. The security comes from there
 * being no untrusted script to restrict — the template is human-reviewed and
 * frozen, and `SLOT_PROFILE` admits no script, no handler and no URL from
 * the daily tick. Removing `'unsafe-inline'` disables every chart in every
 * report and **no unit test in this suite would fail**, because the tests
 * assert the string, not that a browser executed the chart.
 *
 * A template referencing nothing remote yields `script-src 'unsafe-inline'`
 * with no host at all — the common case, and strictly tighter than the
 * `https:` this replaced.
 */
export function frameCsp(template: Pick<ParsedTemplate, "scriptSrcs" | "remoteOrigins">): string {
  const code = codeOrigins(template.scriptSrcs);
  assertCodeOriginsAreASubset(code, template.remoteOrigins);

  const codeList = code.join(" ");
  // Already deduplicated and sorted by `parseTemplate`; re-sorting here would
  // be a second opinion about a set that has one owner.
  const originList = template.remoteOrigins.join(" ");

  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    directive("script-src", "'unsafe-inline'", codeList),
    directive("style-src", "'unsafe-inline'", codeList),
    directive("img-src", originList, "data:"),
    directive("font-src", originList, "data:"),
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

/* ------------------------------------------------------------------ */
/* the injection site                                                  */
/* ------------------------------------------------------------------ */

/**
 * Neutralises every `<` in the serialised series so the text cannot steer
 * the HTML tokenizer out of the `<script>` element it is embedded in.
 *
 * `<` inside a JSON string is a legal, meaning-preserving escape, so
 * `JSON.parse` — and a browser evaluating the object literal — sees the
 * original `<` back. The source text no longer contains one.
 *
 * ⚠️ **This closes the hole W18's Notes handed to W19, and it is real.**
 * W18's `serialiseSeriesPayload` neutralises `</script`, which is the
 * obvious breakout; it does not touch `<!--`, which is a DIFFERENT tokenizer
 * transition. `<!--` puts the tokenizer into *script data escaped* state and
 * a following `<script` into *script data double escaped* state, in which
 * `</script>` no longer ends the element. Measured with parse5 on
 * 2026-08-26, on the exact document this module composes: with a series
 * `unit` of `<!--<script>`, the parsed document contained **`html, head,
 * script, body` and nothing else** — the template fragment, its
 * `[data-wolf-fallback]` element and its own chart `<script>` were all
 * swallowed into the injection script's text, so the report renders blank
 * and the one signal that says so is gone too. With `<` escaped, the same
 * document parsed to `html, head, script, body, div, script`.
 *
 * A model controls `Metric.unit` in the locked spec and therefore controls
 * that string, so this is reachable from content, not only from a bug.
 *
 * `serialiseSeriesPayload` is still called first: it is W18's contract,
 * tested there, and this escape happens to subsume it. Belt and braces on
 * the one boundary where the whole document is at stake.
 *
 * U+2028 and U+2029 are deliberately NOT escaped. They have been legal
 * inside a JavaScript string literal since ES2019's JSON-superset change —
 * measured on this runtime, `'<U+2028>'.length === 1` — and the frame runs
 * a charting library that needs far more than ES2019. An escape that cannot
 * defend anything is a comment pretending to be code (R148).
 */
function escapeForScriptElement(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/* ------------------------------------------------------------------ */
/* slot filling                                                        */
/* ------------------------------------------------------------------ */

/**
 * `{slotId: html}` as the daily tick wrote it — W15's `ParsedReport.slots`,
 * **unsanitised**. `composeFrame` sanitises: a caller cannot forget, because
 * a caller never gets the chance.
 *
 * An absent key and an explicit `null` are the same thing, the slot is
 * unfilled, per the plan's § Vocabulary null convention (R62).
 */
export type SlotContent = Record<string, string | null | undefined>;

/**
 * Elements a slot may not be declared on, checked here as well as in
 * `parseTemplate`.
 *
 * This is the second half of W19's Ruling 2, and it is a real check rather
 * than a comment: `composeFrame` takes a `ParsedTemplate`, and a
 * hand-constructed one — a stored template parsed by an older build, a test
 * double, a future caller that assembles the shape itself — never passed
 * through the validator. R148 is the standard it is held to, and every entry
 * below is individually reachable through that path.
 *
 * ⚠️ **This set is deliberately WIDER than `parseTemplate`'s.** `noscript`
 * and `template` are absent there because that file's inert-element rule
 * already refuses a slot declared on either, so listing them would change
 * only which message a human reads. They are present HERE because this path
 * has no inert rule in front of it: without them, a hand-built
 * `ParsedTemplate` with a `template`-tagged slot would be filled. Both are
 * mutation-tested — removing them reddens their two rows and nothing else.
 *
 * The hazard is that `sanitiseSlot`'s output is safe in ELEMENT CONTENT and
 * nowhere else. Inside `<style>`, `<title>`, `<textarea>`, `<xmp>`,
 * `<iframe>`, `<noembed>`, `<noframes>` or `<plaintext>` the children are
 * text, not markup, so filled content either renders as literal characters a
 * human reads as analysis or — where a `</style>` survives — closes the
 * element early and re-enters markup. R150(3) built that exploit and it
 * failed, but **only because of a DOMPurify attribute regex**: the path is
 * closed today by a library, not by anything Wolf wrote, which is exactly
 * the kind of dependency that stops holding on an upgrade.
 */
const UNFILLABLE_SLOT_ELEMENTS = new Set([
  "script", "style", "textarea", "title", "xmp",
  "iframe", "noembed", "noframes", "plaintext",
  "noscript", "template",
]);

/* ------------------------------------------------------------------ */
/* composition                                                         */
/* ------------------------------------------------------------------ */

export interface ComposeFrameInput {
  /** W17's `validateTemplate` result, whole. Its `html` is the stored bytes, verbatim. */
  template: ParsedTemplate;
  /** The day's slot content, unsanitised. Slots the template does not declare are ignored. */
  slots: SlotContent;
  /** W18's `buildSeriesPayload` result, keyed by metric slug. */
  series: SeriesPayload;
}

export interface ComposedFrame {
  /** The whole document, ready to serve as `text/html`. */
  html: string;
  /** The `Content-Security-Policy` header value W21 must set on the same response. */
  csp: string;
  /**
   * How many nodes and attributes the sanitiser removed across every filled
   * slot. W23 renders `> 0` as a degraded-severity notice, so it is a
   * human-facing quantity: it is the sum of `strippedBySlot`, computed once
   * here rather than by a second sanitisation pass downstream.
   */
  strippedCount: number;
  /**
   * Per-slot strip counts, keyed by slot id. A slot the template declares
   * and the tick FILLED appears here even when nothing was stripped (`0`);
   * an unfilled slot does not appear at all, so "filled and clean" and
   * "never filled" stay distinguishable — the same distinction W20's
   * `DriftResult` keeps, for the same reason.
   */
  strippedBySlot: Record<string, number>;
}

/**
 * Assembles the frame document and derives its CSP.
 *
 * The skeleton (`<!doctype html>`, `<html>`, `<head>`, `<body>`) belongs to
 * this function — `parseTemplate` refuses a template that carries any of
 * those, so the two halves cannot both claim it. The template fragment goes
 * inside `<body>`, byte-for-byte, with only each slot's CHILDREN replaced.
 *
 * The series injection is the last child of `<head>`, immediately before
 * `</head>`, so `window.__WOLF_SERIES__` is assigned before any template
 * script runs and its position never depends on template content.
 */
export function composeFrame(input: ComposeFrameInput): ComposedFrame {
  const { template, slots, series } = input;

  const strippedBySlot: Record<string, number> = {};
  let strippedCount = 0;
  let body = "";
  let cursor = 0;

  for (const slot of template.slots) {
    if (UNFILLABLE_SLOT_ELEMENTS.has(slot.tagName)) {
      throw new WolfError(
        "internal",
        `composeFrame: slot ${JSON.stringify(slot.id)} is declared on \`<${slot.tagName}>\`, ` +
          "whose children are text and not markup; sanitised slot content is only safe in " +
          "element content, so this template must never have been locked",
        { details: { slotId: slot.id, tagName: slot.tagName } },
      );
    }
    if (slot.contentStart < cursor || slot.contentEnd < slot.contentStart) {
      // Slots arrive in document order and cannot nest — `parseTemplate`
      // refuses both. A `ParsedTemplate` that broke either would have this
      // function splice overlapping ranges and emit corrupt markup, silently.
      throw new WolfError(
        "internal",
        `composeFrame: slot ${JSON.stringify(slot.id)} has a content range that overlaps an ` +
          "earlier slot or runs backwards; slots must be in document order and disjoint",
        { details: { slotId: slot.id, contentStart: slot.contentStart, contentEnd: slot.contentEnd } },
      );
    }

    body += template.html.slice(cursor, slot.contentStart);

    // ⚠️ `Object.hasOwn`, not a bare index. `SLOT_ID_PATTERN` accepts
    // `constructor` — the ONE `Object.prototype` key that matches it — so a
    // bare `slots[slot.id]` on a slot with that id returns the inherited
    // constructor for a tick that wrote nothing, and the frame renders
    // `function Object() { [native code] }` as the day's analysis. It is
    // strictly worse than the `undefined` this criterion already forbids: it
    // is prose-shaped, so a human reads it as output, and it strips to
    // nothing, so `strippedCount` stays 0 and W23's degraded notice never
    // fires. And it survives, because the template is frozen by
    // `structureHash` and only an amendment can rename the slot.
    const raw = Object.hasOwn(slots, slot.id) ? slots[slot.id] : undefined;
    if (raw !== undefined && raw !== null) {
      const sanitised = sanitiseSlot(raw);
      body += sanitised.html;
      strippedBySlot[slot.id] = sanitised.strippedCount;
      strippedCount += sanitised.strippedCount;
    }
    // An unfilled slot contributes NOTHING — the element renders empty. Not
    // the string "undefined", which is what a bare interpolation of a missing
    // key produces and which a human would read as the day's analysis.

    cursor = slot.contentEnd;
  }
  body += template.html.slice(cursor);

  const seriesJson = escapeForScriptElement(serialiseSeriesPayload(series));

  const html =
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<script>window.__WOLF_SERIES__ = ${seriesJson};</script>\n` +
    "</head>\n" +
    "<body>\n" +
    body +
    "\n</body>\n" +
    "</html>\n";

  return { html, csp: frameCsp(template), strippedCount, strippedBySlot };
}
