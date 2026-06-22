import type { ModelConfig } from "@/types/execution";
import type { ModelProvider } from "@/types/model";
import { PROVIDERS } from "@/types/model";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { normalizeProviderBaseUrl, resolveProviderBaseUrl } from "@/lib/agents/provider-base-url";
import {
  getProviderBaseUrlEnvKey,
  isProviderLocallyHosted,
  providerRequiresApiKey,
} from "@/lib/agents/provider-plugins";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey, resolveProviderEnvApiKey } from "@/lib/agents/provider-auth";
import { providerUsesOAuth } from "@/lib/agents/provider-auth-registry";
import { resolveProviderOAuthCredential } from "@/lib/agents/provider-oauth";
import { getAgentById } from "@/lib/agents/registry";
import {
  resolveChannelSessionFastMode,
  resolveChannelSessionModelRef,
} from "@/lib/channels/session-settings";

const log = logger.child("model-router");

type ModelRow = {
  id?: string;
  provider: string;
  model_id: string;
  api_key: string;
  max_tokens: number | null;
  base_url: string | null;
  fast_mode?: number | null;
};

function resolveRowAuth(provider: string, storedApiKey: string): { apiKey: string; baseUrl?: string } {
  if (providerUsesOAuth(provider)) {
    try {
      return resolveProviderOAuthCredential(provider);
    } catch {
      // Fall back to env/literal resolution so config reads do not crash while
      // the UI reports a missing OAuth login.
    }
  }
  return resolveModelApiKey({ provider, storedApiKey });
}

function rowToModelConfig(row: ModelRow): ModelConfig {
  const provider = normalizeProviderId(row.provider) ?? "anthropic";
  const auth = resolveRowAuth(provider, row.api_key);
  return {
    provider: provider as ModelProvider,
    modelId: row.model_id,
    apiKey: auth.apiKey,
    maxTokens: row.max_tokens ?? undefined,
    baseUrl: normalizeProviderBaseUrl(provider, row.base_url) ??
      normalizeProviderBaseUrl(provider, (auth as { baseUrl?: string }).baseUrl) ??
      undefined,
    fastMode: row.fast_mode === 1,
  };
}

function applySessionFastModeOverride(
  config: ModelConfig,
  sessionId?: string | null,
): ModelConfig {
  const sessionFastMode = resolveChannelSessionFastMode(sessionId);
  if (sessionFastMode === null) {
    return config;
  }
  return {
    ...config,
    fastMode: sessionFastMode,
  };
}

function applyAgentOverrides(config: ModelConfig, agentId: string): ModelConfig {
  const agent = getAgentById(agentId);
  if (!agent) return config;
  const result = { ...config };
  // Per-agent API key overrides the model record's key
  if (agent.modelApiKey) {
    const auth = resolveModelApiKey({ provider: config.provider, storedApiKey: agent.modelApiKey });
    result.apiKey = auth.apiKey || agent.modelApiKey;
  }
  // Per-agent base URL override
  if (agent.modelBaseUrl) {
    result.baseUrl = normalizeProviderBaseUrl(config.provider, agent.modelBaseUrl) ?? agent.modelBaseUrl;
  }
  // Per-agent temperature
  if (agent.temperature != null) {
    result.temperature = agent.temperature;
  }
  // Per-agent max tokens
  if (agent.maxTokens != null) {
    result.maxTokens = agent.maxTokens;
  }
  // Per-agent default system prompt
  if (agent.systemPrompt) {
    result.agentSystemPrompt = agent.systemPrompt;
  }
  return result;
}

export function resolveModelRefConfig(modelRefRaw: string | null | undefined): ModelConfig | null {
  const modelRef = String(modelRefRaw || "").trim();
  if (!modelRef) return null;
  const db = getSqlite();
  const explicitProvider = modelRef.split(":");

  if (explicitProvider.length === 2) {
    const providerRaw = explicitProvider[0].trim();
    const modelIdRaw = explicitProvider[1].trim();
    if (!providerRaw || !modelIdRaw) return null;
    const provider = normalizeProviderId(providerRaw) ?? providerRaw;
    const row = db
      .prepare(
        "SELECT id, provider, model_id, api_key, max_tokens, base_url, fast_mode FROM models WHERE is_active = 1 AND provider = ? AND model_id = ? ORDER BY priority DESC LIMIT 1",
      )
      .get(provider, modelIdRaw) as ModelRow | undefined;
    if (row) return rowToModelConfig(row);

    const providerMeta = PROVIDERS.find((entry) => entry.id === provider);
    if (!providerMeta) return null;
    const auth = resolveProviderEnvApiKey(providerMeta.id);
    return {
      provider: providerMeta.id,
      modelId: modelIdRaw,
      apiKey: auth?.apiKey ?? "",
      baseUrl: resolveProviderBaseUrl(providerMeta.id, providerMeta.baseUrl),
      fastMode: false,
    };
  }

  const byId = db
    .prepare(
      "SELECT id, provider, model_id, api_key, max_tokens, base_url, fast_mode FROM models WHERE id = ? AND is_active = 1 LIMIT 1",
    )
    .get(modelRef) as ModelRow | undefined;
  if (byId) return rowToModelConfig(byId);

  const byModelId = db
    .prepare(
      "SELECT id, provider, model_id, api_key, max_tokens, base_url, fast_mode FROM models WHERE model_id = ? AND is_active = 1 ORDER BY priority DESC LIMIT 1",
    )
    .get(modelRef) as ModelRow | undefined;
  if (byModelId) return rowToModelConfig(byModelId);

  return null;
}

