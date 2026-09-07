/**
 * `spec_validate` — the interviewer's feedback loop.
 *
 * The headline test is `specvalidate_the_real_failure`: it runs the spec a
 * real interview actually deposited on 2026-09-07 — recorded verbatim at
 * `__fixtures__/spec-candidate-thirteen-errors.txt` — and asserts the tool
 * reports the errors that made the Go Live button never appear.
 *
 * That interview was good. Good questions, a sharp thesis, a sensible
 * scoreboard, and a report template that validated first time. It failed on
 * the encoding step alone, because the prompt described the spec in prose
 * using the wrong field names (`statistic`/`comparison` for `stat`/`op`) and
 * the model had no way to check its work. Both ends were blind: the model
 * believed it had finished, and the user saw a screen with nothing to click.
 *
 * The second thing this file pins is the property the tool lives or dies on
 * — that it extracts and validates EXACTLY as the server does when it reads
 * the deposit back. A validator that disagreed would say "valid" for
 * something the Go Live gate rejects, which is worse than no validator.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createErrorHandler } from "../app.js";
import { createLogger } from "../logger.js";
import { validateSpec } from "../hypothesis/spec.js";
import { extractJsonObject } from "../hypothesis/speccontent.js";
import type { MarketDataConnector } from "../marketdata/stooq.js";
import { createMarketDataAccess } from "./tools.js";
import { createWolfMcp, MCP_PATH } from "./server.js";
import {
  MAX_CONTENT_BYTES,
  SPEC_VALIDATE_TOOL_NAME,
  validateSpecContent,
} from "./specvalidate.js";

const TOKEN = "wolf-mcp-token-for-tests-0123456789abcdef";
const SECRET = "test-series-secret-value-not-a-real-credential";

const fixtures = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
/** The verbatim content of memory 39e4357b, deposited by a real interview. */
const THIRTEEN_ERRORS = readFileSync(`${fixtures}spec-candidate-thirteen-errors.txt`, "utf8");
/** The worked example the prompt now shows, which must validate. */
const WORKED = readFileSync(
  fileURLToPath(new URL("../hypothesis/__fixtures__/worked-spec.json", import.meta.url)),
  "utf8",
);

function forbiddenConnector(): MarketDataConnector {
  return {
    async search() {
      throw new Error("spec_validate must not touch a market-data provider");
    },
    async fetch() {
      throw new Error("spec_validate must not touch a market-data provider");
    },
  };
}

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

async function harness(): Promise<string> {
  const { mcpRouter, seriesDownloadRouter } = createWolfMcp({
    mcpOrigin: "http://172.17.0.1:8100",
    mcpToken: TOKEN,
    seriesSecret: SECRET,
    marketdata: createMarketDataAccess({
      connectors: { fred: forbiddenConnector(), stooq: forbiddenConnector(), yahoo: forbiddenConnector() },
    }),
  });
  const app = express();
  app.use(mcpRouter);
  app.use(seriesDownloadRouter);
  app.use(createErrorHandler(createLogger({ logLevel: "silent" })));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function callTool(base: string, content: string) {
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
      params: { name: SPEC_VALIDATE_TOOL_NAME, arguments: { content } },
    }),
  });
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text);
}

describe("specvalidate_the_real_failure: the spec a real interview deposited", () => {
  it("reports it as INVALID", () => {
    const out = validateSpecContent(THIRTEEN_ERRORS);
    expect(out.valid).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("names `stat` and `op` — the fields the prompt called statistic and comparison", () => {
    // The root cause. `prompts/interviewer.md` said "a statistic, a
    // comparison"; the schema wants `stat` and `op`, and rejects unknown
    // keys at every level (V7). The model was following instructions.
    const out = validateSpecContent(THIRTEEN_ERRORS);
    const paths = out.errors.map((e) => e.path);
    expect(paths).toContain("invalidation[0].stat");
    expect(paths).toContain("invalidation[0].op");
    expect(paths).toContain("invalidation[0].statistic");
    expect(paths).toContain("invalidation[0].comparison");
    const unknown = out.errors.find((e) => e.path === "invalidation[0].statistic");
    expect(unknown!.message).toMatch(/unrecognized key/);
  });

  it("names every field the prompt never mentioned", () => {
    const paths = validateSpecContent(THIRTEEN_ERRORS).errors.map((e) => e.path);
    // `unit` on every metric, and the four condition fields the prose omitted.
    expect(paths).toContain("metrics[0].unit");
    expect(paths).toContain("metrics[1].unit");
    expect(paths).toContain("metrics[2].unit");
    expect(paths).toContain("invalidation[0].id");
    expect(paths).toContain("invalidation[0].sustained_days");
    expect(paths).toContain("invalidation[0].meaning");
    // And the array-vs-object slip on a derived metric's method.
    expect(paths).toContain("metrics[2].method.source_series");
  });

  it("names the V27 rule a reader would never guess from prose", () => {
    // Two metrics at weight 0.3 with no invalidation condition naming them.
    // This is the class of rule that makes a prompt-only approach hopeless:
    // it is a constraint BETWEEN two parts of the document.
    const msgs = validateSpecContent(THIRTEEN_ERRORS).errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes("V27"))).toBe(true);
    expect(msgs.some((m) => m.includes('metric "gold" carries weight'))).toBe(true);
  });

  it("returns EVERY error at once, not the first", () => {
    // A model fixing one error per round trip would take thirteen turns.
    expect(validateSpecContent(THIRTEEN_ERRORS).errors.length).toBeGreaterThanOrEqual(13);
  });

  it("tells the model what to do next", () => {
    const out = validateSpecContent(THIRTEEN_ERRORS);
    expect(out.note).toMatch(/validate again before depositing/);
    expect(out.note).toMatch(/13 error/);
  });
});

