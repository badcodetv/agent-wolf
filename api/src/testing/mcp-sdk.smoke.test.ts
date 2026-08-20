import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Smoke test proving `@modelcontextprotocol/sdk` (the pinned MCP server
 * implementation — design/2026-08-20-agent-wolf.md § "Pinned technology
 * choices": "HTTP transport. Do not hand-roll JSON-RPC") is installed and
 * its import path resolves and typechecks against this workspace's
 * `moduleResolution`.
 *
 * The real server — `series_search` / `series_fetch` over the streamable
 * HTTP transport — is W7's `api/src/mcp/server.ts`; this file does not
 * pre-empt it, it only proves the dependency itself is wired.
 */
describe("@modelcontextprotocol/sdk", () => {
  it("constructs an McpServer", () => {
    const server = new McpServer({ name: "wolf-scaffold-check", version: "0.0.0" });
    expect(server).toBeInstanceOf(McpServer);
  });
});
