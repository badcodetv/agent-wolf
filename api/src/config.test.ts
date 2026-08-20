import { describe, expect, it } from "vitest";
import { WolfError } from "./errors.js";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns defaults on an empty env", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8100);
    expect(config.logLevel).toBe("info");
    expect(config.nodeEnv).toBe("development");
  });

  it("reads WOLF_API_PORT, LOG_LEVEL and NODE_ENV when set", () => {
    const config = loadConfig({ WOLF_API_PORT: "9100", LOG_LEVEL: "debug", NODE_ENV: "test" });
    expect(config).toEqual({ port: 9100, logLevel: "debug", nodeEnv: "test" });
  });

  it("fails fast naming WOLF_API_PORT when it is not a valid port", () => {
    expect(() => loadConfig({ WOLF_API_PORT: "not-a-number" })).toThrow(WolfError);
    try {
      loadConfig({ WOLF_API_PORT: "not-a-number" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("WOLF_API_PORT");
    }
  });

  it("fails fast naming LOG_LEVEL when it is not a known level", () => {
    try {
      loadConfig({ LOG_LEVEL: "very-loud" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WolfError);
      expect((err as WolfError).kind).toBe("misconfigured");
      expect((err as WolfError).message).toContain("LOG_LEVEL");
    }
  });
});
