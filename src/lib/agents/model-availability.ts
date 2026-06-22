import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import {
  getProviderBaseUrlEnvKey,
  isProviderLocallyHosted,
  listProviderPlugins,
} from "@/lib/agents/provider-plugins";
import { hasClaudeCodeCredentials } from "@/lib/agents/anthropic-oauth";

export type RuntimeModelAvailability = {
  available: boolean;
  source: "db" | "env" | "local-provider" | "none";
  details: string;
};

let envFileCache: Map<string, string> | null = null;

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readEnvLocal(): Map<string, string> {
  if (envFileCache) return envFileCache;
  envFileCache = new Map();
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return envFileCache;

  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    envFileCache.set(match[1], stripEnvQuotes(match[2]));
  }
  return envFileCache;
}

function hasUsableValue(value: string): boolean {
  return value.length > 0 && value !== "undefined" && value !== "null";
}

function hasEnvValue(key: string | null): boolean {
  if (!key) return false;
  const value = String(process.env[key] ?? "").trim();
  if (hasUsableValue(value)) return true;
  return hasUsableValue(String(readEnvLocal().get(key) ?? "").trim());
}

const PROVIDER_ENV_ALIASES: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  qwen: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  "openai-compatible": ["LOCAL_OPENAI_API_KEY", "OPENAI_API_KEY"],
};

function hasProviderEnvCredential(providerId: string, primaryEnvKey: string): boolean {
  const keys = new Set([primaryEnvKey, ...(PROVIDER_ENV_ALIASES[providerId] ?? [])]);
  for (const key of keys) {
    if (hasEnvValue(key)) return true;
  }
  return false;
}

function getDbModelAvailability(db: Database): RuntimeModelAvailability | null {
  const row = db
    .prepare(
      "SELECT provider, model_id FROM models WHERE is_active = 1 ORDER BY priority DESC LIMIT 1",
    )
    .get() as { provider?: string; model_id?: string } | undefined;
  if (!row) return null;

  const count = (db.prepare("SELECT COUNT(*) as c FROM models WHERE is_active = 1").get() as { c: number }).c;
  const provider = row.provider ? ` via ${row.provider}` : "";
  const model = row.model_id ? ` (${row.model_id})` : "";
  return {
    available: true,
    source: "db",
    details: `${count} active model(s)${provider}${model}`,
  };
}

function getEnvModelAvailability(): RuntimeModelAvailability | null {
  if (hasClaudeCodeCredentials()) {
    return {
      available: true,
      source: "env",
      details: "Claude Code OAuth credentials available for Anthropic",
    };
  }

  for (const provider of listProviderPlugins()) {
    if (provider.requiresApiKey && hasProviderEnvCredential(provider.id, provider.envKey)) {
      return {
        available: true,
        source: "env",
        details: `Env-backed provider available: ${provider.name} (${provider.defaultModel})`,
      };
    }

    if (isProviderLocallyHosted(provider.id) && hasEnvValue(getProviderBaseUrlEnvKey(provider.id))) {
      return {
        available: true,
        source: "local-provider",
        details: `Local provider configured: ${provider.name} (${provider.defaultModel})`,
      };
    }
  }

  return null;
}

export function getRuntimeModelAvailability(db?: Database): RuntimeModelAvailability {
  try {
    if (db) {
      const dbAvailability = getDbModelAvailability(db);
      if (dbAvailability) return dbAvailability;
    }
  } catch {
    // Keep diagnostics non-fatal; env-backed routing may still be usable.
  }

  const envAvailability = getEnvModelAvailability();
  if (envAvailability) return envAvailability;

  return {
    available: false,
    source: "none",
    details: "No active model configured",
  };
}
