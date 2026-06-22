/**
 * Tiny client-side stale-while-revalidate cache for app shell data.
 * Reduces repeated API calls when switching between tabs.
 */

interface CacheEntry {
  data: unknown;
  timestamp: number;
  ttl: number;
  promise: Promise<unknown> | null;
}

const cache = new Map<string, CacheEntry>();

export function getCachedOrFetch(
  key: string,
  fetchFn: () => Promise<Response>,
  ttlMs: number,
): Promise<unknown> {
  const entry = cache.get(key);
  const now = Date.now();

  // Return fresh cached data immediately
  if (entry && now - entry.timestamp < ttlMs) {
    // Revalidate in background if more than half TTL old
    if (now - entry.timestamp > ttlMs / 2 && !entry.promise) {
      entry.promise = fetchFn()
        .then((r) => r.json())
        .then((data) => {
          entry.data = data;
          entry.timestamp = Date.now();
          entry.promise = null;
          return data;
        })
        .catch(() => {
          entry.promise = null;
        });
    }
    return Promise.resolve(entry.data);
  }

  // Fetch fresh data
  const promise = fetchFn()
    .then((r) => r.json())
    .then((data) => {
      cache.set(key, { data, timestamp: Date.now(), ttl: ttlMs, promise: null });
      return data;
    })
    .catch((err) => {
      // Return stale data on error if available
      if (entry?.data) return entry.data;
      throw err;
    });

  // Store promise so concurrent calls share it
  cache.set(key, { data: entry?.data ?? null, timestamp: entry?.timestamp ?? 0, ttl: ttlMs, promise });

  return promise;
}

export function cachedJson<T>(
  key: string,
  url: string,
  ttlMs: number,
  init?: RequestInit,
): Promise<T> {
  return getCachedOrFetch(key, () => fetch(url, init), ttlMs) as Promise<T>;
}

export function invalidateCache(pattern: string | RegExp): void {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  for (const key of cache.keys()) {
    if (regex.test(key)) cache.delete(key);
  }
}

export function clearCache(): void {
  cache.clear();
}

// Predefined TTLs for app data
export const APP_TTL: Record<string, number> = {
  agents: 15_000,
  workflows: 15_000,
  boards: 10_000,
  "hierarchy/organizations": 15_000,
  "hierarchy/goals": 15_000,
  models: 60_000,
  documents: 30_000,
  "execute/running": 5_000,
  telemetry: 10_000,
  config: 30_000,
  skills: 30_000,
  extensions: 30_000,
  channels: 15_000,
};
