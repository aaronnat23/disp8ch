"use client";

/**
 * Read bootstrap data that was injected by the server `page.tsx` as a JSON
 * <script> tag with id `__disp8ch_bootstrap_<marker>__`. Returns null if the
 * page wasn't preloaded server-side (e.g. fast-refresh, soft-nav, dev rebuild).
 *
 * Consume on first effect of the client page; if non-null, skip the
 * `/api/<marker>/bootstrap` fetch entirely.
 */
export function readPreloadedBootstrap<T = unknown>(marker: string): T | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(`__disp8ch_bootstrap_${marker}__`);
  if (!el || !el.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}
