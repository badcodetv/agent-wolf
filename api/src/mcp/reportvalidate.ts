/**
 * `report_validate` — `spec_validate`'s twin, for the report template.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * On 2026-09-13 a first-time user typed "the price of Bitcoin will go up" and
 * the interview never ended. One of the reasons: the spec had a checker and
 * the report template did not. The prompt restates every rule that gets a
 * template refused, but a model reading a rule list cannot tell whether its
 * own 10KB of HTML obeys it — so it kept re-reading, re-writing and
 * re-depositing, and the user watched a tool-call loop with no finish.
 *
 * The server already had the acceptance logic: the go-live review screen's
 * `GET …/report-candidate` runs `parseTemplateContent` then `validateTemplate`
 * over the candidate and shows the human `valid` + `errors`. This tool runs
 * exactly those two steps, so the model sees the verdict the human will see,
 * and can stop as soon as it says valid.
 *
 * ── The one property that matters ───────────────────────────────────────
 *
 * 🔴 **Same extraction, same validator, same byte limit as the review
 * screen.** A checker that said "valid" for something the screen then refused
 * moves the failure to the one person who cannot fix it. `reportvalidate.test.ts`
 * asserts the agreement side by side.
 *
 * It is READ-ONLY, for the reason `specvalidate.ts` gives: validating is safe,
 * writing the candidate from Wolf would stamp Wolf's own provenance on an
 * untrusted proposal.
 *
 * What it cannot check: that the template's script really REMOVES the
 * fallback element after drawing. That is runtime behaviour; the parser can
 * only see the element exists. The note says so.
 *
 * Nothing here reads `process.env`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WolfError } from "../errors.js";
import { DEFAULT_WOLF_REPORT_MAX_BYTES } from "../config.js";
import { parseTemplateContent } from "../report/kinds.js";
import { validateTemplate } from "../report/sanitise.js";
import type { TemplateError } from "../report/template.js";

/** The tool's name, as the model calls it: `mcp__wolf__report_validate`. */
export const REPORT_VALIDATE_TOOL_NAME = "report_validate";

/** Cap on one call's content. Generous against the default 512KB template limit. */
export const MAX_REPORT_CONTENT_BYTES = 1_100_000;

export interface ReportValidateResult {
  valid: boolean;
  /** Empty iff `valid`. Each error names a locator (`"script[src]"`, `"[data-wolf-slot]"`, …). */
  errors: Array<{ path: string; message: string }>;
  /** A short, actionable note. Always present. */
  note: string;
}

const DESCRIPTION = [
  "Check a report template candidate BEFORE you deposit it as a report-candidate memory.",
  "",
  "Pass the EXACT content you are about to write — the one-line summary, then the HTML fragment —",
  "and this reports every error at once. It writes nothing and changes nothing.",
  "",
  "It runs the same checks the go-live review screen runs, so 'valid' here means the human",
  "reviewing it can accept it. Once it says valid, deposit it unchanged and move on —",
  "do not keep polishing a template that already validates.",
].join("\n");

/**
 * Validates report-candidate content. Pure apart from hashing: no network, no
 * clock, no throw.
 */
export function validateReportContent(
  content: string,
  maxBytes: number = DEFAULT_WOLF_REPORT_MAX_BYTES,
): ReportValidateResult {
  const { html } = parseTemplateContent(content);
  if (html.trim() === "") {
    return {
      valid: false,
      errors: [{ path: "content", message: "no template after line 1" }],
      note:
        "Line 1 is the summary and everything after it is the template. This content has nothing " +
        "after line 1 — put the HTML fragment on line 2 onward, with no markdown code fences.",
    };
  }
  try {
    validateTemplate(html, maxBytes);
  } catch (err) {
    if (!(err instanceof WolfError) || err.kind !== "invalid") throw err;
    const errors = errorsOf(err);
    return {
      valid: false,
      errors,
      note:
        `${errors.length} error(s). Fix every one in a single revision and validate again. ` +
        "Change only what an error names.",
    };
  }
  return {
    valid: true,
    errors: [],
    note:
      "Valid. Deposit this as the report-candidate memory, unchanged (embed: false). " +
      "One thing this cannot check: your script must remove the data-wolf-fallback element " +
      "after the chart draws.",
  };
}

function errorsOf(err: WolfError): Array<{ path: string; message: string }> {
  const details = err.details;
  const raw =
    typeof details === "object" && details !== null ? (details as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(raw)) return [{ path: "template", message: err.message }];
  return (raw as TemplateError[]).map((e) => ({ path: e.path, message: e.message }));
}

/** Registers `report_validate` on an `McpServer`. */
export function registerReportValidateTool(server: McpServer, maxBytes?: number): void {
  server.registerTool(
    REPORT_VALIDATE_TOOL_NAME,
    {
      description: DESCRIPTION,
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(MAX_REPORT_CONTENT_BYTES)
          .describe(
            "Exactly what you are about to put in the memory: line 1 the summary, " +
              "everything after it the HTML fragment.",
          ),
      },
    },
    async ({ content }) => ({
      content: [
        { type: "text" as const, text: JSON.stringify(validateReportContent(content, maxBytes)) },
      ],
    }),
  );
}
