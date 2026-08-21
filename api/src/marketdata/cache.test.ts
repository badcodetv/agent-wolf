import { describe, expect, it, vi } from "vitest";
import { createCache, DEFAULT_TTL_MS } from "./cache.js";

describe("marketdata_cache", () => {
  it("returns a cached value before expiry", () => {
    let clock = 1_000_000;
    const cache = createCache<string>({ ttlMs: 60_000, now: () => clock });

    cache.set({ source: "fred", id: "DGS10" }, "hello");
    clock += 59_000; // still inside the 60s TTL

    expect(cache.get({ source: "fred", id: "DGS10" })).toBe("hello");
  });

  it("expires a value once the TTL has elapsed, using an injected clock — no real timer", () => {
    let clock = 1_000_000;
    const cache = createCache<string>({ ttlMs: 60_000, now: () => clock });

    cache.set({ source: "fred", id: "DGS10" }, "hello");
    clock += 60_000; // exactly at the boundary — TTL has elapsed

    expect(cache.get({ source: "fred", id: "DGS10" })).toBeUndefined();
  });

  it("is keyed by the full (source, id, from, to) tuple — distinct keys never collide", () => {
    let clock = 0;
    const cache = createCache<string>({ ttlMs: 60_000, now: () => clock });

    cache.set({ source: "fred", id: "DGS10", from: "2026-01-01", to: "2026-02-01" }, "a");
    cache.set({ source: "fred", id: "DGS10", from: "2026-01-01", to: "2026-03-01" }, "b");
    cache.set({ source: "stooq", id: "DGS10", from: "2026-01-01", to: "2026-02-01" }, "c");
    cache.set({ source: "fred", id: "SP500", from: "2026-01-01", to: "2026-02-01" }, "d");

    expect(cache.get({ source: "fred", id: "DGS10", from: "2026-01-01", to: "2026-02-01" })).toBe("a");
    expect(cache.get({ source: "fred", id: "DGS10", from: "2026-01-01", to: "2026-03-01" })).toBe("b");
    expect(cache.get({ source: "stooq", id: "DGS10", from: "2026-01-01", to: "2026-02-01" })).toBe("c");
    expect(cache.get({ source: "fred", id: "SP500", from: "2026-01-01", to: "2026-02-01" })).toBe("d");
  });

  it("treats an omitted from/to consistently, distinct from an explicit value", () => {
    let clock = 0;
    const cache = createCache<string>({ ttlMs: 60_000, now: () => clock });

    cache.set({ source: "stooq", id: "spy.us" }, "whole-history");
    cache.set({ source: "stooq", id: "spy.us", from: "2026-01-01" }, "since-jan");

    expect(cache.get({ source: "stooq", id: "spy.us" })).toBe("whole-history");
    expect(cache.get({ source: "stooq", id: "spy.us", from: "2026-01-01" })).toBe("since-jan");
  });

  it("defaults ttlMs to 3600 seconds when not given", () => {
    expect(DEFAULT_TTL_MS).toBe(3_600_000);

    let clock = 0;
    const cache = createCache<string>({ now: () => clock });
    cache.set({ source: "fred", id: "DGS10" }, "hello");

    clock = DEFAULT_TTL_MS - 1;
    expect(cache.get({ source: "fred", id: "DGS10" })).toBe("hello");

    clock = DEFAULT_TTL_MS;
    expect(cache.get({ source: "fred", id: "DGS10" })).toBeUndefined();
  });

  describe("getOrCompute", () => {
    it("computes once on a miss, then serves the cached value without recomputing", async () => {
      let clock = 0;
      const cache = createCache<number>({ ttlMs: 60_000, now: () => clock });
      const compute = vi.fn(async () => 42);

      const first = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);
      const second = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);

      expect(first).toBe(42);
      expect(second).toBe(42);
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it("recomputes after expiry", async () => {
      let clock = 0;
      const cache = createCache<number>({ ttlMs: 60_000, now: () => clock });
      const compute = vi.fn(async () => clock);

      await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);
      clock = 60_000;
      const second = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);

      expect(second).toBe(60_000);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("bypass forces a recompute even when a fresh cached value exists, and refreshes the cache", async () => {
      let clock = 0;
      const cache = createCache<number>({ ttlMs: 60_000, now: () => clock });
      let calls = 0;
      const compute = vi.fn(async () => {
        calls += 1;
        return calls;
      });

      const first = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);
      expect(first).toBe(1);

      const bypassed = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute, { bypass: true });
      expect(bypassed).toBe(2);
      expect(compute).toHaveBeenCalledTimes(2);

      // the bypassed result is now the cached value for subsequent (non-bypass) calls
      const third = await cache.getOrCompute({ source: "fred", id: "DGS10" }, compute);
      expect(third).toBe(2);
      expect(compute).toHaveBeenCalledTimes(2);
    });
  });
});
