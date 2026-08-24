// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORANGE_PUBLIC_URL, googleClientId, orangePublicUrl } from "./env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("orangePublicUrl", () => {
  it("returns the built-in variable", () => {
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "https://orange.example.test");
    expect(orangePublicUrl()).toBe("https://orange.example.test");
  });

  it("trims trailing slashes so a caller concatenates a path without doubling the separator", () => {
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "https://orange.example.test///");
    expect(orangePublicUrl()).toBe("https://orange.example.test");
  });

  it("keeps a path prefix — a base like https://host/orange must survive", () => {
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "https://example.test/orange");
    expect(orangePublicUrl()).toBe("https://example.test/orange");
  });

  it("falls back to agent-orange's own compose port when the arg was not passed", () => {
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "");
    expect(orangePublicUrl()).toBe(DEFAULT_ORANGE_PUBLIC_URL);
    expect(DEFAULT_ORANGE_PUBLIC_URL).toBe("http://localhost:8080");
  });

  it("is read at CALL time, not at module load — which is what lets a test prove composition", () => {
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "https://one.example.test");
    expect(orangePublicUrl()).toBe("https://one.example.test");
    vi.stubEnv("VITE_ORANGE_PUBLIC_URL", "https://two.example.test");
    expect(orangePublicUrl()).toBe("https://two.example.test");
  });
});

describe("googleClientId", () => {
  it("is undefined when the arg was not passed — an absent client id is a state, not an error", () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    expect(googleClientId()).toBeUndefined();
  });

  it("returns the built-in value", () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "probe.apps.googleusercontent.com");
    expect(googleClientId()).toBe("probe.apps.googleusercontent.com");
  });
});
