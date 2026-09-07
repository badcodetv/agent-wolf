/**
 * `spec_validate` — the interviewer's feedback loop.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * On 2026-09-07 a real interview went well: good questions, a sharp thesis,
 * a sensible scoreboard, a *valid* report template. Then it deposited a
 * spec candidate with **thirteen schema errors**, and the Go Live button
 * never appeared. The user had no way to know why, and neither did the
 * model.
 *
 * The errors were not carelessness. `prompts/interviewer.md` described the
 * spec in PROSE — "each naming a metric, a statistic, a comparison and a
 * threshold" — and the real field names are `stat` and `op`. The model
 * followed the prompt exactly and produced `statistic` and `comparison`,
 * which the strict schema (V7: unknown keys are rejected at every level)
 * refused. It also omitted `unit`, `id`, `sustained_days` and `meaning`,
 * none of which the prompt mentioned, and made `method.source_series` an
 * object where an array was required.
 *
 * The prompt is fixed too, and a worked example added. But a prompt is a
 * guess about what a model will write, and this schema has 27 graded rules
 * with cross-field conditionals (`reference` is forbidden for `level` and
 * required otherwise; `ratio_metric` is present iff `stat === "ratio_to"`;
 * a metric at weight >= 0.25 must be named by a condition). **No prompt
 * makes that reliably one-shot. A check does.**
 *
 * So: the model validates, reads the error list, fixes, and re-validates
 * until clean — then deposits. The failure mode this removes is the worst
 * kind, because it was invisible from both ends: the model believed it had
 * finished, and the user saw a UI with nothing to click.
 *
 * ── The one property that matters ───────────────────────────────────────
 *
 * 🔴 **This tool must extract and validate EXACTLY as the server does when
 * it reads the deposit back.** It calls the same `extractJsonObject` (moved
 * to `hypothesis/speccontent.ts` for this reason) and the same
 * `validateSpec` the Go Live gate uses. A validator that parsed even
 * slightly differently would report "valid" for a candidate the Go Live
 * screen then rejects — moving the failure from "the model can see and fix
 * it" to "only the user can see it, and cannot act on it", which is worse
 * than no validator at all.
 *
 * It is READ-ONLY: it writes nothing, touches no memory, and reaches no
 * network. It cannot deposit the candidate on the model's behalf, and
 * deliberately so — the deposit is the untrusted, in-container act the
 * trust model is built around (§ "The trust model"), and a Wolf-authored
 * candidate would carry Wolf's own provenance. Validating is safe; writing
 * would not be.
 *
 * Nothing here reads `process.env`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSpec } from "../hypothesis/spec.js";
import { extractJsonObject } from "../hypothesis/speccontent.js";

/** The tool's name, as the model calls it: `mcp__wolf__spec_validate`. */
export const SPEC_VALIDATE_TOOL_NAME = "spec_validate";

/** Cap on the content a single call may carry. A spec is small; 200KB is generous. */
export const MAX_CONTENT_BYTES = 200_000;

export interface SpecValidateResult {
  valid: boolean;
  /** Empty iff `valid`. Each error names its JSON path. */
  errors: Array<{ path: string; message: string }>;
  /** Set when the content carried no parseable JSON object at all. */
  unreadable?: true;
  /** A short, actionable note. Always present. */
  note: string;
}

const DESCRIPTION = [
  "Check a hypothesis spec against the real schema BEFORE you deposit it as a candidate memory.",
  "",
  "Pass the EXACT content you are about to write into the memory — the one-line summary,",
  "then the spec JSON — and this reports every error at once, each naming its JSON path.",
  "It writes nothing and changes nothing; it is safe to call as many times as you need.",
  "",
  "Call it, fix what it reports, call it again, and only deposit the candidate once it says valid.",
  "A spec with errors deposits fine and then cannot be taken live, and neither you nor the user",
  "is told why — the Go Live button simply never appears.",
  "",
  "This runs the same extraction and the same validator the Go Live gate runs, so 'valid' here",
  "means 'valid there'.",
].join("\n");

/**
 * Validates spec content. Pure: no I/O, no clock, no network, no throw.
 *
 * Exported separately from the tool registration so `specvalidate.test.ts`
 * can drive it directly, and so nothing has to stand up an MCP server to
 * assert what an error list says.
 */
export function validateSpecContent(content: string): SpecValidateResult {
  const parsed = extractJsonObject(content);
  if (parsed === undefined) {
    return {
      valid: false,
      errors: [],
      unreadable: true,
      note:
        "No JSON object could be read from this content. The memory must be a one-line summary, " +
        "then the spec JSON and nothing else — no markdown code fences, no prose after it.",
    };
  }

  const result = validateSpec(parsed);
  if (result.valid) {
    return {
      valid: true,
      errors: [],
      note: "Valid. Deposit this as the hypothesis-spec-candidate memory, unchanged.",
    };
  }
  return {
    valid: false,
    errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
    note:
      `${result.errors.length} error(s). Fix every one and validate again before depositing — ` +
      "the spec is strict at every level, so an unrecognised key is an error, not an extra.",
  };
}

/** Registers `spec_validate` on an `McpServer`. */
export function registerSpecValidateTool(server: McpServer): void {
  server.registerTool(
    SPEC_VALIDATE_TOOL_NAME,
    {
      description: DESCRIPTION,
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(MAX_CONTENT_BYTES)
          .describe(
            "Exactly what you are about to put in the memory: line 1 the human summary, " +
              "everything after it the spec JSON. Passing the bare JSON works too.",
          ),
      },
    },
    async ({ content }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(validateSpecContent(content)) }],
    }),
  );
}
