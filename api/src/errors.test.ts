import { describe, expect, it } from "vitest";
import { WolfError } from "./errors.js";

describe("WolfError", () => {
  it("distinguishes not_found from unavailable", () => {
    const missing = new WolfError("not_found", "hypothesis hyp-abc123 not found");
    const down = new WolfError("unavailable", "orange did not respond");

    expect(missing.kind).toBe("not_found");
    expect(down.kind).toBe("unavailable");
    expect(missing.kind).not.toBe(down.kind);
    // not_found is not retryable; unavailable is — status codes must not collide.
    expect(missing.status).not.toBe(down.status);
  });

  it("carries the offending variable name for misconfigured", () => {
    const err = WolfError.misconfigured("WOLF_API_KEY");

    expect(err.kind).toBe("misconfigured");
    expect(err.message).toContain("WOLF_API_KEY");
    expect(err.details).toMatchObject({ variable: "WOLF_API_KEY" });
  });

  it("supports all six kinds from the shared taxonomy", () => {
    const kinds: Array<WolfError["kind"]> = [
      "not_found",
      "unavailable",
      "invalid",
      "conflict",
      "forbidden",
      "misconfigured",
    ];

    for (const kind of kinds) {
      const err = new WolfError(kind, `${kind} happened`);
      expect(err.kind).toBe(kind);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WolfError);
      expect(typeof err.status).toBe("number");
    }
  });

  it("carries details and an upstream body when given", () => {
    const err = new WolfError("conflict", "version mismatch", {
      details: { expected: 5, actual: 6 },
      upstreamBody: '{"error":"stale version"}',
    });

    expect(err.details).toEqual({ expected: 5, actual: 6 });
    expect(err.upstreamBody).toBe('{"error":"stale version"}');
  });

  it("never leaks a credential when serialised via JSON.stringify or String()", () => {
    const err = WolfError.misconfigured("WOLF_MCP_TOKEN");

    // A WolfError must be safe to log: its own message names the *variable*,
    // never a value, so nothing here should ever contain something that looks
    // like a bearer token or an sk-/Bearer credential.
    const serialised = JSON.stringify({ message: err.message, details: err.details });
    expect(serialised).not.toMatch(/Bearer\s/i);
    expect(String(err)).not.toMatch(/Bearer\s/i);
  });
});
