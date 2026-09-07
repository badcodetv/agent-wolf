import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import NextStep, { nextStepFor } from "./NextStep.js";
import { renderWithProviders } from "../testUtils.js";

const ID = "1a2b3c4d";

describe("nextStepFor", () => {
  it("🔴 a draft mid-interview has NO next step — the conversation is already running", () => {
    // The create route seeds the interview and waits for the turn to be in
    // flight before answering, so the interviewer is replying beside this
    // banner by the time the page renders. Telling the reader to start it
    // would be noise in the one slot reserved for what actually needs doing.
    expect(nextStepFor(ID, "draft", false, false)).toBeNull();
  });

  it("🔴 an ABSENT verdict is not a blocker either — it falls to the same silence", () => {
    // `undefined` means the server did not say. Reading it as `false` would
    // invent a refusal the payload never carried — the same rule GoLiveButton
    // holds to with `=== false`.
    expect(nextStepFor(ID, "draft", undefined, undefined)).toBeNull();
  });

  it("a valid spec with no template sends the reader to the template", () => {
    const step = nextStepFor(ID, "draft", true, false);
    expect(step?.say).toContain("report template");
    expect(step?.goTo?.to).toBe(`/hypotheses/${ID}/golive`);
  });

  it("🔴 BOTH halves satisfied is the only state that says 'go live'", () => {
    // The same condition that enables GoLiveButton. If these two ever
    // disagree, one of them is lying to a human about what they can do.
    expect(nextStepFor(ID, "draft", true, true)?.say).toContain("take this hypothesis live");
    // A valid spec with no template points at the template instead.
    expect(nextStepFor(ID, "draft", true, false)?.say).toContain("report template");
    expect(nextStepFor(ID, "draft", true, false)?.say).not.toContain("take this hypothesis live");
    // An accepted template with an invalid spec is still mid-interview: the
    // conversation is on screen and running, so there is nothing to say.
    expect(nextStepFor(ID, "draft", false, true)).toBeNull();
  });

  it("live says nothing needs you; challenged asks for the verdict", () => {
    expect(nextStepFor(ID, "live", true, true)?.say).toContain("Nothing needs you");
    expect(nextStepFor(ID, "challenged", true, true)?.say).toContain("confirm or invalidate");
  });

  it("🔴 terminal states have NO next step — silence beats an invented one", () => {
    for (const status of ["confirmed", "invalidated", "archived"]) {
      expect(nextStepFor(ID, status, true, true)).toBeNull();
    }
    expect(nextStepFor(ID, null, true, true)).toBeNull();
    expect(nextStepFor(ID, undefined, true, true)).toBeNull();
  });
});

describe("NextStep", () => {
  it("renders the sentence and, when there is one, the link", () => {
    renderWithProviders(
      <NextStep
        hypothesisId={ID}
        status="draft"
        specValidation={{ valid: true, errors: [] }}
        templateAccepted={false}
      />,
    );
    expect(screen.getByTestId("next-step")).toHaveAttribute("data-status", "draft");
    expect(screen.getByTestId("next-step-say")).toHaveTextContent("report template");
    expect(screen.getByTestId("next-step-link")).toBeInTheDocument();
  });

  it("renders nothing at all for a terminal hypothesis", () => {
    renderWithProviders(<NextStep hypothesisId={ID} status="archived" />);
    expect(screen.queryByTestId("next-step")).toBeNull();
  });
});
