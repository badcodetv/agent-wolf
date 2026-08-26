/**
 * The slot sanitiser and template validation — the security boundary of the
 * whole report feature.
 *
 * design/2026-08-20-agent-wolf.md § W17 is the ticket; § "The slot sanitiser
 * profile, pinned as an ALLOW list" is the source of `SLOT_PROFILE`, copied
 * here byte-for-byte. **Widening that list is an owner decision**, which is
 * why `sanitise.test.ts` asserts `ALLOWED_TAGS` and `ALLOWED_ATTR` against
 * the pinned literals: a later widening is then a visible diff rather than a
 * quiet one.
 *
 * ## The asymmetry, which is the entire design
 *
 * The same script text **passes `validateTemplate`** and **is stripped by
 * `sanitiseSlot`**, and that is deliberate:
 *
 *  - A **template** is written once, reviewed by a human at go-live, frozen
 *    by `structureHash`, and changeable only through an amendment. Its
 *    inline chart code is the whole reason the frame runs scripts at all.
 *    `validateTemplate` therefore **validates and never mutates** — it
 *    cannot "clean up" a template, because a cleaned template is a template
 *    no human approved and whose hash no longer matches the lock.
 *  - A **slot** is filled every day by a model and is never reviewed by
 *    anybody. Everything a slot may contain is on `SLOT_PROFILE`'s allow
 *    list, and no URL-bearing attribute is on it, so a daily tick can add no
 *    script, no handler and no network egress.
 *
 * If those two paths ever agreed, the locking design would be pointless.
 * There is deliberately **no `sanitiseTemplate`**: the name alone would
 * invite someone to mutate a locked template, and a test asserts no such
 * export exists.
 *
 * ## Two library facts this module exists to absorb
 *
 * Both were found by EXECUTING `isomorphic-dompurify` ^2 rather than reading
 * it, which is the method R120 prescribes after four defects in the pinned
 * profile were found that way.
 *
 *  1. **DOMPurify records its own walk root in `DOMPurify.removed`.** With
 *     `WHOLE_DOCUMENT: false` the walk root is the parser's `<body>`
 *     wrapper, which is not on `ALLOWED_TAGS`, so it is hoisted and removed
 *     like any other disallowed element — and recorded. `removed.length` is
 *     therefore **1 for perfectly clean input**, and `strippedCount` would
 *     have been permanently off by one (see `countStripped`).
 *  2. **Without `FORCE_BODY`, elements the HTML parser puts in `<head>`
 *     never reach the sanitiser at all.** W17 measured that gap, the owner
 *     ruled on 2026-08-26, and the pinned profile now carries
 *     `FORCE_BODY: true` (R147): every slot is parsed in body context, so
 *     `<script>` first in a slot is now removed BY THE SANITISER and
 *     counted, instead of being discarded by the parser and counted as
 *     zero. `FORCE_BODY` costs a second artefact record — see
 *     `countStripped`.
 */

import DOMPurify from "isomorphic-dompurify";

import { parseTemplate, templateValidationError } from "./template.js";
import type { ParsedTemplate } from "./template.js";

/* ------------------------------------------------------------------ */
/* the pinned profile                                                  */
/* ------------------------------------------------------------------ */

/**
 * The allow list, byte-for-byte from design/2026-08-20-agent-wolf.md
 * § "The slot sanitiser profile, pinned as an ALLOW list". Do not edit
 * without an owner decision; `sanitise.test.ts` pins both lists.
 */
