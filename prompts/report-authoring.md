# Agent Wolf — Report authoring

This document is the contract for Agent Wolf's **report layer**: the human-approved HTML template
that gives a hypothesis its own report, and the daily content that fills it. Both the interviewer
and the daily researcher work against this contract, and both are held to it by code — a template
that breaks a rule below is refused at go-live with a per-rule error list, not accepted and then
found broken later.

## The shape of the thing

A report has exactly two parts, written by two different actors at two different times.

- **The template.** One HTML **fragment**, authored during the interview, reviewed by a human on
  the Go Live screen, and then **frozen**: its bytes are hashed (`structureHash`) and stored, and
  nothing running inside a container can change them. The template owns every script, every
  stylesheet, every URL, and all of the page's structure.
- **The slots.** Regions the template declares with `data-wolf-slot="<id>"`. Each daily tick writes
  one short HTML fragment per slot — the day's prose — and Agent Wolf sanitises every one of them
  down to a small, fixed allow list before a human ever sees it.

Agent Wolf assembles the two into one sandboxed frame per hypothesis. The document skeleton
(`<!doctype html>`, `<html>`, `<head>`, `<body>`) belongs to Agent Wolf, not to the template.

**Why the split is this severe.** Slot content is written daily by a model and reviewed by nobody.
The template is written once and reviewed by a person. So everything that can reach the network,
run code, or change the page's structure lives in the reviewed half, and the unreviewed half is
prose. If you find yourself wanting a slot to do something structural, the answer is almost always
that the thing belongs in the template.

## Who writes what

| Actor | Writes | Kind |
| --- | --- | --- |
| **Interviewer** (in the interview session) | The proposed template, as a **candidate** | `kind=report-candidate` |
| **Human**, on the Go Live screen | Accepts the candidate; Agent Wolf writes the locked template | `kind=report-template` |
| **Daily researcher** (each tick) | The day's headline and slot content | `kind=report` |
| **Daily researcher**, optionally | A **proposed** replacement template | `kind=report-amendment` |

**The interviewer writes `kind=report-candidate` and nothing else.** A candidate is a proposal
sitting in front of a human. Writing it does not create a template, does not lock anything, and
does not make the hypothesis live. Only a human, on the Go Live screen, outside the session, turns
a candidate into the locked template — and the same screen shows them every remote host the
template would contact before they decide.

**The researcher may propose a template change but may never enact one.** This mirrors the
spec-amendment rule exactly: if the template needs to change — a slot that is never useful, a
missing row, a chart that shows the wrong thing — write a `kind=report-amendment` memory describing
the change and why, and carry on filling the template that is locked today. A human accepts or
rejects it. A researcher never writes a `kind=report-template` memory, under any label, for any
reason; one that came from inside a container is not trusted by anything that reads it.

---

## The template contract

Every rule below is enforced by `parseTemplate` / `validateTemplate`. A template that breaks one is
rejected with `{path, message}` errors naming the offending construct, and is never locked.

### 1. It is a fragment

No `<!doctype>`, and no `<html>`, `<head>` or `<body>` element. Agent Wolf owns the skeleton, and a
template carrying any of those is refused so that the two halves cannot both claim it.

### 2. Slots are `data-wolf-slot="<id>"`

- The id matches `^[a-z][a-z0-9-]{0,31}$` — lowercase, starts with a letter, hyphens and digits
  allowed, at most 32 characters.
- **Ids must be unique.** A duplicate is an error, not last-wins: two regions sharing an id makes
  it impossible to tell a filled slot from an unfilled one.
- A slot is a **container the tick can fill**. It may not be declared on a void element
  (`<img>`, `<br>`, `<hr>`, …), on a self-closing tag, on an element that is never closed, or
  inside another slot.
- **A slot may not be declared on a raw-text element** — `<style>`, `<title>`, `<textarea>`,
  `<xmp>`, and likewise `<script>`, `<iframe>`, `<noembed>`, `<noframes>`, `<plaintext>`. Their
  children are text, not markup, so sanitised content placed there would either render as literal
  characters a reader mistakes for analysis, or end the element early and re-enter markup. This is
  a security rule and the validator refuses it outright.
- A slot inside `<template>` or `<noscript>` is refused too: those render nothing, so the tick
  would be filling bytes no operator ever sees.
- 🔴 **An unfilled slot renders EMPTY, so what the template writes inside a slot is not a
  placeholder anyone sees.** Agent Wolf replaces a slot's children with the day's content, or with
  nothing at all when the tick did not fill it. Markup inside a slot is therefore documentation for
  the human reviewing the template and for nobody else. Put every heading, label and table cell
  **outside** the slot, so the page still reads correctly on a day when a slot is empty.

### 3. Every URL is `https:`, and every URL lives here

