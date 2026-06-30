import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { providerRequiresApiKey, isProviderLocallyHosted } from "@/lib/agents/provider-plugins";
import { getProviderOAuthTokenMeta } from "@/lib/agents/provider-oauth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { resolveModelApiKey, resolveProviderEnvApiKey } from "@/lib/agents/provider-auth";

const log = logger.child("smart-routing");

interface ModelChoice {
  id: string;
  provider: string;
  modelId: string;
  priority: number;
  fastMode: boolean;
  isActive: boolean;
  apiKey?: string | null;
  baseUrl?: string | null;
  maxTokens?: number | null;
}

export interface RoutingDecision {
  modelRef: string;
  reason: string;
  costTier: "fast" | "standard" | "premium";
}

type ResolvedRouteRow = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  fastMode?: boolean;
};

type SmartRouteDbRow = Omit<ModelChoice, "fastMode"> & {
  fastMode?: boolean | number | null;
};

// Complex intent keywords — any match means this is NOT a simple turn
const COMPLEX_KEYWORDS = new Set([
  "debug", "debugging", "implement", "implementation", "refactor",
  "patch", "traceback", "stacktrace", "exception", "error", "analyze",
  "analysis", "investigate", "architecture", "design", "compare",
  "benchmark", "optimize", "optimise", "review", "terminal", "shell",
  "tool", "tools", "pytest", "test", "tests", "plan", "planning",
  "delegate", "research", "comprehensive", "detailed", "explain",
  "summarize", "generate", "build", "create", "deploy", "migrate",
  "workflow", "agent", "council", "board", "hierarchy", "schedule",
  "export", "import", "configure", "setup", "install", "uninstall",
]);

/**
 * Whether a model's provider can authenticate right now, checked synchronously
 * with no network call. Prevents smart-routing from selecting a provider whose
 * credentials are missing or whose OAuth token is expired, which would otherwise
 * fail every agent-node call routed to it.
 */
export function isModelAuthUsable(model: { provider: string; apiKey?: string | null }): boolean {
  const provider = normalizeProviderId(model.provider) ?? model.provider;
  if (isProviderLocallyHosted(provider)) return true;

  // OAuth-backed providers: usable only when a non-expired token exists.
  const oauth = getProviderOAuthTokenMeta(provider);
  if (oauth) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (oauth.expiresAt && oauth.expiresAt <= nowSeconds + 60) return false;
    return true;
  }

  // API-key providers: usable when a key is stored on the model row or in env.
  if (!providerRequiresApiKey(provider)) return true;
  const hasStoredKey = Boolean(model.apiKey && String(model.apiKey).trim());
  if (hasStoredKey) return true;
  try {
    return Boolean(resolveProviderEnvApiKey(provider)?.apiKey);
  } catch {
    return false;
  }
}

