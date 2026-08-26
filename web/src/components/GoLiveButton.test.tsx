import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import GoLiveButton from "./GoLiveButton.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";
import type { SpecValidation } from "../api/types.js";

const ID = "1a2b3c4d";
const GO_LIVE = `POST /api/hypotheses/${ID}/go-live`;

function button(): HTMLButtonElement {
  return screen.getByTestId("go-live-button") as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoLiveButton", () => {
  it("is ENABLED iff spec_validation.valid is true", () => {
    stubFetchRoutes({});
    const validation: SpecValidation = { valid: true, errors: [] };
    renderWithProviders(<GoLiveButton hypothesisId={ID} specValidation={validation} />);
    expect(button()).toBeEnabled();
  });

  it("is DISABLED iff spec_validation.valid is false, and lists `path: message` for EVERY error", () => {
    stubFetchRoutes({});
    const validation: SpecValidation = {
      valid: false,
      errors: [
        { path: "conditions.0.threshold", message: "must be a number" },
        { path: "metrics.1.slug", message: "is not a label value" },
        { path: "horizon_days", message: "must be at least 1" },
      ],
    };
    renderWithProviders(<GoLiveButton hypothesisId={ID} specValidation={validation} />);

    expect(button()).toBeDisabled();
    for (const error of validation.errors) {
      expect(screen.getByText(`${error.path}: ${error.message}`)).toBeInTheDocument();
    }
    // EVERY error, not the first — a gate that shows one problem at a time
    // makes the human fix the spec three times.
    expect(screen.getAllByTestId("spec-error")).toHaveLength(3);
  });

  it("is disabled by valid:false even when the error list is EMPTY", () => {
    // The gate is `valid === false`, not `errors.length > 0`. A server that
    // said invalid without saying why must still stop the launch.
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={{ valid: false, errors: [] }} />,
    );
    expect(button()).toBeDisabled();
  });

  it("POSTs go-live with NO request body when clicked", async () => {
    const stub = stubFetchRoutes({ [GO_LIVE]: { json: { status: "live" } } });
    const onDone = vi.fn();
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={{ valid: true, errors: [] }} onDone={onDone} />,
    );
    await act(async () => {
      button().click();
    });
    expect(stub.countFor(GO_LIVE)).toBe(1);
    // The spec it locks is the newest candidate MEMORY. A body here would be a
    // second, unaudited way to set the scoreboard.
    const init = stub.mock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's refusal verbatim — W9's 422 is the backstop for a race", async () => {
    stubFetchRoutes({
      [GO_LIVE]: {
        status: 422,
        json: { kind: "invalid", message: "the spec candidate no longer validates" },
      },
    });
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={{ valid: true, errors: [] }} />,
    );
    await act(async () => {
      button().click();
    });
    expect(screen.getByTestId("severity")).toHaveTextContent(
      "the spec candidate no longer validates",
    );
  });
});

/**
 * The gate is `spec_validation.valid === false` and NOT `!valid` — an absent
 * or unset field must not read as "invalid" on the client. That distinction is
 * deliberate: the go-live gate has exactly one source, and a browser that
 * disabled the button on a payload the server had said nothing about would be
 * a SECOND gate, decided here, wearing the server's clothes.
 *
 * 🔴 These two fixtures exist because nothing guarded the choice: a
 * verification pass changed the condition to `specValidation?.valid !== true`
 * — which disables the button whenever the field is missing — and the whole
 * suite stayed green.
 */
describe("the gate is `valid === false`, never `!valid`", () => {
  it("stays ENABLED when spec_validation is present but `valid` is undefined", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={{} as unknown as SpecValidation} />,
    );
    expect(button()).toBeEnabled();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("stays ENABLED when spec_validation is absent from the payload entirely", () => {
    // What `GET /api/hypotheses/:id` would look like if the field were ever
    // dropped or renamed. Silence from the server is not a refusal, and the
    // real backstop for a race is W9's 422 on the POST.
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={undefined as unknown as SpecValidation} />,
    );
    expect(button()).toBeEnabled();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });
});

/**
 * W24's half of the same gate. **A second PROP, never a second gate** — the
 * ownership row says so, and the reason is the one W13 wrote down for the
 * spec half: a go-live decision made in two places drifts, and the drift is
 * only visible when the two disagree.
 *
 * 🔴 The rule the design pins is "**neither condition alone enables it**"
 * (UI § 6b: enabled iff `spec_validation.valid && report.has_template`), and
 * every combination below is asserted rather than the two obvious ones —
 * because a gate written as `specBlocked && templateBlocked` passes a
 * both-false and a both-true test and is wrong in exactly the two cases that
 * matter.
 */
describe("the template half of the gate (W24)", () => {
  it("is DISABLED when the spec validates but NO template has been accepted", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton
        hypothesisId={ID}
        specValidation={{ valid: true, errors: [] }}
        templateAccepted={false}
      />,
    );
    expect(button()).toBeDisabled();
    expect(screen.getByTestId("template-blocked")).toBeInTheDocument();
    // The SPEC is fine, so the spec's blocking reason must not appear — a
    // gate that says "the spec candidate does not validate" when the spec is
    // valid sends the human to fix the wrong thing.
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("is DISABLED when a template is accepted but the spec does NOT validate", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton
        hypothesisId={ID}
        specValidation={{ valid: false, errors: [{ path: "horizon_days", message: "must be at least 1" }] }}
        templateAccepted
      />,
    );
    expect(button()).toBeDisabled();
    expect(screen.getByText("horizon_days: must be at least 1")).toBeInTheDocument();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
  });

  it("is DISABLED when BOTH are refused, and lists BOTH reasons", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton
        hypothesisId={ID}
        specValidation={{ valid: false, errors: [{ path: "metrics", message: "must not be empty" }] }}
        templateAccepted={false}
      />,
    );
    expect(button()).toBeDisabled();
    expect(screen.getByText("metrics: must not be empty")).toBeInTheDocument();
    expect(screen.getByTestId("template-blocked")).toBeInTheDocument();
  });

  it("is ENABLED only when BOTH hold", () => {
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton
        hypothesisId={ID}
        specValidation={{ valid: true, errors: [] }}
        templateAccepted
      />,
    );
    expect(button()).toBeEnabled();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
  });

  it("names the report template in words, not a bare marker", () => {
    // § 2's Channel S rule reaches the blocking reasons too: a disabled
    // button with no sentence is how a human sits waiting for a launch that
    // will never enable itself.
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton
        hypothesisId={ID}
        specValidation={{ valid: true, errors: [] }}
        templateAccepted={false}
      />,
    );
    expect(screen.getByTestId("template-blocked")).toHaveTextContent(
      "No report template has been accepted yet, so this hypothesis cannot go live: review the candidate and accept it first.",
    );
  });

  it("stays ENABLED when `templateAccepted` is absent — silence is not a refusal", () => {
    // The SAME rule the spec half already holds to, and the reason it is not
    // a widening: `HypothesisDetail` renders this button without the prop
    // today, and W22's server-side 422 (path `report.has_template`) is the
    // real backstop. A client that blocked on an unstated field would be a
    // gate decided in the browser wearing the server's clothes.
    stubFetchRoutes({});
    renderWithProviders(
      <GoLiveButton hypothesisId={ID} specValidation={{ valid: true, errors: [] }} />,
    );
    expect(button()).toBeEnabled();
    expect(screen.queryByTestId("template-blocked")).toBeNull();
  });
});
