import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { WolfError } from "../errors.js";
import * as store from "../hypothesis/store.js";
import {
  HEADLINE_MAX_CHARS,
  KIND_REPORT,
  KIND_REPORT_AMENDMENT,
  KIND_REPORT_CANDIDATE,
  KIND_REPORT_TEMPLATE,
  REPORT_KIND_LIST,
  TRUSTED_KINDS,
  TRUSTED_KIND_LIST,
  buildReportAmendmentContent,
  buildReportCandidateContent,
  buildReportContent,
  buildReportTemplateContent,
  forgedRowTamper,
  hasEmptyProvenance,
  hostileRetractionTamper,
  isReportMemoryKind,
  isTrusted,
  parseReportContent,
  parseTemplateContent,
  reportAmendmentLabels,
  reportCandidateLabels,
  reportLabels,
  reportSelector,
  reportTemplateLabels,
  splitFirstLine,
  truncateHeadline,
} from "./kinds.js";

// design/2026-08-20-agent-wolf.md, W15's acceptance criteria + § "Memory kinds"
// + § "The trust model". Test names are prefixed `report_kinds_`.

// ── TRUSTED_KINDS: enumerated, never counted ────────────────────────────

describe("report_kinds_trusted_kinds", () => {
  it("report_kinds_trusted_kinds: membership for all five, non-membership for the five untrusted ones", () => {
    // ENUMERATED, NEVER COUNTED. `expect(TRUSTED_KINDS.size).toBe(5)` passes
    // against the WRONG five, and the wrong five makes every memory W10's
    // poller writes untrusted — the board silently shows no support_score and
    // nothing anywhere fails. So: membership, one kind at a time.
    for (const kind of [
      "hypothesis",
      "hypothesis-spec",
      "verdict",
      "evaluation",
      "report-template",
    ]) {
      expect(TRUSTED_KINDS.has(kind)).toBe(true);
    }
    for (const kind of [
      "report",
      "report-candidate",
      "report-amendment",
      "research-note",
      "spec-amendment",
    ]) {
      expect(TRUSTED_KINDS.has(kind)).toBe(false);
    }
  });

  it("report_kinds_trusted_kinds: this module RE-EXPORTS W5's set — it does not declare a second one", () => {
    // R48: "One must define and the other re-export." Identity, not equality:
    // two structurally-identical sets would drift the moment one gained a kind.
    expect(TRUSTED_KINDS).toBe(store.TRUSTED_KINDS);
    expect(TRUSTED_KIND_LIST).toBe(store.TRUSTED_KIND_LIST);
    expect(isTrusted).toBe(store.isTrusted);
    expect(hasEmptyProvenance).toBe(store.hasEmptyProvenance);
    expect(forgedRowTamper).toBe(store.forgedRowTamper);
    expect(hostileRetractionTamper).toBe(store.hostileRetractionTamper);

    // And the source carries no second enumeration: a re-export cannot contain
    // the other four trusted kind strings, while a redeclaration must.
    const src = readFileSync(new URL("./kinds.ts", import.meta.url), "utf8");
    for (const kind of ["hypothesis-spec", "verdict", "evaluation"]) {
      expect(src.includes(`"${kind}"`)).toBe(false);
    }
  });

  it("report_kinds_trusted_kinds: the re-exported set is still frozen at runtime", () => {
    expect(() => (TRUSTED_KINDS as Set<string>).add("report")).toThrow(TypeError);
    expect(TRUSTED_KINDS.has("report")).toBe(false);
  });
});

