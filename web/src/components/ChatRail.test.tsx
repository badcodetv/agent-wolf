import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import ChatRail, { RAIL_WIDTH } from "./ChatRail.js";
import { renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const TOKEN_ROUTE = `GET /api/hypotheses/${ID}/embed-token`;

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  stubFetchRoutes({
    [TOKEN_ROUTE]: {
      json: { token: "tok", expires_at_sec: Math.floor(Date.now() / 1000) + 900, embed_url: "" },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatRail", () => {
  it("fills its column's height, and its width is a clamp not a pixel constant", async () => {
    renderWithProviders(<ChatRail hypothesisId={ID} />);
    await flush();

    const rail = screen.getByTestId("chat-rail");
    expect(rail).toHaveAttribute("data-rail-mode", "rail");
    const style = window.getComputedStyle(rail);
    // 🔴 NOT sticky, and not `100vh` — changed 2026-09-07. The rail is a flex
    // child of a page that is exactly the height of the area below the app
    // bar, so `100%` is the right height and it is always on screen already,
    // which is what sticky was compensating for. `100vh` was wrong by the app
    // bar's height: the rail's last 48px is the message input, and it sat
    // below the fold; scrolling to reach it slid the sticky rail over the
    // header and clipped the rail's own heading.
    expect(style.position).not.toBe("sticky");
    // No `top` either: it was only meaningful for a sticky element.
    expect(style.top).toBe("");
    expect(style.height).toBe("100%");
    expect(style.width).toBe(RAIL_WIDTH);
    // Widened 2026-09-07 — see the constant's comment. The assertion that
    // matters is that it stays a CLAMP: a pixel constant here is what makes a
    // chat panel unusable on one screen size or another.
    expect(RAIL_WIDTH).toBe("clamp(360px, 32vw, 620px)");
    expect(RAIL_WIDTH).toMatch(/^clamp\(/);
  });

  it("collapses to a thin edge and leaves a restore control", async () => {
    renderWithProviders(<ChatRail hypothesisId={ID} />);
    await flush();
    expect(screen.getByTestId("orange-chat-frame")).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId("chat-rail-toggle").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId("chat-rail")).toHaveAttribute("data-rail-open", "false");
    expect(screen.queryByTestId("orange-chat-frame")).toBeNull();
    // Restorable: the control is still there, and still says what it does.
    const toggle = screen.getByTestId("chat-rail-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Show the conversation");

    await act(async () => {
      toggle.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("orange-chat-frame")).toBeInTheDocument();
  });
});

/**
 * The below-`md` branch — W13's rail criterion and UI design § 5: "Below the
 * `md` breakpoint the rail becomes a tab above the left column's content. It
 * **never becomes a fixed-height box in the middle of a scrolling document**."
 *
 * 🔴 This block exists because that branch was, until it was written, entirely
 * unexecuted: jsdom defines no `window.matchMedia`, so MUI's `useMediaQuery`
 * falls back to `false` and the desktop branch is the only one any test ever
 * rendered. A verification pass gave the tab's frame box `height: 800px` and
 * the whole 190-test suite stayed green — a stated acceptance criterion held
 * up by nothing but the code happening to be right.
 *
 * The stub is local to this block, and `afterEach`'s `unstubAllGlobals`
 * removes it, so the other suites keep the desktop default they were written
 * against.
 */
describe("ChatRail below the md breakpoint", () => {
  /**
   * MUI reads `window.matchMedia`. `theme.breakpoints.down("md")` compiles to
   * `@media (max-width:899.95px)`, so answering `true` to any `max-width`
   * query — and `false` to everything else — puts exactly this component into
   * its narrow branch without pretending anything else about the viewport.
   */
  function stubNarrowViewport(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("renders as a TAB, and that tab carries no fixed pixel height either", async () => {
    stubNarrowViewport();
    renderWithProviders(<ChatRail hypothesisId={ID} />);
    await flush();

    const rail = screen.getByTestId("chat-rail");
    // Proof the branch actually ran: without the stub this is "rail".
    expect(rail).toHaveAttribute("data-rail-mode", "tab");
    expect(window.getComputedStyle(rail).position).not.toBe("sticky");

    const frame = screen.getByTestId("orange-chat-frame");
    // The frame still fills its container and still measures nothing.
    expect(frame.style.height).toBe("100%");
    expect(frame.style.height).not.toMatch(/px/);

    // …and the container the tab gives it is a viewport fraction, not a pixel
    // count. A `height: 800px` here is the exact mutation this test exists to
    // catch: correct on the machine it was written on, wrong everywhere else.
    const box = frame.parentElement;
    expect(box).not.toBeNull();
    const boxHeight = window.getComputedStyle(box as HTMLElement).height;
    expect(boxHeight).not.toMatch(/px/);
    expect(boxHeight).toBe("70vh");
  });

  it("still collapses and restores as a tab", async () => {
    stubNarrowViewport();
    renderWithProviders(<ChatRail hypothesisId={ID} />);
    await flush();
    expect(screen.getByTestId("orange-chat-frame")).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId("chat-rail-toggle").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("orange-chat-frame")).toBeNull();

    await act(async () => {
      screen.getByTestId("chat-rail-toggle").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("orange-chat-frame")).toBeInTheDocument();
  });
});