// Purely heuristic — keyword + pattern matching, DB model lookups only.
// No LLM calls in this file.
export function routeRequestSmart(
  userMessage: string,
  sessionFastMode: boolean | null,
  hasAttachments: boolean,
): RoutingDecision {
  const db = getSqlite();
  const allModels = db.prepare(
    "SELECT m.id, m.provider, m.model_id as modelId, m.priority, m.fast_mode as fastMode, m.is_active as isActive, m.api_key as apiKey, m.base_url as baseUrl, m.max_tokens as maxTokens FROM models m WHERE m.is_active = 1 ORDER BY m.priority DESC, m.created_at DESC"
  ).all() as ModelChoice[];

  // Skip providers that cannot authenticate right now. If that leaves nothing
  // (e.g. every provider is misconfigured), fall back to the full set rather
  // than returning no route at all.
  const usable = allModels.filter((m) => isModelAuthUsable(m));
  const models = usable.length > 0 ? usable : allModels;

  const fastModels = models.filter(m => m.fastMode);
  const standardModels = models.filter(m => !m.fastMode);

  const msg = userMessage.toLowerCase().trim();
  const msgLength = userMessage.length;
  const wordCount = msg.split(/\s+/).length;

  // Vision requests → vision-capable model
  if (hasAttachments) {
    const visionModel = models.find(m => m.modelId.match(/claude|gemini|gpt-4|gpt-5|vision/i));
    if (visionModel) {
      return { modelRef: `${visionModel.provider}:${visionModel.modelId}`, reason: "vision request", costTier: "premium" };
    }
  }

  // Explicit fast mode override
  if (sessionFastMode === true) {
    const pick = fastModels[0] || standardModels[0];
    if (pick) return { modelRef: `${pick.provider}:${pick.modelId}`, reason: "fast mode active", costTier: "fast" };
  }

  // Complexity detection (borrowed from smart-model-routing.ts)
  const hasCode = /```[\s\S]*?```|`[^`]+`/.test(userMessage);
  const hasUrl = /https?:\/\/[^\s]+/.test(userMessage);
  const hasComplexKeyword = msg.split(/\s+/).some(w => COMPLEX_KEYWORDS.has(w));
  const isComplex = hasCode || hasUrl || msgLength > 500 || wordCount > 80 || hasComplexKeyword;

  // Simple/turn detection — route to fast model
  const isTrivial = !isComplex && msgLength < 100 && wordCount < 15;

  if (isTrivial && fastModels.length > 0) {
    const pick = fastModels[0];
    return { modelRef: `${pick.provider}:${pick.modelId}`, reason: "simple turn — fast model", costTier: "fast" };
  }

  // Complex tasks → best standard model
  if (isComplex && standardModels.length > 0) {
    const pick = standardModels[0];
    if (pick) return { modelRef: `${pick.provider}:${pick.modelId}`, reason: "complex task — premium model", costTier: "premium" };
  }

  // Default: first standard, fallback to fast
  const defaultPick = standardModels[0] || fastModels[0];
  if (defaultPick) {
    return { modelRef: `${defaultPick.provider}:${defaultPick.modelId}`, reason: "default route", costTier: "standard" };
  }

  log.warn("No active models found for smart routing");
  return { modelRef: "", reason: "no models available", costTier: "standard" };
}

function splitModelRef(modelRef: string): { provider: string; modelId: string } | null {
  const separator = modelRef.indexOf(":");
  if (separator <= 0) return null;
  const provider = modelRef.slice(0, separator).trim();
  const modelId = modelRef.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

function resolveRouteRow(modelRef: string): ResolvedRouteRow | null {
  const parsed = splitModelRef(modelRef);
  if (!parsed) return null;
  const provider = normalizeProviderId(parsed.provider) ?? parsed.provider;
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT provider, model_id as modelId, api_key as apiKey, base_url as baseUrl, max_tokens as maxTokens, fast_mode as fastMode
         FROM models
        WHERE is_active = 1 AND provider = ? AND model_id = ?
        ORDER BY priority DESC, created_at DESC
        LIMIT 1`,
    )
    .get(provider, parsed.modelId) as SmartRouteDbRow | undefined;
  if (!row) return null;
  const normalizedProvider = normalizeProviderId(row.provider) ?? row.provider.trim().toLowerCase();
  const auth = resolveModelApiKey({ provider: normalizedProvider, storedApiKey: row.apiKey ?? "" });
  return {
    provider: normalizedProvider,
    modelId: row.modelId,
    apiKey: auth.apiKey,
    baseUrl: normalizeProviderBaseUrl(normalizedProvider, row.baseUrl ?? undefined) ?? undefined,
    maxTokens: row.maxTokens ?? undefined,
    fastMode: row.fastMode === true || row.fastMode === 1,
  };
}

// Backwards-compatible wrapper for existing callers (multi-provider, tool-caller)
export function resolveSmartRoute(params: {
  userMessage?: string;
  requireTools?: boolean;
  current?: { provider?: string; modelId?: string; apiKey?: string };
}): {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  fastMode?: boolean;
  routeLabel: string;
} | null {
  const decision = routeRequestSmart(
    params.userMessage || "",
    null,
    false,
  );

  if (!decision.modelRef) return null;

  const selected = resolveRouteRow(decision.modelRef);
  if (!selected) return null;

  return {
    provider: selected.provider,
    modelId: selected.modelId,
    apiKey: selected.apiKey,
    baseUrl: selected.baseUrl,
    maxTokens: selected.maxTokens,
    fastMode: selected.fastMode ?? decision.costTier === "fast",
    routeLabel: `auto → ${decision.reason}`,
  };
}
