/**
 * `report_validate` — the template twin of `spec_validate`.
 *
 * The property pinned here is the one `specvalidate.test.ts` pins for the
 * spec: the tool agrees with the review screen's own read of a candidate
 * (`parseTemplateContent` then `validateTemplate`), so "valid" to the model
 * means "acceptable" to the human.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { WolfError } from "../errors.js";
import { parseTemplateContent } from "../report/kinds.js";
import { validateTemplate } from "../report/sanitise.js";
import { createMarketDataAccess } from "./tools.js";
import { createWolfMcp, MCP_PATH } from "./server.js";
import { REPORT_VALIDATE_TOOL_NAME, validateReportContent } from "./reportvalidate.js";

const TOKEN = "wolf-mcp-token-for-tests-0123456789abcdef";
const SECRET = "test-series-secret-value-not-a-real-credential";
const MAX = 512_000;

/** The worked example `report-authoring.md` points at; validated by fixture.test.ts too. */
const EXAMPLE = readFileSync(
  fileURLToPath(new URL("../report/__fixtures__/example-template.html", import.meta.url)),
  "utf8",
);
const CANDIDATE = `A chart of BTC-USD against its invalidation line\n${EXAMPLE}`;
/** No fallback element, and a full document skeleton: two refusals at once. */
const BROKEN = "summary\n<html><body><div data-wolf-slot=\"note\"></div></body></html>";

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

describe("validateReportContent", () => {
  it("accepts the worked example as a candidate", () => {
    const out = validateReportContent(CANDIDATE, MAX);
    expect(out.errors).toEqual([]);
    expect(out.valid).toBe(true);
    expect(out.note).toMatch(/Deposit this/);
  });

  it("reports every error in a broken template at once", () => {
    const out = validateReportContent(BROKEN, MAX);
    expect(out.valid).toBe(false);
    expect(out.errors.length).toBeGreaterThanOrEqual(2);
    expect(out.errors.some((e) => e.message.includes("data-wolf-fallback"))).toBe(true);
  });

  it("says plainly when there is no template after the summary line", () => {
    const out = validateReportContent("just a summary", MAX);
    expect(out.valid).toBe(false);
    expect(out.note).toMatch(/nothing after line 1/);
  });

  it("applies the byte limit it is given", () => {
    expect(validateReportContent(CANDIDATE, 100).valid).toBe(false);
  });

  it("🔴 agrees with the review screen's own read, over the same bytes", () => {
    for (const content of [CANDIDATE, BROKEN]) {
      let expected = true;
      try {
        validateTemplate(parseTemplateContent(content).html, MAX);
      } catch (err) {
        if (!(err instanceof WolfError)) throw err;
        expected = false;
      }
      expect(validateReportContent(content, MAX).valid).toBe(expected);
    }
  });
});

describe("report_validate over the real MCP server", () => {
  it("answers a tools/call with the verdict", async () => {
    const { mcpRouter } = createWolfMcp({
      mcpOrigin: "http://172.17.0.1:8100",
      mcpToken: TOKEN,
      seriesSecret: SECRET,
      marketdata: createMarketDataAccess({ connectors: {} }),
    });
    const app = express();
    app.use(mcpRouter);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const call = async (content: string) => {
      const res = await fetch(`${base}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-wolf-mcp-token": TOKEN,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: REPORT_VALIDATE_TOOL_NAME, arguments: { content } },
        }),
      });
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      return JSON.parse(body.result.content[0]!.text);
    };

    expect((await call(CANDIDATE)).valid).toBe(true);
    expect((await call(BROKEN)).valid).toBe(false);
  });
});
