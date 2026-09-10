import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import BobChatFrame, {
  MIN_REFRESH_DELAY_MS,
  REFRESH_MARGIN_MS,
  embedSrc,
} from "./BobChatFrame.js";
import { expectNothingPersisted, renderWithProviders, stubFetchRoutes } from "../testUtils.js";

const ID = "1a2b3c4d";
const TOKEN_ROUTE = `GET /api/hypotheses/${ID}/embed-token`;

/** A REAL 10-digit unix-seconds value, not an invented small number. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Lets the mount effect's promise settle without advancing any real interval. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function frame(): HTMLIFrameElement {
  return screen.getByTestId("bob-chat-frame") as HTMLIFrameElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  // A fixed, plausible wall clock: `expires_at_sec` values below are then real
  // 10-digit unix seconds, which is the whole point of the unit assertions.
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("the refresh margin", () => {
  it("is 120 000 MILLISECONDS — the constant every boundary below is written against", () => {
    // W13: "re-mints and remounts when `expires_at_sec * 1000 - Date.now() <=
    // 120_000`". Asserted as a literal so that changing the constant fails
    // here, loudly, rather than quietly sliding every boundary test with it.
    expect(REFRESH_MARGIN_MS).toBe(120_000);
    expect(MIN_REFRESH_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("embedSrc", () => {
  it("composes the src from VITE_BOB_PUBLIC_URL — a hard-coded origin fails this", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://orange.example.test");
    expect(embedSrc(ID, "tok-abc")).toBe(
      "https://orange.example.test/embed/session/hyp-1a2b3c4d#token=tok-abc",
    );
  });

  it("adds the hyp- prefix exactly once and never to the id itself", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://orange.example.test");
    const src = embedSrc(ID, "tok-abc");
    expect(src).toContain("/embed/session/hyp-1a2b3c4d#");
    expect(src).not.toContain("hyp-hyp-");
  });

  it("survives a base carrying a path prefix and a trailing slash", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://example.test/orange/");
    expect(embedSrc(ID, "t")).toBe("https://example.test/orange/embed/session/hyp-1a2b3c4d#token=t");
  });

  it("puts the token in the FRAGMENT, which is never sent to a server or written to an access log", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://orange.example.test");
    const src = embedSrc(ID, "tok-abc");
    expect(src.split("#")[1]).toBe("token=tok-abc");
    expect(src.split("#")[0]).not.toContain("tok-abc");
  });
});

describe("BobChatFrame", () => {
  it("mints a token on mount and renders it in the frame src", async () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://orange.example.test");
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: {
        json: { token: "tok-1", expires_at_sec: nowSec() + 900, embed_url: "ignored" },
      },
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();

    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);
    expect(frame().getAttribute("src")).toBe(
      "https://orange.example.test/embed/session/hyp-1a2b3c4d#token=tok-1",
    );
  });

  // ── The unit boundary. `expires_at_sec` is unix SECONDS. ───────────────
  //
  // Both sides are pinned, because either mistake is invisible to a test that
  // only checks one: treating the value as milliseconds gives a token that
  // never refreshes (the deadline is ~55 000 years out), and treating
  // 120_000 as seconds gives one that refreshes instantly.

  it("does NOT refresh while more than 120s remain — pinned 1ms OUTSIDE the boundary", async () => {
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 600, embed_url: "" },
      }),
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);

    // 600s of life, refresh at T-120s ⇒ 480 000ms. One millisecond short.
    // The number is written OUT, not derived from REFRESH_MARGIN_MS: a test
    // that computes its boundary from the constant it is testing moves with
    // the bug and proves nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(479_999);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);
  });

  it("refreshes AND remounts the frame the moment 120s remain — pinned 1ms inside", async () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://orange.example.test");
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 600, embed_url: "" },
      }),
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    const first = frame();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(480_001);
    });

    expect(stub.countFor(TOKEN_ROUTE)).toBe(2);
    const second = frame();
    expect(second.getAttribute("src")).toContain("#token=tok-2");
    // REMOUNTED, not merely re-`src`ed: a cross-origin frame given a new src
    // keeps its old document until it navigates, and the embed page reads its
    // token from the fragment ONCE, at load.
    expect(second).not.toBe(first);
  });

  it("refreshes almost immediately when the minted token is ALREADY inside the window", async () => {
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        // 60s of life — already past the T-120s trigger at the moment it arrives.
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 60, embed_url: "" },
      }),
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);

    // Clamped, never zero: a server handing out already-expiring tokens must
    // not turn this component into an unthrottled request loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_DELAY_MS - 1);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(2);
  });

  it("would refresh instantly if the unit were confused — this fixture proves it does not", async () => {
    // `expires_at_sec` read as MILLISECONDS would be ~1789 seconds after the
    // epoch, i.e. long expired, and the component would mint on every tick.
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 3600, embed_url: "" },
      }),
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    // A 10-digit fixture, as the ticket requires.
    expect(String(nowSec() + 3600)).toMatch(/^\d{10}$/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);
  });

  it("keeps the token in component state ONLY — nothing in localStorage or sessionStorage across mount, refresh and unmount", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 600, embed_url: "" },
      }),
    });
    const view = renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    expectNothingPersisted();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(480_001);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(2);
    expectNothingPersisted();

    view.unmount();
    expectNothingPersisted();
    expect(setLocal).not.toHaveBeenCalled();
    setLocal.mockRestore();
  });

  it("stops refreshing once unmounted", async () => {
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: (i) => ({
        json: { token: `tok-${i + 1}`, expires_at_sec: nowSec() + 600, embed_url: "" },
      }),
    });
    const view = renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 600_000);
    });
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);
  });

  // ── The rail contract (§ 5 "The rail") ────────────────────────────────

  it("carries NO fixed pixel height — the rail owns the height, the frame fills it", async () => {
    const stub = stubFetchRoutes({
      [TOKEN_ROUTE]: { json: { token: "t", expires_at_sec: nowSec() + 600, embed_url: "" } },
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();
    expect(stub.countFor(TOKEN_ROUTE)).toBe(1);

    const el = frame();
    expect(el.style.height).toBe("100%");
    // A cross-origin frame cannot be measured, which is exactly why a pixel
    // height here would be a guess that is wrong at every other viewport.
    expect(el.getAttribute("height")).toBeNull();
    expect(el.style.height).not.toMatch(/px/);
    expect(el.style.minHeight ?? "").not.toMatch(/px/);
  });

  it("surfaces a mint failure as the shared degraded severity, with the server's own sentence", async () => {
    stubFetchRoutes({
      [TOKEN_ROUTE]: { status: 404, json: { kind: "not_found", message: "no session for 1a2b3c4d" } },
    });
    renderWithProviders(<BobChatFrame hypothesisId={ID} />);
    await flush();

    const severity = screen.getByTestId("severity");
    expect(severity).toHaveAttribute("data-severity", "degraded");
    expect(severity).toHaveTextContent("no session for 1a2b3c4d");
    expect(screen.queryByTestId("bob-chat-frame")).toBeNull();
  });
});
