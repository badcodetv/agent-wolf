/**
 * The `agent-context` marker — Bob's documented shape for "context the
 * application sent the agent" (agent-bob `docs/19-embedding.md` § 3a).
 *
 * A first message that STARTS with this block renders in Bob's chat, the embed
 * page Wolf iframes included, as one collapsed "Context sent to the agent"
 * line, and whatever follows the closing tag as the person's own bubble:
 *
 *   <agent-context summary="Hypothesis setup for Agent Wolf">
 *   …instructions for the agent…
 *   </agent-context>
 *   The words the person actually typed.
 *
 * ⚠️ **Reimplemented, not imported.** Bob exports `formatAgentContext` from
 * `@agentkit/chat-ui/pure`, but Wolf reuses Bob's UI through the iframe only
 * and takes no dependency on its packages. This is a byte-for-byte copy of
 * that function; `agentcontext.test.ts` pins the output against the
 * documented shape, so a drift on either side shows up as a plain bubble
 * again rather than as an error.
 *
 * Display only: the model still reads every byte, and **Show** expands the
 * block for anyone in the iframe. Never put anything in it the user must not
 * see.
 */

const CLOSE = "</agent-context>";

export function formatAgentContext(context: string, summary = "", rest = ""): string {
  const attr = summary.trim() === "" ? "" : ` summary="${encodeAttr(summary.trim())}"`;
  const head = `<agent-context${attr}>\n${context.trim()}\n${CLOSE}`;
  return rest.trim() === "" ? head : `${head}\n${rest.trim()}`;
}

function encodeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
}
