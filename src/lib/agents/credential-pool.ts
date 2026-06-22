import { getSqlite } from "@/lib/db";
import { resolveSecretValue } from "@/lib/secrets/store";
import { logger } from "@/lib/utils/logger";

const log = logger.child("credential-pool");

interface CredentialEntry {
  id: string;
  provider: string;
  key: string;
  priority: number;
  cooldownUntil: number | null;
  failureCount: number;
  lastUsedAt: number | null;
}

const poolState = new Map<string, CredentialEntry[]>();
const cooldowns = new Map<string, number>();

export function registerCredentials(provider: string, apiKeys: Array<{ name: string; priority?: number }>) {
  const now = Date.now();
  const entries: CredentialEntry[] = apiKeys.map((k, i) => ({
    id: `${provider}:${k.name}`,
    provider,
    key: k.name,
    priority: k.priority ?? i,
    cooldownUntil: cooldowns.get(`${provider}:${k.name}`) ?? null,
    failureCount: 0,
    lastUsedAt: null,
  }));
  poolState.set(provider, entries.sort((a, b) => a.priority - b.priority));
}

export function resolveApiKey(provider: string): string | null {
  const entries = poolState.get(provider);
  if (!entries || entries.length === 0) {
    try {
      const db = getSqlite();
      const row = db.prepare(
        "SELECT api_key, api_key_secret_ref FROM models WHERE provider = ? AND is_active = 1 LIMIT 1"
      ).get(provider) as { api_key?: string; api_key_secret_ref?: string } | undefined;
      if (row?.api_key) return row.api_key;
      if (row?.api_key_secret_ref) return resolveSecretValue(row.api_key_secret_ref) ?? null;
      return null;
    } catch {
      return null;
    }
  }

  const now = Date.now();

  for (const entry of entries) {
    if (entry.cooldownUntil && entry.cooldownUntil > now) continue;
    entry.lastUsedAt = now;
    return resolveKeyFromEntry(entry);
  }

  log.warn("All keys in cooldown for provider", { provider });
  const forced = entries[0];
  forced.lastUsedAt = now;
  forced.cooldownUntil = null;
  return resolveKeyFromEntry(forced);
}

export function markRateLimited(provider: string, keyName?: string) {
  const cooldownMs = 60_000;
  const now = Date.now();

  if (keyName) {
    const key = `${provider}:${keyName}`;
    cooldowns.set(key, now + cooldownMs);

    const entries = poolState.get(provider);
    if (entries) {
      const entry = entries.find(e => e.key === keyName);
      if (entry) {
        entry.failureCount++;
        entry.cooldownUntil = now + cooldownMs;
      }
    }
  }

  log.warn("Rate limited, rotating", { provider, keyName });
}

export function getPoolStatus(provider: string): Array<{ key: string; failures: number; cooldown: boolean; lastUsed: number | null }> {
  const entries = poolState.get(provider);
  if (!entries) return [];
  const now = Date.now();
  return entries.map(e => ({
    key: e.key,
    failures: e.failureCount,
    cooldown: e.cooldownUntil !== null && e.cooldownUntil > now,
    lastUsed: e.lastUsedAt,
  }));
}

function resolveKeyFromEntry(entry: CredentialEntry): string | null {
  try {
    const db = getSqlite();
    const row = db.prepare(
      "SELECT api_key, api_key_secret_ref FROM models WHERE provider = ? AND is_active = 1 LIMIT 1"
    ).get(entry.provider) as { api_key?: string; api_key_secret_ref?: string } | undefined;

    if (row?.api_key) return row.api_key;
    if (row?.api_key_secret_ref) return resolveSecretValue(row.api_key_secret_ref) ?? null;
    return null;
  } catch {
    return null;
  }
}
