import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApp, createErrorHandler } from "./app.js";
import { createLogger } from "./logger.js";

describe("createApp", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("answers GET /api/healthz with 200", async () => {
    const app = createApp(createLogger({ logLevel: "silent" }));
    const server = app.listen(0);
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  // R39 leak test: an unhandled throw must be classified `internal` (500)
  // and its message must NEVER reach the response body — it may contain a
  // stack trace or a credential. Mounted on a minimal throwaway app (rather
  // than adding a test-only route to createApp's real route table) that
  // wires up the exact same createErrorHandler the production app uses.
  it("maps an unhandled throw to kind=internal, status 500, and never echoes its message", async () => {
    const app = express();
    app.get("/api/boom", () => {
      throw new Error("secret-ish detail");
    });
    app.use(createErrorHandler(createLogger({ logLevel: "silent" })));

    const server = app.listen(0);
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/boom`);
    const bodyText = await res.text();

    expect(res.status).toBe(500);
    expect(bodyText).not.toContain("secret-ish detail");
    expect(JSON.parse(bodyText)).toEqual({ kind: "internal", message: "internal error" });
  });
});
