import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { lightTheme } from "../theme.js";
import type { Tamper } from "../api/types.js";
import TamperWarning, { tamperSentence } from "./TamperWarning.js";

/** The pinned shape: all four fields present, the unused provenance field `""`. */
function tamper(over: Partial<Tamper> = {}): Tamper {
  return {
    reason: "forged_row",
    written_by_worker: "researcher-9c1b",
    written_by_session: "",
    memory_id: "mem_7f3a",
    ...over,
  };
}

function renderWarning(t: Tamper) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <TamperWarning tamper={t} />
    </ThemeProvider>,
  );
}

describe("TamperWarning", () => {
  it("is the shared `attacked` severity, not a second treatment of its own", () => {
    renderWarning(tamper());
    const el = screen.getByTestId("severity");
    // `data-severity="attacked"` is `Severity`'s own attribute (W28). If this
    // component ever grew its own alert, this assertion is what catches it.
    expect(el).toHaveAttribute("data-severity", "attacked");
    // A full-width MUI Alert severity="error" — a subtle icon fails the criterion.
    expect(el).toHaveAttribute("role", "alert");
  });

  it.each([
    ["forged_row" as const, /forged row/i],
    ["hostile_retraction" as const, /hostile retraction/i],
    ["cross_hypothesis_write" as const, /cross-hypothesis write/i],
  ])("distinguishes %s IN WORDS, naming the writer and the memory id", (reason, phrase) => {
    renderWarning(tamper({ reason }));
    const el = screen.getByTestId("severity");
    expect(el).toHaveTextContent(phrase);
    expect(el).toHaveTextContent("researcher-9c1b");
    expect(el).toHaveTextContent("mem_7f3a");
  });

  it("gives the three reasons three DIFFERENT sentences", () => {
    const sentences = (["forged_row", "hostile_retraction", "cross_hypothesis_write"] as const).map(
      (reason) => tamperSentence(tamper({ reason })),
    );
    expect(new Set(sentences).size).toBe(3);
    // Each says what happened, not merely that something did.
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(30);
  });

  it("names the SESSION when there is no worker (the unused provenance field is \"\")", () => {
    renderWarning(tamper({ written_by_worker: "", written_by_session: "sess_18ab" }));
    expect(screen.getByTestId("severity")).toHaveTextContent("sess_18ab");
  });

  it("still says who and which memory when BOTH provenance fields are empty", () => {
    renderWarning(tamper({ written_by_worker: "", written_by_session: "" }));
    const el = screen.getByTestId("severity");
    expect(el).toHaveTextContent(/unknown writer/i);
    expect(el).toHaveTextContent("mem_7f3a");
  });

  it("renders an unrecognised reason verbatim rather than dropping the alert", () => {
    // A tamper kind Wolf does not know about is the LAST thing to hide.
    renderWarning(tamper({ reason: "quantum_forgery" as Tamper["reason"] }));
    const el = screen.getByTestId("severity");
    expect(el).toHaveTextContent("quantum_forgery");
    expect(el).toHaveTextContent("mem_7f3a");
  });
});