describe("report_kinds_import_cycle", () => {
  it("report_kinds_import_cycle: loading THIS module first works — the cycle with store.ts is evaluation-safe", async () => {
    // `kinds.ts` imports the trust primitives from `hypothesis/store.ts`, and
    // `store.ts` imports the report vocabulary back. That cycle is safe only
    // while NEITHER side reads a value from the other at module-evaluation
    // time. The static imports at the top of this file happen to pull
    // `store.ts` in first; this drives the OTHER order.
    //
    // ⚠️ HONEST LIMIT OF THIS TEST: it does NOT gate the TDZ hazard. Vitest's
    // SSR transform rewrites ESM imports into lazy accessors, so a top-level
    // `const x = KIND_REPORT_TEMPLATE` added to `store.ts` still passes here.
    // Under real node ESM — which is what `node dist/index.js` runs — it
    // throws a ReferenceError on the kinds-first order; that was verified out
    // of tree by compiling with `tsc --outDir`, importing each module first,
    // and re-running with the offending line added (it fails; without it both
    // orders print OK). What this test DOES prove is that importing `kinds.ts`
    // without `store.ts` already resident yields a working module.
    vi.resetModules();
    const freshKinds = await import("./kinds.js");
    expect(freshKinds.TRUSTED_KINDS.has("report-template")).toBe(true);
    expect(freshKinds.reportSelector("report", "1a2b3c4d")).toBe("kind=report,name=1a2b3c4d");
    const freshStore = await import("../hypothesis/store.js");
    expect(freshKinds.TRUSTED_KINDS).toBe(freshStore.TRUSTED_KINDS);
    vi.resetModules();
  });
});

// ── isTrusted: all three clauses ────────────────────────────────────────

describe("report_kinds_is_trusted", () => {
  const sessions = new Set(["1a2b3c4d"]);
  const template = {
    labels: { kind: KIND_REPORT_TEMPLATE, name: "1a2b3c4d", status: "locked" },
    createdByWorker: "",
    createdBySession: "",
  };

  it("report_kinds_is_trusted: a locked template with empty provenance and a live session is trusted", () => {
    expect(isTrusted(template, sessions)).toBe(true);
  });

  it("report_kinds_is_trusted: clause 1 — any provenance at all makes it untrusted", () => {
    expect(isTrusted({ ...template, createdBySession: "sess-attacker" }, sessions)).toBe(false);
    expect(isTrusted({ ...template, createdByWorker: "researcher-1a2b3c4d" }, sessions)).toBe(false);
  });

  it("report_kinds_is_trusted: clause 2 — an untrusted kind is untrusted however clean its provenance", () => {
    for (const kind of [KIND_REPORT, KIND_REPORT_CANDIDATE, KIND_REPORT_AMENDMENT]) {
      expect(isTrusted({ ...template, labels: { ...template.labels, kind } }, sessions)).toBe(false);
    }
  });

  it("report_kinds_is_trusted: clause 3 — passing ONLY the first two clauses is NOT trusted", () => {
    // This is the `ApplyTopology` forgery path (R24): that call writes
    // provenance-free seeds and is reachable by any API-class credential, so
    // empty provenance plus a trusted kind is NOT sufficient. The session
    // clause is the one that cannot be forged from inside a container —
    // creating a named session requires an API key or a console JWT.
    const orphan = { ...template, labels: { ...template.labels, name: "99999999" } };
    expect(hasEmptyProvenance(orphan)).toBe(true);
    expect(TRUSTED_KINDS.has(orphan.labels.kind)).toBe(true);
    expect(isTrusted(orphan, sessions)).toBe(false);
  });

  it("report_kinds_is_trusted: a row with no `name` label at all is not trusted", () => {
    expect(isTrusted({ ...template, labels: { kind: KIND_REPORT_TEMPLATE } }, sessions)).toBe(false);
  });
});

// ── The four kinds and their labels ─────────────────────────────────────