export const SLOT_PROFILE = {
  ALLOWED_TAGS: [
    // ⚠️ `#text` and `KEEP_CONTENT: true` DEFEND THE SAME FAILURE AND MOVE
    // TOGETHER — do not delete either because the other makes it look inert.
    // DOMPurify treats an explicit ALLOWED_TAGS list as exhaustive INCLUDING
    // text nodes, so with `KEEP_CONTENT: false` omitting `#text` strips every
    // character of prose while leaving the elements standing:
    // `<p class="lead">Gold <strong>rose</strong> 4%.</p>` sanitises to
    // `<p class="lead"><strong></strong></p>`, every report renders empty, and
    // no test that only checks "the dangerous token is absent" would notice.
    // ⚠️ With `KEEP_CONTENT: true` — which this profile sets — the library
    // adds `#text` itself (`dompurify/dist/purify.cjs.js:916`), so removing
    // `#text` TODAY changes nothing and mutation-testing it reddens only the
    // literal pin. That inertness is the trap: an editor who deletes it now
    // re-opens a blocking defect the moment anyone revisits `KEEP_CONTENT`,
    // which looks like the safer setting. Measured all four combinations,
    // W17, 2026-08-26 — see R146. R120(1) was observed against the pre-R120(2)
    // draft, where `KEEP_CONTENT` was still `false`; this entry corrects the
    // rationale, not the value. Proved against isomorphic-dompurify ^2.
    "#text",
    "p", "br", "hr", "span", "div", "section",
    "strong", "em", "b", "i", "u", "s", "small", "mark",
    "code", "pre", "kbd", "samp", "var", "sub", "sup",
    "abbr", "dfn", "q", "blockquote", "cite", "time",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  ],
  ALLOWED_ATTR: [
    "class", "title", "lang", "dir",
    "datetime", "colspan", "rowspan", "scope", "headers",
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  USE_PROFILES: false,
  WHOLE_DOCUMENT: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
  FORBID_CONTENTS: ["script", "style", "template", "noscript", "title", "textarea", "xmp"],
  // ⚠️ ADDED 2026-08-26 by owner ruling, and it is a VISIBILITY fix, not a
  // safety one — the output was already safe without it. Without `FORCE_BODY`,
  // DOMPurify parses slot content in document context and returns only
  // `<body>` (`WHOLE_DOCUMENT: false`), so content that BEGINS with `<script>`,
  // `<style>`, `<link>`, `<meta>`, `<base>`, `<title>` or `<template>` is
  // hoisted into `<head>` by the PARSER and never reaches the sanitiser at all.
  // It is discarded — but `strippedCount` is then **0**, so the worst possible
  // slot in the product (`<script>alert(1)</script>` alone) renders as an empty
  // region with NO degraded-severity notice, because W23 gates that notice on
  // `stripped_count > 0`. `FORCE_BODY` prefixes a throwaway element to push the
  // parser into body mode: output is unchanged, counting becomes correct.
  // See R147. W17 measured the gap and declined to close it unilaterally,
  // which was right — this is a byte-for-byte pinned profile.
  FORCE_BODY: true,
} as const;

/**
 * `SLOT_PROFILE` is `as const`, so its arrays are `readonly string[]` while
 * DOMPurify's `Config` wants mutable arrays. The cast is here, once, rather
 * than at the call site, and it is the ONLY place the profile is widened in
 * any sense: nothing is added to it and nothing is removed from it.
 *
 * `dompurify`'s own types are deliberately not imported — it is a transitive
 * dependency of `isomorphic-dompurify`, not a declared dependency of `api/`,
 * and importing it directly would make a second sanitiser package look like
 * a legitimate import site.
 */
const SANITISE_CONFIG = SLOT_PROFILE as unknown as Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* the strip counter                                                   */
/* ------------------------------------------------------------------ */

/** One entry of `DOMPurify.removed`, structurally. */
interface RemovedRecord {
  /** Present on a removed ELEMENT record. */
  element?: { nodeName?: string } | null;
  /** Present on a removed ATTRIBUTE record (alongside `from`). */
  attribute?: { name?: string } | null;
}

/** True when `record` is a removed ELEMENT (or comment) with this node name. */
function isRemovedNode(record: RemovedRecord | undefined, nodeName: string): boolean {
  return (
    record !== undefined &&
    record.attribute === undefined &&
    record.element?.nodeName === nodeName
  );
}

/**
 * The number of nodes and attributes the sanitiser actually removed from the
 * model's content — the number W23 renders to a human as
 * `Severity level="degraded"`.
 *
 * ⚠️ **The artefact prefix.** `DOMPurify.removed` leads with up to three
 * records for nodes DOMPurify itself manufactured, none of which the model
 * wrote. Counting them would make `strippedCount` non-zero for CLEAN input,
 * which the ticket forbids and which would light a "content was removed"
 * warning on every healthy report in the product. In the order they are
 * pushed, against `dompurify` 3.4.x:
 *
 *  1. **`<remove>`** — the `FORCE_BODY` sentinel. `_initDocument` prefixes
 *     `<remove></remove>` to push the parser into body mode, and `sanitize`
 *     force-removes `body.firstChild` before the walk (`purify.cjs.js:2498`),
 *     which records it first.
 *  2. **`<body>`** — the walk root. With `WHOLE_DOCUMENT: false` the root is
 *     the parser's `<body>`, which is not on `ALLOWED_TAGS`, so it is
 *     hoisted and removed like any other disallowed element.
 *  3. **`#comment`** — only for an EMPTY input, where DOMPurify substitutes
 *     `dirty = '<!-->'` (`IS_EMPTY_INPUT`, `purify.cjs.js:2364`). This step
 *     is gated on the input actually being empty, so a comment the MODEL
 *     wrote is still counted.
 *
 * Each step fires at most once and only while the record at the head of the
 * array is the artefact next expected, so the rule is safe in both
 * directions:
 *
 *  - A model-authored `<remove>` or `<body>` is still counted. The parser
 *    merges a nested `<body>` start tag into the existing body rather than
 *    creating an element (its attributes merge too, and any that survive the
 *    allow list vanish with the wrapper); a model-authored `<remove>` sits
 *    AFTER the `<body>` record, where no step is looking for it.
 *  - If a future DOMPurify stops emitting one of these, that step simply
 *    does not fire and the count is still right. The "zero for clean input"
 *    tests are what pin the assumption either way.
 *
 * Every removed **attribute** counts as one, including attributes stripped
 * off an element that was itself removed — so `<img src=x onerror=y>` counts
 * **three** (the element and its two attributes), not one. That is the
 * ticket's wording ("counts removed nodes AND attributes") read literally,
 * and it errs towards over-reporting a strip rather than under-reporting it.
 */
function countStripped(removed: readonly RemovedRecord[], input: string): number {
  let artefacts = 0;
  if (isRemovedNode(removed[artefacts], "REMOVE")) artefacts += 1;
  if (isRemovedNode(removed[artefacts], "BODY")) artefacts += 1;
  if (input === "" && isRemovedNode(removed[artefacts], "#comment")) artefacts += 1;
  return removed.length - artefacts;
}

/* ------------------------------------------------------------------ */
/* the slot sanitiser                                                  */
/* ------------------------------------------------------------------ */

/** What `sanitiseSlot` returns: the safe HTML, and what it cost to get it. */
export interface SanitisedSlot {
  /** The slot content, stripped to `SLOT_PROFILE`. Safe to insert. */
  html: string;
  /**
   * How many nodes and attributes were removed. **Zero for clean input.**
   * W23 renders `> 0` as a degraded-severity notice with this number, so it
   * is a human-facing quantity, not a debug counter.
   */
  strippedCount: number;
}

/**
 * Strips model-authored slot content to `SLOT_PROFILE`.
 *
 * This is the one function standing between a container's output and a
 * person's browser. It is **idempotent** — sanitising twice equals
 * sanitising once, across the whole vector table — because a sanitiser whose
 * output is not a fixed point is a mutation-XSS smell: it means the parser
 * reads its own output differently from how it read the input.
 */
export function sanitiseSlot(html: string): SanitisedSlot {
  const clean = DOMPurify.sanitize(html, SANITISE_CONFIG) as unknown as string;
  // Read IMMEDIATELY: `removed` is instance state reset at the start of the
  // next `sanitize` call, so anything between the two lines loses it.
  const removed = (DOMPurify as unknown as { removed: readonly RemovedRecord[] }).removed;
  return { html: clean, strippedCount: countStripped(removed, html) };
}

/* ------------------------------------------------------------------ */
/* template validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validates a report template. **Never mutates it, and never returns HTML.**
 *
 * On success it returns W16's `ParsedTemplate` — whose `html` is the bytes
 * handed in, verbatim, and whose `structureHash` is sha256 of exactly those
 * bytes. On failure it throws the shared taxonomy's `invalid` kind carrying
 * every error at once (W16's `templateValidationError`), so a caller renders
 * one response with a per-path list rather than one round trip per mistake.
 *
 * ⚠️ **That error is a 400, not the 422 the route contract pins.**
 * `templateValidationError` builds `kind: "invalid"`, and `invalid`'s default
 * status is 400 (`errors.ts`), while § "HTTP routes added" pins template
 * validation failure at **422**. The status is supplied by the caller:
 * `routes/report.ts`'s `validateSubmittedTemplate` re-wraps this error with
 * `status: 422`, carrying `details` across untouched, exactly as W9's
 * `specRejection` does for a spec. *(This comment previously asserted that
 * this function was itself what made "W21's route render one 422". It never
 * was, and a false statement in a merged file is worse than a missing one —
 * the next reader has no reason to measure it. Corrected 2026-08-26, W21.)*
 *
 * There is no sanitising counterpart, on purpose — see this module's header.
 * A template's script tags survive here **by design**; the same bytes handed
 * to `sanitiseSlot` do not survive at all.
 *
 * @param html     the template fragment, exactly as it is stored
 * @param maxBytes the byte budget — a parameter, never read from config here
 */
export function validateTemplate(html: string, maxBytes: number): ParsedTemplate {
  const result = parseTemplate(html, maxBytes);
  if (!result.valid) throw templateValidationError(result.errors);
  return result.template;
}