function resolveAgentModelOverride(agentId: string): ModelConfig | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  const base = resolveModelRefConfig(agent.modelRef);
  return base ? applyAgentOverrides(base, agentId) : null;
}

export function getModelConfig(options?: {
  agentId?: string | null;
  sessionId?: string | null;
}): ModelConfig {
  try {
    const sessionModelRef = resolveChannelSessionModelRef(options?.sessionId);
    if (sessionModelRef) {
      const sessionModel = resolveModelRefConfig(sessionModelRef);
      if (sessionModel) {
        const withOverrides = options?.agentId
          ? applyAgentOverrides(sessionModel, options.agentId)
          : sessionModel;
        return applySessionFastModeOverride(withOverrides, options?.sessionId);
      }
    }

    if (options?.agentId) {
      const agentOverride = resolveAgentModelOverride(options.agentId);
      if (agentOverride) {
        return applySessionFastModeOverride(agentOverride, options.sessionId);
      }
      // No modelRef but agent may still have per-agent overrides (apiKey, baseUrl, etc.)
      // — fall through to global model resolution, then apply overrides below.
    }

    const db = getSqlite();
    const rows = db
      .prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC")
      .all() as ModelRow[];

    if (rows.length > 0) {
      const base = rowToModelConfig(rows[0]);
      const withOverrides = options?.agentId ? applyAgentOverrides(base, options.agentId) : base;
      return applySessionFastModeOverride(withOverrides, options?.sessionId);
    }
  } catch {
    // Database not initialized yet, fall through
  }

  // Fallback to env vars — check each provider
  for (const provider of PROVIDERS) {
    const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider.id);
    const baseUrlEnvValue = baseUrlEnvKey ? process.env[baseUrlEnvKey] : undefined;
    if (isProviderLocallyHosted(provider.id)) {
      if (baseUrlEnvValue || resolveProviderEnvApiKey(provider.id)) {
        return applySessionFastModeOverride({
          provider: provider.id,
          modelId: provider.defaultModel,
          apiKey: resolveModelApiKey({ provider: provider.id, storedApiKey: "" }).apiKey,
          baseUrl: resolveProviderBaseUrl(provider.id, baseUrlEnvValue || provider.baseUrl),
          fastMode: false,
        }, options?.sessionId);
      }
      continue;
    }
    const auth = resolveProviderEnvApiKey(provider.id);
    if (auth || !providerRequiresApiKey(provider.id)) {
      return applySessionFastModeOverride({
        provider: provider.id,
        modelId: provider.defaultModel,
        apiKey: auth?.apiKey ?? resolveModelApiKey({ provider: provider.id, storedApiKey: "" }).apiKey,
        baseUrl: resolveProviderBaseUrl(provider.id, provider.baseUrl),
        fastMode: false,
      }, options?.sessionId);
    }
  }

  log.warn("No model API key configured");
  return applySessionFastModeOverride({
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    apiKey: "",
    fastMode: false,
  }, options?.sessionId);
}

export async function tryModelsWithFailover(
  fn: (config: ModelConfig) => Promise<unknown>
): Promise<unknown> {
  try {
    const db = getSqlite();
    const rows = db
      .prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC")
      .all() as ModelRow[];

    for (const row of rows) {
      try {
        const config = rowToModelConfig(row);
        return await fn(config);
      } catch (error) {
        log.warn("Model failed, trying next", {
          provider: row.provider,
          model: row.model_id,
          error: String(error),
        });
      }
    }
  } catch {
    // Fall through
  }

  const config = getModelConfig();
  return fn(config);
}
