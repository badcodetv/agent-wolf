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
 *  2. **Elements the HTML parser puts in `<head>` never reach the
 *     sanitiser.** A slot whose content *starts with* `<script>`, `<style>`,
 *     `<link>`, `<meta>`, `<base>`, `<title>` or `<template>` has that
 *     element absorbed into the `<head>` of DOMPurify's throwaway document,
 *     and only the `<body>` is walked and serialised. The output is
 *     correct — the element is gone — but nothing was "removed", so
 *     `strippedCount` reports **0** for it. See `KNOWN GAP` below.
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
    // ⚠️ `#text` is LOAD-BEARING and must stay first. DOMPurify treats an
    // explicit ALLOWED_TAGS list as exhaustive INCLUDING text nodes, so
    // omitting it strips every character of prose while leaving the elements
    // standing: `<p class="lead">Gold <strong>rose</strong> 4%.</p>` sanitises
    // to `<p class="lead"><strong></strong></p>`. Every report would render
    // empty and no test that only checks "the dangerous token is absent"
    // would notice. Proved against isomorphic-dompurify ^2 on 2026-08-22.
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

/**
 * The number of nodes and attributes the sanitiser actually removed from the
 * model's content — the number W23 renders to a human as
 * `Severity level="degraded"`.
 *
 * ⚠️ **The wrapper-root correction.** `DOMPurify.removed` always leads with
 * the walk root — the parser's `<body>`, which is not on `ALLOWED_TAGS` and
 * so is hoisted and removed like anything else. It is an artefact of how
 * DOMPurify parses a fragment, not something the model wrote, and counting
 * it would make `strippedCount` **1 for clean input**, which the ticket
 * forbids and which would light a "content was removed" warning on every
 * healthy report in the product.
 *
 * The correction drops **at most one leading element record named `BODY`**,
 * and is safe in both directions:
 *
 *  - A model-authored `<body>` in slot content never produces a second
 *    record: the HTML parser merges a nested `<body>` start tag into the
 *    existing body rather than creating an element, so there is nothing to
 *    remove. (Its attributes merge too, and vanish with the wrapper.)
 *  - If a future DOMPurify stops recording its walk root, nothing is
 *    dropped and the count is still right. The "clean input counts zero"
 *    test is what pins the assumption either way.
 *
 * Every removed **attribute** counts as one, including attributes stripped
 * off an element that was itself removed — so `<img src=x onerror=y>` counts
 * **three** (the element and its two attributes), not one. That is the
 * ticket's wording ("counts removed nodes AND attributes") read literally,
 * and it errs towards over-reporting a strip rather than under-reporting it.
 *
 * 🔴 **KNOWN GAP, reported rather than papered over.** Content the HTML
 * parser puts in `<head>` — a slot *beginning* with `<script>`, `<style>`,
 * `<link>`, `<meta>`, `<base>`, `<title>` or `<template>` — is discarded
 * before DOMPurify walks anything, so it is removed from the output but
 * absent from `removed`, and `strippedCount` is **0**. The output is safe;
 * the *count* understates. DOMPurify's own `FORCE_BODY: true` closes it in
 * one line by pushing the parser into body mode, but that key is not in the
 * pinned profile and adding it is an owner decision, not an executor's.
 * `sanitise.test.ts` pins the current behaviour so the gap is visible rather
 * than silent.
 */
function countStripped(removed: readonly RemovedRecord[]): number {
  const first = removed[0];
  const leadsWithWrapperRoot =
    first !== undefined &&
    first.attribute === undefined &&
    first.element?.nodeName === "BODY";
  return leadsWithWrapperRoot ? removed.length - 1 : removed.length;
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
  return { html: clean, strippedCount: countStripped(removed) };
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
 * every error at once (W16's `templateValidationError`), so W21's route
 * renders one 422 with a per-path list rather than one round trip per
 * mistake.
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
