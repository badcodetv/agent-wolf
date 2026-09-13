import { describe, expect, it } from "vitest";

import { formatAgentContext } from "./agentcontext.js";

// Pinned against agent-bob docs/19-embedding.md § 3a and
// web/src/agentContext.ts (commit ad3fc3c). Bob's chat recognises the block
// only when the opening tag is the first characters and the block is closed.
describe("formatAgentContext", () => {
  it("builds exactly the documented shape: tag, context, closing tag, then the person's words", () => {
    expect(
      formatAgentContext(
        "Label every candidate memory kind=hypothesis-spec-candidate, name: <the hypothesis id>.",
        "Opened from the hypothesis page",
        "Is gold still a hedge against inflation?",
      ),
    ).toBe(
      '<agent-context summary="Opened from the hypothesis page">\n' +
        "Label every candidate memory kind=hypothesis-spec-candidate, name: <the hypothesis id>.\n" +
        "</agent-context>\n" +
        "Is gold still a hedge against inflation?",
    );
  });

  it("omits the summary attribute when empty, and the trailing line when there are no words", () => {
    expect(formatAgentContext("  ctx  ")).toBe("<agent-context>\nctx\n</agent-context>");
    expect(formatAgentContext("ctx", "   ", "  ")).toBe("<agent-context>\nctx\n</agent-context>");
  });

  it("encodes & and \" in the summary and folds newlines to spaces", () => {
    expect(formatAgentContext("ctx", 'A & "B"\nC')).toBe(
      '<agent-context summary="A &amp; &quot;B&quot; C">\nctx\n</agent-context>',
    );
  });

  it("trims the context and the words, as Bob's parser does", () => {
    expect(formatAgentContext("\n ctx \n", "s", "\n words \n")).toBe(
      '<agent-context summary="s">\nctx\n</agent-context>\nwords',
    );
  });
});
