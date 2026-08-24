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
  it("is a sticky, full-viewport-height rail whose width is a clamp, not a pixel constant", async () => {
    renderWithProviders(<ChatRail hypothesisId={ID} />);
    await flush();

    const rail = screen.getByTestId("chat-rail");
    expect(rail).toHaveAttribute("data-rail-mode", "rail");
    const style = window.getComputedStyle(rail);
    expect(style.position).toBe("sticky");
    expect(style.top).toBe("0px");
    expect(style.height).toBe("100vh");
    expect(style.width).toBe(RAIL_WIDTH);
    expect(RAIL_WIDTH).toBe("clamp(340px, 28vw, 460px)");
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
