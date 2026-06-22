import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { getProviderAuthConfig, getProviderRequiredHeaders } from "@/lib/agents/provider-auth-registry";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveProviderEnvApiKey } from "@/lib/agents/provider-auth";
import { resolveSecretValue, upsertSecret } from "@/lib/secrets/store";

export type ProviderOAuthTokenInput = {
  provider: string;
  accountLabel?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  baseUrl?: string | null;
  scopes?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

export type ProviderOAuthTokenMeta = {
  provider: string;
  accountLabel: string | null;
  expiresAt: number | null;
  baseUrl: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProviderOAuthResolution = {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  headers: Record<string, string>;
  source: string;
  accountLabel?: string | null;
  expiresAt?: number | null;
};

function normalizeProvider(provider: string): string {
  return normalizeProviderId(provider) ?? provider.trim().toLowerCase();
}

export function ensureProviderOAuthTokensTable(): void {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_oauth_tokens (
      provider TEXT PRIMARY KEY,
      account_label TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at INTEGER,
      base_url TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function secretName(provider: string, kind: "ACCESS" | "REFRESH"): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_OAUTH_${kind}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function upsertProviderOAuthToken(input: ProviderOAuthTokenInput): ProviderOAuthTokenMeta {
  const provider = normalizeProvider(input.provider);
  const cfg = getProviderAuthConfig(provider);
  if (!cfg || cfg.authType === "api_key" || cfg.authType === "local") {
    throw new Error(`Provider does not support OAuth token storage: ${provider}`);
  }
  const accessToken = String(input.accessToken || "").trim();
  if (!accessToken) throw new Error("OAuth access token is required");
  ensureProviderOAuthTokensTable();

  const accessSecret = secretName(provider, "ACCESS");
  const refreshSecret = secretName(provider, "REFRESH");
  upsertSecret({ name: accessSecret, value: accessToken, source: `provider-oauth:${provider}` });
  if (String(input.refreshToken || "").trim()) {
    upsertSecret({ name: refreshSecret, value: String(input.refreshToken), source: `provider-oauth:${provider}` });
  }

  const now = new Date().toISOString();
  withSqliteWriteRecovery("provider-oauth:upsert", (db) => {
    db.prepare(`
      INSERT INTO provider_oauth_tokens (
        provider, account_label, access_token_encrypted, refresh_token_encrypted,
        expires_at, base_url, scopes, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        account_label = excluded.account_label,
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        expires_at = excluded.expires_at,
        base_url = excluded.base_url,
        scopes = excluded.scopes,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      provider,
      input.accountLabel ?? null,
      `secret:${accessSecret}`,
      String(input.refreshToken || "").trim() ? `secret:${refreshSecret}` : null,
      input.expiresAt ?? null,
      input.baseUrl ?? cfg.defaultBaseUrl ?? null,
      JSON.stringify(input.scopes ?? []),
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    );
  });
  const meta = getProviderOAuthTokenMeta(provider);
  if (!meta) throw new Error("OAuth token metadata was not saved");
  return meta;
}

export function listProviderOAuthTokenMeta(): ProviderOAuthTokenMeta[] {
  ensureProviderOAuthTokensTable();
  const rows = getSqlite()
    .prepare(`
      SELECT provider, account_label, expires_at, base_url, scopes, metadata_json, created_at, updated_at
      FROM provider_oauth_tokens
      ORDER BY provider ASC
    `)
    .all() as Array<{
      provider: string;
      account_label: string | null;
      expires_at: number | null;
      base_url: string | null;
      scopes: string;
      metadata_json: string;
      created_at: string;
      updated_at: string;
    }>;
  return rows.map((row) => ({
    provider: row.provider,
    accountLabel: row.account_label,
    expiresAt: row.expires_at,
    baseUrl: row.base_url,
    scopes: parseJson<string[]>(row.scopes, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getProviderOAuthTokenMeta(providerRaw: string): ProviderOAuthTokenMeta | null {
  ensureProviderOAuthTokensTable();
  const provider = normalizeProvider(providerRaw);
  return listProviderOAuthTokenMeta().find((entry) => entry.provider === provider) ?? null;
}

export function deleteProviderOAuthToken(providerRaw: string): boolean {
  ensureProviderOAuthTokensTable();
  const provider = normalizeProvider(providerRaw);
  const result = getSqlite().prepare("DELETE FROM provider_oauth_tokens WHERE provider = ?").run(provider);
  return result.changes > 0;
}

export function resolveProviderOAuthCredential(providerRaw: string): ProviderOAuthResolution {
  ensureProviderOAuthTokensTable();
  const provider = normalizeProvider(providerRaw);
  const cfg = getProviderAuthConfig(provider);
  if (!cfg || cfg.authType === "api_key" || cfg.authType === "local") {
    throw new Error(`Provider does not use OAuth credentials: ${provider}`);
  }

  const row = getSqlite()
    .prepare(`
      SELECT provider, account_label, access_token_encrypted, refresh_token_encrypted,
             expires_at, base_url
      FROM provider_oauth_tokens
      WHERE provider = ?
      LIMIT 1
    `)
    .get(provider) as
    | {
        provider: string;
        account_label: string | null;
        access_token_encrypted: string;
        refresh_token_encrypted: string | null;
        expires_at: number | null;
        base_url: string | null;
      }
    | undefined;

  if (!row) {
    const fromEnv = resolveProviderEnvApiKey(provider);
    if (fromEnv?.apiKey) {
      return {
        provider,
        apiKey: fromEnv.apiKey,
        baseUrl: cfg.defaultBaseUrl,
        headers: getProviderRequiredHeaders(provider),
        source: fromEnv.source,
      };
    }
    throw new Error(`OAuth login required for provider: ${provider}`);
  }

  const ref = row.access_token_encrypted.replace(/^secret:/, "");
  const accessToken = resolveSecretValue(ref);
  if (!accessToken) {
    throw new Error(`OAuth token for ${provider} could not be decrypted. Reconnect this provider.`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at <= nowSeconds + 60) {
    throw new Error(`OAuth token for ${provider} is expired or expiring. Reconnect this provider.`);
  }

  return {
    provider,
    apiKey: accessToken,
    baseUrl: row.base_url ?? cfg.defaultBaseUrl,
    headers: getProviderRequiredHeaders(provider),
    source: `provider-oauth:${provider}`,
    accountLabel: row.account_label,
    expiresAt: row.expires_at,
  };
}