- `http:`, protocol-relative (`//host/…`), `javascript:` and every other scheme are refused.
  A **schemeless path is refused too** — `<img src="/local/x.png">` and `url(images/x.png)` are
  both rejected for not being absolute `https:` URLs. There is nothing local to be relative to:
  the frame is assembled from the template's own bytes and fetches everything else by absolute URL.
- **`data:` is permitted in two places, and refused everywhere else.** On an `<img src>` attribute,
  and inside CSS — `background-image: url(data:image/png;base64,…)` and a `@font-face` `src` both
  pass, and the frame's policy carries `img-src … data:` and `font-src … data:` to match. On any
  other attribute (`<embed src="data:…">`, `<object data="data:…">`) it is refused.
- The rule reaches well past `src` and `href`. Every channel in this list is read and held to it:
  CSS `@import`, CSS `url(…)`, `image-set(…)` (including `type()` and the `-webkit-` prefix — those
  parse), `style` attributes, `<iframe srcdoc>` contents, `<meta http-equiv="refresh">` targets and
  `<object><param>` values. Write a URL somewhere exotic enough that it is not on that list and you
  are relying on nobody having thought about it — put the URL in an ordinary attribute instead.
- 🔴 **A same-document fragment reference is refused in an attribute and carved out in CSS.**
  `<a href="#chart">` and `<use href="#glyph">` are **rejected** — the attribute rule wants an
  absolute `https:` URL and `"#chart"` is not one. The carve-out is on the **CSS** side only:
  `fill: url(#gradient)` in a `style` attribute or a `<style>` block **is** allowed, because that
  is how an SVG chart references its own paint server and it resolves inside the document rather
  than over the network. So reference a gradient, clip path or marker **from CSS**, and do not
  write an in-page anchor link.
- Remote scripts and stylesheets are permitted, but every host is listed on the Go Live screen for
  a human to approve, and the frame's Content-Security-Policy is derived from exactly that list —
  a host the template did not declare is a fetch the browser blocks. A template that needs nothing
  remote is the better default: it cannot fail because a CDN is down, and it grants no host at all.

### 4. The fallback element is mandatory — **and the template must remove it**

The template must contain an element carrying `data-wolf-fallback`, and that element must actually
render (not hidden inside `<template>` or `<noscript>`). It is the operator's only signal that the
chart never drew: the frame is sandboxed and opaque, so a script error, a blocked fetch or a dead
CDN is otherwise indistinguishable from an empty report.

🔴 **The template's own script must remove that element once the chart has rendered.** A template
that declares the fallback and never removes it displays a permanent failure message on every
healthy report, and an operator who sees it every day stops reading it — at which point the one
signal the design depends on is worth nothing. The removal belongs at the **end of a successful
draw**, never in a `finally`, never at the top of the render function, and never before the chart
is actually on the page. The worked example does this in `removeFallback()`; read it there.

A day with no data yet is a **successful render**, not a failure: draw the "no observations yet"
state and remove the fallback. The fallback is about the chart never running.

### 5. Series arrive on `window.__WOLF_SERIES__`

Agent Wolf injects the data before any template script runs:

```js
window.__WOLF_SERIES__ = {
  "gold-usd": {
    unit: "usd",
    version: 7,                                  // the dataset version this came from
    points: [{ tMs: 1787097600000, v: 2413.55 }] // ascending by tMs
  }
};
```

- Keyed by **metric slug**, exactly as the locked spec names it.
- `tMs` is **epoch milliseconds**, UTC. `v` is a number. Nothing else is in a point.
- **Every metric in the locked spec is present, always** — a metric whose dataset has never been
  written arrives as `{unit, version: 0, points: []}`. Your chart code must handle an empty
  `points` array; it must never assume day one has data.
- **Only spec metrics are injected.** A dataset that exists in the project but is not in the spec
  never reaches the frame.
- Long histories are **downsampled** before injection (the first and last point are always kept),
  so the point count is not the observation count. Do not compute statistics from it and present
  them as the metric's true history — the scoreboard is evaluated by Agent Wolf, not by the
  template.
- Render times in **UTC**. A local-time axis makes two readers disagree about which day a move
  happened on.

### 6. Size

A template is capped at `WOLF_REPORT_MAX_BYTES` (512 KB by default). An oversized template is
refused on that alone, with nothing else reported — nobody has read the rest of it.

---

## The slot contract — what the daily tick may write

Slot content is parsed and stripped to a fixed allow list before it is inserted. Anything outside
the list is removed. **This is the complete list; do not assume anything else survives.**

**Elements:** `p` `br` `hr` `span` `div` `section` `strong` `em` `b` `i` `u` `s` `small` `mark`
`code` `pre` `kbd` `samp` `var` `sub` `sup` `abbr` `dfn` `q` `blockquote` `cite` `time`
`h1`–`h6` `ul` `ol` `li` `dl` `dt` `dd` `table` `caption` `thead` `tbody` `tfoot` `tr` `th` `td`.

**Attributes:** `class` `title` `lang` `dir` `datetime` `colspan` `rowspan` `scope` `headers`.