describe("report_kinds_labels", () => {
  it("report_kinds_labels: the four kinds are enumerated", () => {
    expect([...REPORT_KIND_LIST]).toEqual([
      "report-template",
      "report-candidate",
      "report",
      "report-amendment",
    ]);
    expect(Object.isFrozen(REPORT_KIND_LIST)).toBe(true);
    for (const kind of REPORT_KIND_LIST) expect(isReportMemoryKind(kind)).toBe(true);
    expect(isReportMemoryKind("research-note")).toBe(false);
  });

  it("report_kinds_labels: each builder emits exactly the labels § \"Memory kinds\" pins", () => {
    expect(reportTemplateLabels("1a2b3c4d")).toEqual({
      kind: "report-template",
      name: "1a2b3c4d",
      status: "locked",
    });
    expect(reportCandidateLabels("1a2b3c4d")).toEqual({
      kind: "report-candidate",
      name: "1a2b3c4d",
    });
    expect(reportLabels("1a2b3c4d")).toEqual({ kind: "report", name: "1a2b3c4d" });
    expect(reportAmendmentLabels("1a2b3c4d")).toEqual({
      kind: "report-amendment",
      name: "1a2b3c4d",
      status: "proposed",
    });
  });

  it("report_kinds_labels: a `hyp-` prefixed id is refused — the prefix belongs to the session name only", () => {
    // The doubled prefix (`hyp-hyp-…`) makes the trust rule's session clause
    // never match, so every hypothesis reads as untrusted. § "Vocabulary".
    for (const build of [reportTemplateLabels, reportCandidateLabels, reportLabels, reportAmendmentLabels]) {
      expect(() => build("hyp-1a2b3c4d")).toThrow(WolfError);
      expect(() => build("hyp-1a2b3c4d")).toThrow(/bare hypothesis id/);
    }
    expect(() => reportLabels("1A2B3C4D")).toThrow(/bare hypothesis id/);
    expect(() => reportLabels("")).toThrow(/bare hypothesis id/);
  });

  it("report_kinds_labels: the selector is `kind=<k>,name=<id>` and pins no status", () => {
    expect(reportSelector(KIND_REPORT_TEMPLATE, "1a2b3c4d")).toBe(
      "kind=report-template,name=1a2b3c4d",
    );
    expect(reportSelector(KIND_REPORT, "1a2b3c4d")).toBe("kind=report,name=1a2b3c4d");
    // Selector semantics are Kubernetes' exactly: comma means AND, and there
    // is no OR and no nesting (§ "Environment facts").
    expect(reportSelector(KIND_REPORT, "1a2b3c4d")).not.toContain("status=");
    expect(() => reportSelector(KIND_REPORT, "hyp-1a2b3c4d")).toThrow(WolfError);
  });
});

// ── Line 1 and the 400-character headline ───────────────────────────────

