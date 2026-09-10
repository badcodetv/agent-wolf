// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOB_PUBLIC_URL, googleClientId, bobPublicUrl } from "./env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bobPublicUrl", () => {
  it("returns the built-in variable", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://bob.example.test");
    expect(bobPublicUrl()).toBe("https://bob.example.test");
  });

  it("trims trailing slashes so a caller concatenates a path without doubling the separator", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://bob.example.test///");
    expect(bobPublicUrl()).toBe("https://bob.example.test");
  });

  it("keeps a path prefix — a base like https://host/bob must survive", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://example.test/bob");
    expect(bobPublicUrl()).toBe("https://example.test/bob");
  });

  it("falls back to agent-bob's own compose port when the arg was not passed", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "");
    expect(bobPublicUrl()).toBe(DEFAULT_BOB_PUBLIC_URL);
    expect(DEFAULT_BOB_PUBLIC_URL).toBe("http://localhost:8080");
  });

  it("is read at CALL time, not at module load — which is what lets a test prove composition", () => {
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://one.example.test");
    expect(bobPublicUrl()).toBe("https://one.example.test");
    vi.stubEnv("VITE_BOB_PUBLIC_URL", "https://two.example.test");
    expect(bobPublicUrl()).toBe("https://two.example.test");
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
