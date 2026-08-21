/**
 * A small TTL cache for market-data connector results, keyed by
 * `(source, id, from, to)`.
 *
 * design/2026-08-20-agent-wolf.md § W6 acceptance criteria: "the cache
 * honours a TTL (default 3600s, overridable per instance and, once an
 * owning ticket adds it, by WOLF_MARKETDATA_CACHE_TTL[_SECONDS] — see
 * Notes), is keyed by (source, id, from, to), and is bypassable per call.
 * Expiry is tested with an injected clock, not a real timer."
 *
 * Nothing here reads `process.env` (W6 acceptance criterion): `createCache`
 * takes explicit `{ ttlMs, now }` options, per the ticket's own literal
 * factory signature. The env var that will eventually configure the
 * default (see Notes on the naming correction) carries whole SECONDS per
 * the house `_SECONDS` rule; converting seconds → `ttlMs` is the
 * responsibility of whichever ticket wires it (W1/W16/W21 own config.ts).
 */

/** The default TTL: 3600 seconds, expressed in milliseconds because this
 * module's own clock (`now()`) is millisecond-based (`Date.now()` by
 * default). */
export const DEFAULT_TTL_MS = 3_600_000;

export interface MarketDataCacheKey {
  source: string;
  id: string;
  from?: string;
  to?: string;
}

export interface CreateCacheOptions {
  /** Time-to-live in milliseconds. Defaults to `DEFAULT_TTL_MS` (3600s). */
  ttlMs?: number;
  /** Injectable clock returning the current time in epoch milliseconds.
   * Defaults to `Date.now`. Tests inject a fake clock instead of using a
   * real timer, per the ticket. */
  now?: () => number;
}

export interface GetOrComputeOptions {
  /** Skip both the cache read AND the freshness check for this call, and
   * always recompute — but still store the fresh result under the same
   * key, so the NEXT call (without bypass) is warm again. */
  bypass?: boolean;
}

export interface MarketDataCache<T> {
  /** Returns the cached value if present and not expired, else `undefined`. */
  get(key: MarketDataCacheKey): T | undefined;
  /** Stores `value` under `key`, timestamped with the cache's clock. */
  set(key: MarketDataCacheKey, value: T): void;
  /** Reads the cache; on a miss (or `bypass: true`), calls `compute()`,
   * stores the result, and returns it. */
  getOrCompute(
    key: MarketDataCacheKey,
    compute: () => Promise<T>,
    options?: GetOrComputeOptions,
  ): Promise<T>;
}

function cacheKeyString(key: MarketDataCacheKey): string {
  return JSON.stringify([key.source, key.id, key.from ?? null, key.to ?? null]);
}

interface CacheEntry<T> {
  value: T;
  storedAtMs: number;
}

export function createCache<T>(options: CreateCacheOptions = {}): MarketDataCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const store = new Map<string, CacheEntry<T>>();

  function get(key: MarketDataCacheKey): T | undefined {
    const entry = store.get(cacheKeyString(key));
    if (!entry) return undefined;
    if (now() - entry.storedAtMs >= ttlMs) {
      return undefined;
    }
    return entry.value;
  }

  function set(key: MarketDataCacheKey, value: T): void {
    store.set(cacheKeyString(key), { value, storedAtMs: now() });
  }

  async function getOrCompute(
    key: MarketDataCacheKey,
    compute: () => Promise<T>,
    computeOptions: GetOrComputeOptions = {},
  ): Promise<T> {
    if (!computeOptions.bypass) {
      const cached = get(key);
      if (cached !== undefined) return cached;
    }
    const value = await compute();
    set(key, value);
    return value;
  }

  return { get, set, getOrCompute };
}
