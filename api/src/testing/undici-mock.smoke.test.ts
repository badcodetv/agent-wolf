import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

/**
 * Smoke test for the project's ONE approved HTTP-mocking tool
 * (design/2026-08-20-agent-wolf.md § "Pinned technology choices": undici's
 * `MockAgent` — no msw, no nock, no live network in any unit test).
 *
 * No production code calls out over HTTP yet (that starts with W2's Orange
 * client), so this just proves the pattern is wired and available for every
 * later ticket to copy: `mockAgent.disableNetConnect()` means an un-mocked
 * request throws instead of silently hitting the real network.
 */
describe("undici MockAgent", () => {
  let mockAgent: MockAgent;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  it("intercepts a mocked request instead of hitting the network", async () => {
    mockAgent
      .get("https://example.invalid")
      .intercept({ path: "/ping", method: "GET" })
      .reply(200, { pong: true });

    const res = await fetch("https://example.invalid/ping");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ pong: true });
  });

  it("refuses an un-mocked request rather than reaching the real network", async () => {
    await expect(fetch("https://example.invalid/unmocked")).rejects.toBeTruthy();
  });
});
