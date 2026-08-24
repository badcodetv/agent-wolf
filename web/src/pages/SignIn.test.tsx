import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import SignIn from "./SignIn.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const DEV_LOGIN = "POST /api/auth/dev-login";

function type(testId: string, value: string): void {
  const input = screen.getByTestId(testId).querySelector("input");
  if (input === null) throw new Error(`no input inside ${testId}`);
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("SignIn", () => {
  it("makes NO remote request for the Google script when no client id was built in", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    stubFetchRoutes({});
    renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("no-google-client-id")).toBeInTheDocument();
    // A product that argues about remote fetches for a living does not make
    // one it cannot use.
    expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
  });

  it("loads the Google script only when a client id IS built in", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "probe.apps.googleusercontent.com");
    stubFetchRoutes({});
    renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('script[src="https://accounts.google.com/gsi/client"]')).not.toBeNull();
  });

  it("signs in through the test-stack login and reports the email back", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    const stub = stubFetchRoutes({ [DEV_LOGIN]: { json: { email: "kai@badcode.dev" } } });
    const onSignedIn = vi.fn();
    renderWithProviders(<SignIn onSignedIn={onSignedIn} />);
    type("dev-email", "kai@badcode.dev");
    type("dev-password", "hunter2");
    await act(async () => {
      screen.getByTestId("dev-submit").click();
    });
    expect(stub.countFor(DEV_LOGIN)).toBe(1);
    expect(onSignedIn).toHaveBeenCalledWith("kai@badcode.dev");
  });

  it("surfaces a 403 verbatim — the allowlist refusal is a different fact from a bad password", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    stubFetchRoutes({
      [DEV_LOGIN]: {
        status: 403,
        json: { kind: "forbidden", message: "this account is not allowed to use Agent Wolf" },
      },
    });
    renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
    type("dev-email", "nobody@example.test");
    type("dev-password", "x");
    await act(async () => {
      screen.getByTestId("dev-submit").click();
    });
    expect(screen.getByTestId("severity")).toHaveTextContent(
      "this account is not allowed to use Agent Wolf",
    );
  });

  it("reports a stack with no offline login as what it is, not as a bad password", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    // Express answers an unmounted route itself, with an HTML body — not the
    // taxonomy shape. The client must not choke on that.
    stubFetchRoutes({ [DEV_LOGIN]: { status: 404, text: "<!DOCTYPE html>Cannot POST" } });
    renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
    type("dev-email", "kai@badcode.dev");
    type("dev-password", "x");
    await act(async () => {
      screen.getByTestId("dev-submit").click();
    });
    expect(screen.getByTestId("severity")).toHaveTextContent("404");
  });
});
