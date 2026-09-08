/**
 * Sign-in.
 *
 * 🔴 **The dev-login form was commented out of the page on 2026-09-08** (owner
 * decision: Google is the only door a human is offered). The three tests that
 * drove that form are commented out with it, tagged `DEV-LOGIN-UI` exactly as
 * the page is — uncomment the page's regions and these together, or neither.
 *
 * In their place is `google_is_the_only_door`, which asserts the page offers no
 * password field. That is not decoration: revert either commented region in
 * `SignIn.tsx` and it goes red. The dev-login *capability* is still covered,
 * by `api/src/routes/auth.test.ts` (the route) and `web/src/api/client.test.ts`
 * (the client call) — this file only ever tested the UI affordance.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
// DEV-LOGIN-UI: import { fireEvent } from "@testing-library/dom";
import SignIn from "./SignIn.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

// DEV-LOGIN-UI ───────────────────────────────────────────────────────────
// const DEV_LOGIN = "POST /api/auth/dev-login";
//
// function type(testId: string, value: string): void {
//   const input = screen.getByTestId(testId).querySelector("input");
//   if (input === null) throw new Error(`no input inside ${testId}`);
//   fireEvent.change(input, { target: { value } });
// }
// ─────────────────────────────────────────────────────────────────────────

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

  // DEV-LOGIN-UI ───────────────────────────────────────────────────────
  // it("signs in through the test-stack login and reports the email back", async () => {
  //   vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
  //   const stub = stubFetchRoutes({ [DEV_LOGIN]: { json: { email: "kai@badcode.dev" } } });
  //   const onSignedIn = vi.fn();
  //   renderWithProviders(<SignIn onSignedIn={onSignedIn} />);
  //   type("dev-email", "kai@badcode.dev");
  //   type("dev-password", "hunter2");
  //   await act(async () => {
  //     screen.getByTestId("dev-submit").click();
  //   });
  //   expect(stub.countFor(DEV_LOGIN)).toBe(1);
  //   expect(onSignedIn).toHaveBeenCalledWith("kai@badcode.dev");
  // });
  // ─────────────────────────────────────────────────────────────────────

  // DEV-LOGIN-UI ───────────────────────────────────────────────────────
  // it("surfaces a 403 verbatim — the allowlist refusal is a different fact from a bad password", async () => {
  //   vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
  //   stubFetchRoutes({
  //     [DEV_LOGIN]: {
  //       status: 403,
  //       json: { kind: "forbidden", message: "this account is not allowed to use Agent Wolf" },
  //     },
  //   });
  //   renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
  //   type("dev-email", "nobody@example.test");
  //   type("dev-password", "x");
  //   await act(async () => {
  //     screen.getByTestId("dev-submit").click();
  //   });
  //   expect(screen.getByTestId("severity")).toHaveTextContent(
  //     "this account is not allowed to use Agent Wolf",
  //   );
  // });
  // ─────────────────────────────────────────────────────────────────────

  // DEV-LOGIN-UI ───────────────────────────────────────────────────────
  // it("reports a stack with no offline login as what it is, not as a bad password", async () => {
  //   vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
  //   // Express answers an unmounted route itself, with an HTML body — not the
  //   // taxonomy shape. The client must not choke on that.
  //   stubFetchRoutes({ [DEV_LOGIN]: { status: 404, text: "<!DOCTYPE html>Cannot POST" } });
  //   renderWithProviders(<SignIn onSignedIn={vi.fn()} />);
  //   type("dev-email", "kai@badcode.dev");
  //   type("dev-password", "x");
  //   await act(async () => {
  //     screen.getByTestId("dev-submit").click();
  //   });
  //   expect(screen.getByTestId("severity")).toHaveTextContent("404");
  // });
  // ─────────────────────────────────────────────────────────────────────

  it("google_is_the_only_door: offers no password field for a human to type into", () => {
    // The check that the hide actually holds. Uncomment either DEV-LOGIN-UI
    // region in `SignIn.tsx` and this reddens — which is the whole point of
    // writing it, rather than trusting that a comment stays commented.
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "probe.apps.googleusercontent.com");
    stubFetchRoutes({});
    const { container } = renderWithProviders(<SignIn onSignedIn={vi.fn()} />);

    expect(screen.getByTestId("sign-in")).toBeInTheDocument();
    expect(screen.queryByTestId("dev-email")).toBeNull();
    expect(screen.queryByTestId("dev-password")).toBeNull();
    expect(screen.queryByTestId("dev-submit")).toBeNull();

    // Not just those handles — no password input and no form at all, so a
    // differently-named revival is caught too.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("form")).toBeNull();

    // And the page no longer advertises that an offline bypass exists.
    expect(container.textContent).not.toMatch(/WOLF_TEST_LOGIN/);
  });
});