describe("specvalidate_agrees_with_the_server", () => {
  it("extracts and validates through the SAME functions the Go Live gate uses", () => {
    // 🔴 The property the tool lives or dies on. Asserted by running the
    // server's own two steps side by side over the same bytes: if the tool
    // ever grew its own parser or its own rule set, these would diverge and
    // "valid here" would stop meaning "valid there".
    for (const content of [THIRTEEN_ERRORS, WORKED, "summary\n{}", "not json at all"]) {
      const viaServer = extractJsonObject(content);
      const viaTool = validateSpecContent(content);
      if (viaServer === undefined) {
        expect(viaTool.unreadable).toBe(true);
        continue;
      }
      const expected = validateSpec(viaServer);
      expect(viaTool.valid).toBe(expected.valid);
      if (!expected.valid) {
        expect(viaTool.errors.map((e) => e.path).sort()).toEqual(
          expected.errors.map((e) => e.path).sort(),
        );
      }
    }
  });

  it("accepts the worked example the prompt now shows", () => {
    // If the example in the prompt did not validate, the prompt would be
    // teaching the model to fail. This is the test that keeps them honest.
    const out = validateSpecContent(WORKED);
    expect(out.errors).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it("accepts a summary line followed by JSON — the deposit shape", () => {
    const out = validateSpecContent(`Gold keeps pace with M2 over six months\n${WORKED}`);
    expect(out.valid).toBe(true);
  });

  it("accepts bare JSON too, so a model that forgets the summary still gets checked", () => {
    expect(validateSpecContent(WORKED).valid).toBe(true);
  });

  it("reports content with no JSON object as unreadable, with the deposit shape spelled out", () => {
    const out = validateSpecContent("I think gold will go up because of money printing.");
    expect(out.valid).toBe(false);
    expect(out.unreadable).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.note).toMatch(/no markdown code fences/);
  });

  it("reads a ```json fence, because that is a shape the server also reads", () => {
    // Not encouragement — the prompt forbids fences. But the server's
    // extractor accepts them, so the tool must agree or it would reject
    // something that would in fact have worked.
    const out = validateSpecContent(`summary\n\`\`\`json\n${WORKED}\n\`\`\``);
    expect(out.valid).toBe(true);
  });
});

describe("specvalidate_tool over the real MCP server", () => {
  it("is listed alongside the market-data tools", async () => {
    const base = await harness();
    const res = await fetch(`${base}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-wolf-mcp-token": TOKEN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("spec_validate");
    expect(names).toContain("series_search");
    expect(names).toContain("series_fetch");
  });

  it("answers the real broken spec with its error list, over HTTP", async () => {
    const base = await harness();
    const out = await callTool(base, THIRTEEN_ERRORS);
    expect(out.valid).toBe(false);
    expect(out.errors.map((e: { path: string }) => e.path)).toContain("invalidation[0].stat");
  });

  it("answers the worked example with valid", async () => {
    const base = await harness();
    const out = await callTool(base, WORKED);
    expect(out.valid).toBe(true);
    expect(out.note).toMatch(/Deposit this/);
  });

  it("never touches a market-data provider", async () => {
    // The connectors in `harness()` throw if called.
    const base = await harness();
    const out = await callTool(base, WORKED);
    expect(out.valid).toBe(true);
  });

  it("rejects content over the cap rather than validating a megabyte", async () => {
    const base = await harness();
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
        params: {
          name: SPEC_VALIDATE_TOOL_NAME,
          arguments: { content: "x".repeat(MAX_CONTENT_BYTES + 1) },
        },
      }),
    });
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });
});
