/**
 * Centralized server-side in-process TTL cache.
 * - Shared across all API routes in the same Node.js process.
 * - Deduplicates in-flight requests (multiple concurrent callers share one promise).
 * - Configurable per-key TTL; defaults to 5s for summary/bootstrap endpoints.
 */

interface CacheEntry<T = unknown> {
  data: T;
  ts: number;
  ttl: number;
  promise: Promise<T> | null;
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 5_000;

export function getCached<T>(
  key: string,
  factory: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const entry = store.get(key);
  const now = Date.now();

  if (entry && now - entry.ts < entry.ttl) {
    return Promise.resolve(entry.data as T);
  }

  // Deduplicate in-flight requests
  if (entry?.promise) {
    return entry.promise as Promise<T>;
  }

  const promise = factory()
    .then((data) => {
      store.set(key, { data, ts: Date.now(), ttl: ttlMs, promise: null });
      return data;
    })
    .catch((err) => {
      // Keep stale data on error if we have it
      if (entry?.data !== undefined) {
        store.set(key, { ...entry, promise: null });
        return entry.data as T;
      }
      store.delete(key);
      throw err;
    });

  store.set(key, { data: entry?.data as T, ts: entry?.ts ?? 0, ttl: ttlMs, promise });
  return promise;
}

export function invalidateApiCache(pattern: string | RegExp): void {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  for (const k of store.keys()) {
    if (regex.test(k)) store.delete(k);
  }
}

export function clearApiCache(): void {
  store.clear();
}

export const API_TTL = {
  health: 5_000,
  appShell: 3_000,
  models: 10_000,
  agents: 5_000,
  roles: 10_000,
  organizations: 5_000,
  goals: 5_000,
  channels: 3_000,
  cron: 5_000,
  memory: 5_000,
  documents: 10_000,
  bootstrap: 3_000,
} as const;
