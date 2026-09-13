import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import NextStep, { nextStepFor, REVIEW_AND_GO_LIVE } from "./NextStep.js";
import { renderWithProviders } from "../testUtils.js";

const ID = "1a2b3c4d";

describe("nextStepFor", () => {
  it("🔴 a draft mid-interview says the interview is working and the page will update", () => {
    // It used to say nothing (2026-09-07). On 2026-09-13 a first-time user
    // watched a long tool-call loop beside a silent page and could not tell
    // whether anything would ever happen. No link, no blocker: just progress.
    const step = nextStepFor(ID, "draft", false, false);
    expect(step?.say).toContain("The interview is shaping your hypothesis");
    expect(step?.say).toContain("updates by itself");
    expect(step?.working).toBe(true);
    expect(step?.goTo).toBeUndefined();
  });

  it("🔴 an ABSENT verdict is not a blocker either — it is the same progress line", () => {
    // `undefined` means the server did not say. Reading it as `false` would
    // invent a refusal the payload never carried — the same rule GoLiveButton
    // holds to with `=== false`. The progress line claims no refusal.
    expect(nextStepFor(ID, "draft", undefined, undefined)).toEqual(nextStepFor(ID, "draft", false, false));
  });

  it("a valid spec with no template sends the reader to the template", () => {
    const step = nextStepFor(ID, "draft", true, false);
    expect(step?.say).toContain("report template");
    expect(step?.goTo?.to).toBe(`/hypotheses/${ID}/golive`);
    // The interviewer's closing message names this label; they must match.
    expect(step?.goTo?.label).toBe(REVIEW_AND_GO_LIVE);
  });

  it("🔴 BOTH halves satisfied is the only state that says 'go live'", () => {
    // The same condition that enables GoLiveButton. If these two ever
    // disagree, one of them is lying to a human about what they can do.
    expect(nextStepFor(ID, "draft", true, true)?.say).toContain("take this hypothesis live");
    // A valid spec with no template points at the template instead.
    expect(nextStepFor(ID, "draft", true, false)?.say).toContain("report template");
    expect(nextStepFor(ID, "draft", true, false)?.say).not.toContain("take this hypothesis live");
    // An accepted template with an invalid spec is still mid-interview.
    expect(nextStepFor(ID, "draft", false, true)?.working).toBe(true);
    expect(nextStepFor(ID, "draft", false, true)?.goTo).toBeUndefined();
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
    // Prominent: a primary button, not a quiet link.
    const button = screen.getByTestId("next-step-link");
    expect(button).toHaveTextContent("Review and go live");
    expect(button).toHaveAttribute("href", `/hypotheses/${ID}/golive`);
    expect(button.className).toContain("MuiButton-contained");
    expect(screen.queryByTestId("next-step-working")).toBeNull();
  });

  it("renders the progress line with a progress bar and no button while interviewing", () => {
    renderWithProviders(
      <NextStep hypothesisId={ID} status="draft" specValidation={{ valid: false, errors: [] }} />,
    );
    expect(screen.getByTestId("next-step-say")).toHaveTextContent("The interview is shaping your hypothesis");
    expect(screen.getByTestId("next-step-working")).toBeInTheDocument();
    expect(screen.queryByTestId("next-step-link")).toBeNull();
  });

  it("renders nothing at all for a terminal hypothesis", () => {
    renderWithProviders(<NextStep hypothesisId={ID} status="archived" />);
    expect(screen.queryByTestId("next-step")).toBeNull();
  });
});