Everything else goes, and the consequences are worth stating plainly:

- **No URLs of any kind.** `<img>`, `<a href>`, `src`, `href` and `style` are all absent from the
  list. `<a href="https://example.com/x">source</a>` becomes the bare text `source`. A URL in a
  slot would be a daily, unreviewed way to reach the network from inside a frame designed to reach
  nothing; put every URL in the template, where a human approved it.
- **No `id`.** Slot content that could set an `id` could shadow an element the template's own
  script looks up by id. `class` is enough for styling.
- **No `data-*` attributes**, including `data-wolf-slot` — the tick must not be able to
  manufacture a phantom slot inside a slot.
- **No `style` attribute, no ARIA attributes, no `<svg>` or `<math>`.** Graphics come from the
  template.
- **No `<script>`, no `<style>`, no event handlers.** `<script>alert(1)</script>` is removed
  whole — its text does not survive either.
- A wrapper element that is not on the list is dropped and **its children are kept**:
  `<article><p>analysis</p></article>` becomes `<p>analysis</p>`. Reach for a listed element
  anyway; `div` and `section` are both available.

### 🔴 Table structure lives in the TEMPLATE, not in a slot

A slot's content is parsed as if it stood alone in a document body, so the parser has no idea the
slot sits inside a `<tbody>` or a `<tr>`. Filling a table-internal slot with row markup **loses the
tags to the parser, keeps only the text, and reports that nothing was stripped**:

```
in : <tr><td>Gold</td><td>1.2%</td></tr>
out: Gold1.2%                              (stripped count: 0 — nothing says anything went wrong)
```

That failure is silent, which is why it is called out here rather than left to be discovered. Two
rules follow:

1. **The template declares the whole table** — `<table>`, `<thead>`, `<tr>`, `<th>`, `<td>` — and
   puts a slot **inside a cell**, so the tick writes prose into a cell that already exists. That is
   what the worked example does.
2. If a report genuinely needs a table whose *rows* vary day to day, the slot must contain a
   **complete, self-contained `<table>…</table>`** — that does survive, because a whole table is
   valid on its own in body context. A bare `<tbody>`, `<tr>` or `<td>` fragment does not.

### The stripped-content notice

Agent Wolf counts what it removed from each slot and shows a "content was removed from this report"
notice when the count is above zero. It is not a punishment, but it does mean the day's report is
not what the researcher wrote — so write inside the list and the notice never fires.

---

## The worked example

**`api/src/report/__fixtures__/example-template.html`** is a complete, valid template. It is not
duplicated here on purpose: a test runs those exact bytes through `parseTemplate` and
`validateTemplate` on every run, so it cannot drift away from the rules above, while a copy pasted
into this prose could.

Read it for:

- the fragment shape, with no document skeleton;
- `[data-wolf-fallback]`, and `removeFallback()` being called at the end of a successful draw —
  the single most commonly missed rule in this document;
- a `<table>` declared entirely in the template with a slot in each comment **cell**, and every
  heading placed outside its slot so the page survives an empty one;
- the inline script reading `window.__WOLF_SERIES__`, handling `points: []`, and formatting dates
  in UTC;
- `stroke: url(#wolf-line)` in its `<style>` block — the in-document paint-server carve-out, which
  lives on the CSS side — next to a template with no remote URL at all.

Start from it. A template that is a small edit of a template known to validate is worth more than
an original that has to discover these rules one 422 at a time.

---

## Writing the daily report memory

Each tick, after the datasets are written, the researcher writes **one** `kind=report` memory —
`memory_create` with labels `{"kind": "report", "name": "<hypothesis-id>"}` and `embed: false`.
Its content is:

- **Line 1: the headline** — one plain sentence, no markup, the thing a person scanning the board
  reads. It is truncated on read at 400 characters, so put the finding first. Never leave it empty;
  never make it a status word like "Report".
- **Everything after line 1: a JSON object mapping slot id to HTML fragment**, and nothing else —
  no prose, no code fences, no commentary. It must be flat: every value a string, no nesting, no
  `null`. A slot you have nothing to say about is **omitted**, not filled with an empty string.
- Use the slot ids the locked template declares. An id that is not in the template is reported as
  drift, and a template slot you never fill is reported as unfilled — both are visible to a human,
  so neither is a way to quietly skip a section.
- 🔴 **`embed: false` is required.** A report carries HTML for every slot, and content over 24 KB
  with the default `embed: true` is rejected outright by the meaning-indexing limit — a report
  reaches that quickly and would then fail on a busy day and not a quiet one, which is the worst
  possible way to find out. With `embed: false` it is stored whole and stays searchable by label
  and by keyword.
- One report per tick, and it replaces nothing — memories are append-only, and the newest report
  for the hypothesis is the one rendered.

Write the report **after** `dataset_put`, so the numbers in the prose and the series the chart
draws come from the same data.
