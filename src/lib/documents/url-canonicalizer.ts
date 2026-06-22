export function normalizeCanonicalUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.pathname = pathname;
    const search = [...parsed.searchParams.entries()]
      .filter(([key]) => !/^(utm_|fbclid$|gclid$|ref$|mc_cid$|mc_eid$)/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    parsed.search = "";
    if (search.length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of search) params.append(k, v);
      parsed.search = `?${params.toString()}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl.toLowerCase().replace(/\/+$/, "");
  }
}

export function resolveCanonicalUrl(params: {
  requestedUrl: string;
  finalUrl: string;
  canonicalTag?: string | null;
}): string {
  if (params.canonicalTag) {
    try {
      const canon = new URL(params.canonicalTag).toString();
      return normalizeCanonicalUrl(canon);
    } catch {
      // Invalid canonical tag; fall through.
    }
  }
  const resolved = normalizeCanonicalUrl(params.finalUrl || params.requestedUrl);
  return resolved;
}

export function contentHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 10000); i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `sha1:${Math.abs(hash).toString(16)}:${text.length}`;
}

export type ContentCacheEntry = {
  url: string;
  canonicalUrl: string;
  etag?: string;
  lastModified?: string;
  contentHashVal: string;
  fetchedAt: string;
};

const cache = new Map<string, ContentCacheEntry>();

export function getCachedContent(key: string): ContentCacheEntry | undefined {
  return cache.get(key);
}

export function setCachedContent(key: string, entry: ContentCacheEntry): void {
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, entry);
}

export function clearContentCache(): void {
  cache.clear();
}

export function buildCacheKey(url: string): string {
  return normalizeCanonicalUrl(url);
}

export function isCachedContentStale(entry: ContentCacheEntry, maxAgeMs: number = 3600_000): boolean {
  const fetchedAt = new Date(entry.fetchedAt).getTime();
  return Date.now() - fetchedAt > maxAgeMs;
}
