type ReplayEntry = {
  expiresAt: number;
};

const replayCache = new Map<string, ReplayEntry>();

function pruneReplayCache(now: number): void {
  for (const [key, entry] of replayCache.entries()) {
    if (entry.expiresAt <= now) {
      replayCache.delete(key);
    }
  }
}

export function consumeReplayNonce(scope: string, nonce: string, ttlMs: number): boolean {
  const now = Date.now();
  pruneReplayCache(now);
  const key = `${scope}:${nonce}`;
  const existing = replayCache.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  replayCache.set(key, { expiresAt: now + ttlMs });
  return true;
}

export function parseTimestampHeader(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isTimestampFresh(timestampMs: number | null, toleranceMs: number): boolean {
  if (timestampMs === null) return false;
  return Math.abs(Date.now() - timestampMs) <= toleranceMs;
}
