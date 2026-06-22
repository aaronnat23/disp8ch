/**
 * In-memory sliding-window rate limiter.
 * Single-user local-first: no Redis needed; process-lifetime Map is sufficient.
 */

import { getSqlite } from "@/lib/db";

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

// ── Configurable rate limits ──────────────────────────────────────────────────

interface RateLimitConfig {
  webhooks: number;
  execute: number;
  channels: number;
}

let _rlCfg: RateLimitConfig | null = null;
let _rlCfgTs = 0;
const RL_CACHE_MS = 60_000; // refresh from DB at most once per minute

function trustProxyHeaders(): boolean {
  const raw = String(process.env.DISP8CH_TRUST_PROXY || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Load per-route rate limits from DB with 60s in-memory cache. Falls back to defaults. */
export function getRateLimitConfig(): RateLimitConfig {
  const now = Date.now();
  if (_rlCfg && now - _rlCfgTs < RL_CACHE_MS) return _rlCfg;
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        "SELECT rate_limit_webhooks, rate_limit_execute, rate_limit_channels FROM app_config WHERE id = 'default'"
      )
      .get() as { rate_limit_webhooks?: number; rate_limit_execute?: number; rate_limit_channels?: number } | undefined;
    _rlCfg = {
      webhooks: row?.rate_limit_webhooks ?? 30,
      execute:  row?.rate_limit_execute  ?? 20,
      channels: row?.rate_limit_channels ?? 60,
    };
  } catch {
    _rlCfg = { webhooks: 30, execute: 20, channels: 60 };
  }
  _rlCfgTs = Date.now();
  return _rlCfg;
}

/**
 * Check whether the key is within its rate limit.
 * @param key      Unique key per (IP + endpoint) pair
 * @param limit    Max allowed requests in the window
 * @param windowMs Window duration in milliseconds
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = windows.get(key) ?? { timestamps: [] };

  // Prune timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - entry.timestamps[0]));
    windows.set(key, entry);
    return { allowed: false, retryAfterMs };
  }

  entry.timestamps.push(now);
  windows.set(key, entry);
  return { allowed: true, retryAfterMs: 0 };
}

/** Extract best-effort client IP from a Next.js request header. */
export function getClientIp(request: Request): string {
  if (trustProxyHeaders()) {
    const forwarded = (request.headers as Headers).get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    const realIp = (request.headers as Headers).get("x-real-ip");
    if (realIp) return realIp.trim();
    const cfIp = (request.headers as Headers).get("cf-connecting-ip");
    if (cfIp) return cfIp.trim();
  }
  return "local";
}
