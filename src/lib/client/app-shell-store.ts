"use client";

// Global app shell cache — one shared store for common API data.
// Prevents repeated fetches of /api/auth/me, /api/models, /api/agents, etc.
// across tab switches.

interface ShellEntry {
  data: unknown;
  ts: number;
  ttl: number;
  promise: Promise<unknown> | null;
}

const store = new Map<string, ShellEntry>();

function key(url: string): string {
  return url.startsWith("/api/") ? url : `/api/${url}`;
}

export function useShellFetch<T>(url: string, ttlMs: number): {
  data: T | null;
  loading: boolean;
  refetch: () => void;
} {
  const k = key(url);
  const entry = store.get(k);
  const now = Date.now();

  // Serve fresh cache
  if (entry && now - entry.ts < ttlMs) {
    // Background revalidate if stale (> half TTL)
    if (now - entry.ts > ttlMs / 2 && !entry.promise) {
      entry.promise = fetch(k)
        .then(r => r.json())
        .then(d => { entry.data = d; entry.ts = Date.now(); entry.promise = null; return d; })
        .catch(() => { entry.promise = null; });
    }
    // React-wise: we can't return hooks from a non-hook context directly.
    // This is a utility function, not a hook. Use getShellData() directly.
  }

  // Not a React hook — just return the cache lookup
  return {
    data: (entry?.data as T) ?? null,
    loading: !entry,
    refetch: () => { store.delete(k); },
  };
}

export function getShellData<T>(url: string): Promise<T> {
  const k = key(url);
  const entry = store.get(k);
  const now = Date.now();

  if (entry && now - entry.ts < (entry.ttl || 15000)) {
    return Promise.resolve(entry.data as T);
  }

  // Deduplicate in-flight requests
  if (entry?.promise) return entry.promise as Promise<T>;

  const promise = fetch(k)
    .then(r => r.json())
    .then(d => {
      store.set(k, { data: d, ts: Date.now(), ttl: 15000, promise: null });
      return d as T;
    })
    .catch(err => {
      store.delete(k);
      throw err;
    });

  store.set(k, { data: entry?.data ?? null, ts: entry?.ts ?? 0, ttl: 15000, promise });
  return promise as Promise<T>;
}

export function prefetchShellData(url: string, ttlMs = 15000): void {
  const k = key(url);
  const entry = store.get(k);
  const now = Date.now();
  if (entry && now - entry.ts < ttlMs) return;
  getShellData(url).catch(() => {});
}

export function invalidateShell(pattern: string | RegExp): void {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  for (const k of store.keys()) {
    if (regex.test(k)) store.delete(k);
  }
}
