import { getSqlite, initializeDatabase } from "@/lib/db";

export type ModelRuntimeConfig = {
  smartModelRoutingEnabled: boolean;
  smartModelRoutingMaxChars: number;
  smartModelRoutingMaxWords: number;
  anthropicPromptCachingEnabled: boolean;
};

const DEFAULT_CONFIG: ModelRuntimeConfig = {
  smartModelRoutingEnabled: false,
  smartModelRoutingMaxChars: 160,
  smartModelRoutingMaxWords: 28,
  anthropicPromptCachingEnabled: true,
};

let cache: { value: ModelRuntimeConfig; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function coerceInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function loadModelRuntimeConfig(): ModelRuntimeConfig {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  try {
    initializeDatabase();
    const row = getSqlite()
      .prepare(
        `
          SELECT
            smart_model_routing_enabled,
            smart_model_routing_max_chars,
            smart_model_routing_max_words,
            anthropic_prompt_caching_enabled
          FROM app_config
          WHERE id = 'default'
        `,
      )
      .get() as
      | {
          smart_model_routing_enabled?: number | string | boolean | null;
          smart_model_routing_max_chars?: number | null;
          smart_model_routing_max_words?: number | null;
          anthropic_prompt_caching_enabled?: number | string | boolean | null;
        }
      | undefined;

    const value: ModelRuntimeConfig = {
      smartModelRoutingEnabled: coerceBool(
        row?.smart_model_routing_enabled,
        DEFAULT_CONFIG.smartModelRoutingEnabled,
      ),
      smartModelRoutingMaxChars: coerceInt(
        row?.smart_model_routing_max_chars,
        DEFAULT_CONFIG.smartModelRoutingMaxChars,
        40,
        2000,
      ),
      smartModelRoutingMaxWords: coerceInt(
        row?.smart_model_routing_max_words,
        DEFAULT_CONFIG.smartModelRoutingMaxWords,
        4,
        300,
      ),
      anthropicPromptCachingEnabled: coerceBool(
        row?.anthropic_prompt_caching_enabled,
        DEFAULT_CONFIG.anthropicPromptCachingEnabled,
      ),
    };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch {
    cache = { value: DEFAULT_CONFIG, expiresAt: Date.now() + CACHE_TTL_MS };
    return DEFAULT_CONFIG;
  }
}

export function clearModelRuntimeConfigCache(): void {
  cache = null;
}
