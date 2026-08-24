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
