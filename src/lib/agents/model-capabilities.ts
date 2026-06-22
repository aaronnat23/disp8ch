import { resolveModelAlias } from "@/lib/agents/model-aliases";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { isReasoningModelHeuristic } from "@/lib/agents/ollama-discovery";
import { PROVIDERS, type ProviderInfo, type ProviderModelInfo } from "@/types/model";

export { isReasoningModelHeuristic };

export type ToolSupportStatus = "supported" | "unsupported" | "unknown";

export interface ModelToolSupportCheck {
  provider: string;
  modelId: string;
  resolvedModelId: string;
  status: ToolSupportStatus;
  reason: string;
  matchedModel?: ProviderModelInfo;
  recommendations: ProviderModelInfo[];
}

function normalizeModelIdForLookup(modelId: string): string {
  return resolveModelAlias(modelId).trim().replace(/^models\//i, "").toLowerCase();
}

function normalizeModelFamily(modelId: string): string {
  // Normalize snapshot/date suffixes like -20250514 for matching.
  return normalizeModelIdForLookup(modelId).replace(/-\d{8}(-\d+)?$/, "");
}

function getProviderInfo(provider: string): ProviderInfo | undefined {
  const normalized = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === normalized);
}

function matchModel(candidates: ProviderModelInfo[], modelId: string): ProviderModelInfo | undefined {
  const normalized = normalizeModelIdForLookup(modelId);
  const family = normalizeModelFamily(modelId);

  for (const model of candidates) {
    const id = normalizeModelIdForLookup(model.id);
    if (id === normalized) return model;
  }
  for (const model of candidates) {
    const id = normalizeModelFamily(model.id);
    if (id === family) return model;
  }
  return undefined;
}

export function getToolCapableRecommendations(provider: string): ProviderModelInfo[] {
  const info = getProviderInfo(provider);
  if (!info) return [];

  const supported = info.models.filter((m) => m.supportsTools);
  const recommended = supported.filter((m) => m.recommended);
  return (recommended.length > 0 ? recommended : supported).slice(0, 4);
}

export function checkModelToolSupport(provider: string, modelId: string): ModelToolSupportCheck {
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const resolvedModelId = resolveModelAlias(modelId || "");
  const info = getProviderInfo(normalizedProvider);
  const recommendations = getToolCapableRecommendations(normalizedProvider);

  if (!info) {
    return {
      provider: normalizedProvider,
      modelId,
      resolvedModelId,
      status: "unknown",
      reason: `Provider "${provider}" is not in the known provider catalog.`,
      recommendations,
    };
  }

  const matched = matchModel(info.models, resolvedModelId);
  if (matched) {
    if (matched.supportsTools) {
      return {
        provider: normalizedProvider,
        modelId,
        resolvedModelId,
        status: "supported",
        reason: `${matched.id} is documented as tool/function-call capable.`,
        matchedModel: matched,
        recommendations,
      };
    }
    const note = matched.notes ? ` ${matched.notes}` : "";
    return {
      provider: normalizedProvider,
      modelId,
      resolvedModelId,
      status: "unsupported",
      reason: `${matched.id} is not recommended for tool/function-calling workflows.${note}`,
      matchedModel: matched,
      recommendations,
    };
  }

  // OpenRouter/Ollama/local providers frequently use dynamic catalogs; allow unknown IDs with warning.
  if (
    normalizedProvider === "openrouter" ||
    normalizedProvider === "openai-compatible" ||
    normalizedProvider === "ollama" ||
    normalizedProvider === "vllm" ||
    normalizedProvider === "sglang" ||
    normalizedProvider === "lmstudio" ||
    normalizedProvider === "opencode" ||
    normalizedProvider === "opencode-go"
  ) {
    return {
      provider: normalizedProvider,
      modelId,
      resolvedModelId,
      status: "unknown",
      reason:
        `Model "${resolvedModelId}" is not in the curated ${normalizedProvider} list. ` +
        "Proceeding in compatibility mode; verify tool-calling capability with probe-tools.",
      recommendations,
    };
  }

  return {
    provider: normalizedProvider,
    modelId,
    resolvedModelId,
    status: "unknown",
    reason:
      `Model "${resolvedModelId}" is not in the curated ${normalizedProvider} list. ` +
      "Tool-calling capability is unknown.",
    recommendations,
  };
}

export interface ModelVisionSupportCheck {
  provider: string;
  modelId: string;
  supportsVision: boolean;
  reason: string;
}

export function checkModelVisionSupport(provider: string, modelId: string): ModelVisionSupportCheck {
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const resolvedModelId = resolveModelAlias(modelId || "");
  const info = getProviderInfo(normalizedProvider);

  // Heuristic for local/dynamic models and known vision-capable model families
  const idLower = resolvedModelId.toLowerCase();
  if (
    idLower.includes("llava") ||
    idLower.includes("moondream") ||
    idLower.includes("bakllava") ||
    idLower.includes("vision") ||
    idLower.includes("qwen-vl") ||
    idLower.includes("internvl") ||
    idLower.includes("minicpm-v")
  ) {
    return { provider: normalizedProvider, modelId, supportsVision: true, reason: "Vision model heuristic match on model ID." };
  }
  // All Claude 3+ and Claude 4+ models support vision
  if (normalizedProvider === "anthropic" && (idLower.includes("claude-3") || idLower.includes("claude-4") || idLower.includes("claude-opus-4") || idLower.includes("claude-sonnet-4") || idLower.includes("claude-haiku-4"))) {
    return { provider: normalizedProvider, modelId, supportsVision: true, reason: "Anthropic Claude 3+/4+ family heuristic." };
  }
  // All Gemini models support vision
  if ((normalizedProvider === "google" || normalizedProvider === "google-gemini-cli") && idLower.includes("gemini")) {
    return { provider: normalizedProvider, modelId, supportsVision: true, reason: "Gemini family heuristic." };
  }

  if (!info) {
    return { provider: normalizedProvider, modelId, supportsVision: false, reason: `Provider "${provider}" not in catalog.` };
  }

  const matched = matchModel(info.models, resolvedModelId);
  if (matched?.supportsVision) {
    return { provider: normalizedProvider, modelId, supportsVision: true, reason: "Catalog entry marks model as vision-capable." };
  }

  // Heuristic for OpenRouter: check the upstream model segment
  if (normalizedProvider === "openrouter") {
    const upstream = idLower.split("/").slice(1).join("/");
    if (
      upstream.includes("claude") ||
      upstream.includes("gemini") ||
      upstream.includes("gpt-4") ||
      upstream.includes("gpt-5") ||
      upstream.includes("llava")
    ) {
      return { provider: normalizedProvider, modelId, supportsVision: true, reason: "OpenRouter upstream model heuristic." };
    }
  }

  return { provider: normalizedProvider, modelId, supportsVision: false, reason: "No vision capability found in catalog or heuristics." };
}
