/**
 * Reading the JSON out of a memory's content — ONE implementation.
 *
 * This lived in `routes/hypotheses.ts`, and `hypothesis/provision.ts:180`
 * already carried a comment saying it re-derived the same precedence by
 * hand. Moving it here is what lets `mcp/specvalidate.ts` — the tool the
 * interviewer calls to check a spec BEFORE depositing it — extract the JSON
 * exactly as the server will when it reads the deposit back.
 *
 * That equality is the whole point of the tool. A validator that parses
 * even slightly differently from the reader would return "valid" for a
 * candidate the Go Live screen then rejects, which is worse than having no
 * validator at all: it would move the failure from "the model can see it"
 * to "only the user can see it, and cannot act on it".
 */

/**
 * Pulls the JSON object out of a memory's content, whichever of the three
 * shapes § "Memory kinds" gives it: the whole content (`hypothesis-spec`), a
 * summary line followed by JSON (`hypothesis-spec-candidate`, `evaluation`),
 * or a fenced ```json block (a state row's evaluation snapshot). Returns
 * `undefined` when there is no parseable object — never throws.
 */
export function extractJsonObject(content: string): unknown | undefined {
  const fence = /```json\s*([\s\S]*?)```/.exec(content);
  const candidates = [fence?.[1], content];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      // Try the next shape; a spec Wolf cannot read is reported through
      // `spec_validation`, not through a 500.
    }
  }
  return undefined;
}