describe("report_kinds_headline", () => {
  it("report_kinds_headline: the cap is 400 characters and a headline at the cap is untouched", () => {
    expect(HEADLINE_MAX_CHARS).toBe(400);
    const exact = "a".repeat(400);
    expect(truncateHeadline(exact)).toEqual({ text: exact, truncated: false });
  });

  it("report_kinds_headline: a longer headline is truncated to 400 and flagged", () => {
    const long = "b".repeat(401);
    const cut = truncateHeadline(long);
    expect(cut.text).toHaveLength(400);
    expect(cut.truncated).toBe(true);
  });

  it("report_kinds_headline: truncation lands on a CHARACTER boundary, never inside a surrogate pair", () => {
    // NOTE ON WHAT IS *NOT* TESTED HERE: the snippet limit is 500
    // **characters**, not bytes — `substring(content, 1, 500)` on a Postgres
    // `text` column is character-based (`go/agentdb/memories.go:451-452`) — so
    // a mid-multibyte SERVER split is not constructible and no test in this
    // file claims to construct one. What IS constructible is a client-side
    // one: JavaScript strings are UTF-16, `"😀".length === 2`, and a naive
    // `slice(0, 400)` can cut a surrogate pair in half and emit a lone
    // surrogate. That is what this asserts against.
    const headline = "x".repeat(399) + "😀" + "tail";
    const cut = truncateHeadline(headline);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("x".repeat(399) + "😀");
    // 400 code points, 401 UTF-16 code units — the naive slice would have
    // produced 400 units ending in an unpaired \uD83D.
    expect(Array.from(cut.text)).toHaveLength(400);
    expect(cut.text.length).toBe(401);
    for (const point of Array.from(cut.text)) {
      const code = point.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it("report_kinds_headline: splitFirstLine strips a trailing CR, so a CRLF template still hashes", () => {
    expect(splitFirstLine("hash\r\n<div>x</div>")).toEqual({
      first: "hash",
      rest: "<div>x</div>",
    });
    expect(splitFirstLine("only one line")).toEqual({ first: "only one line", rest: "" });
  });
});

// ── report-template / -candidate / -amendment content ───────────────────

describe("report_kinds_template_content", () => {
  const html = '<section data-wolf-slot="headline"><p>hi</p></section>\n<div>more</div>';

  it("report_kinds_template_content: line 1 is the structure hash, the rest is the fragment", () => {
    const content = buildReportTemplateContent({ structureHash: "abc123", html });
    expect(content.split("\n")[0]).toBe("abc123");
    expect(parseTemplateContent(content)).toEqual({ first: "abc123", html });
  });

  it("report_kinds_template_content: the candidate and amendment share the shape", () => {
    expect(parseTemplateContent(buildReportCandidateContent({ summary: "a first draft", html }))).toEqual({
      first: "a first draft",
      html,
    });
    expect(
      parseTemplateContent(buildReportAmendmentContent({ rationale: "the chart is unreadable", html })),
    ).toEqual({ first: "the chart is unreadable", html });
  });

  it("report_kinds_template_content: an empty line 1 is an `invalid` error", () => {
    expect(() => buildReportTemplateContent({ structureHash: "  ", html })).toThrow(WolfError);
    expect(() => buildReportCandidateContent({ summary: "", html })).toThrow(/line 1/);
  });

  it("report_kinds_template_content: a row whose body is missing still parses — absence is a human's problem, not a crash", () => {
    expect(parseTemplateContent("abc123")).toEqual({ first: "abc123", html: "" });
  });
});

// ── report content: headline + a flat slot map ──────────────────────────

describe("report_kinds_report_content", () => {
  const slots = { headline: "<p>up 4%</p>", "chart-main": "<div id=\"c\"></div>" };

  it("report_kinds_report_content: line 1 splits from the JSON body and round-trips", () => {
    const content = buildReportContent({ headline: "the basket held", slots });
    expect(content.split("\n")[0]).toBe("the basket held");
    expect(parseReportContent(content)).toEqual({
      headline: "the basket held",
      headlineTruncated: false,
      slots,
    });
  });

  it("report_kinds_report_content: a headline over 400 characters is truncated ON READ and flagged", () => {
    const content = `${"z".repeat(450)}\n${JSON.stringify(slots)}`;
    const parsed = parseReportContent(content);
    expect(parsed.headline).toHaveLength(400);
    expect(parsed.headlineTruncated).toBe(true);
    expect(parsed.slots).toEqual(slots);
  });

  it("report_kinds_report_content: a nested object value is `invalid` and NAMES the offending key", () => {
    const content = 'a headline\n{"headline":"<p>ok</p>","chart-main":{"html":"<div/>"}}';
    let caught: WolfError | undefined;
    try {
      parseReportContent(content);
    } catch (err) {
      caught = err as WolfError;
    }
    expect(caught).toBeInstanceOf(WolfError);
    expect(caught?.kind).toBe("invalid");
    expect(caught?.message).toContain("chart-main");
    expect(caught?.details).toMatchObject({ key: "chart-main" });
  });

  it("report_kinds_report_content: every other non-string value is `invalid` and names its key", () => {
    const cases: Array<[string, string]> = [
      ['a\n{"n": 7}', "n"],
      ['a\n{"b": true}', "b"],
      ['a\n{"nul": null}', "nul"],
      ['a\n{"arr": ["<p/>"]}', "arr"],
    ];
    for (const [content, key] of cases) {
      expect(() => parseReportContent(content)).toThrow(WolfError);
      try {
        parseReportContent(content);
      } catch (err) {
        expect((err as WolfError).kind).toBe("invalid");
        expect((err as WolfError).details).toMatchObject({ key });
      }
    }
  });

  it("report_kinds_report_content: a non-object body — array, scalar, unparseable, empty — is `invalid`", () => {
    for (const body of ['["<p/>"]', '"just a string"', "7", "not json at all", ""]) {
      const err = (() => {
        try {
          parseReportContent(`a headline\n${body}`);
          return undefined;
        } catch (e) {
          return e as WolfError;
        }
      })();
      expect(err).toBeInstanceOf(WolfError);
      expect(err?.kind).toBe("invalid");
    }
  });

  it("report_kinds_report_content: an empty slot map is legal — a report that filled nothing is not malformed", () => {
    expect(parseReportContent("a headline\n{}")).toEqual({
      headline: "a headline",
      headlineTruncated: false,
      slots: {},
    });
  });
});
