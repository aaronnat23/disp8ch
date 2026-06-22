import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { resolveModelRefConfig } from "@/lib/agents/model-router";
import type { ModelConfig } from "@/types/execution";

interface MoaConfig {
  topic: string;
  referenceModelIds: string[];
  aggregatorModelId?: string;
  maxTokens?: number;
}

interface MoaResult {
  referenceResponses: Array<{ modelId: string; response: string; error?: string }>;
  synthesis: string;
  modelUsed: string;
}

function resolveModelConfig(ref: string): ModelConfig | null {
  try {
    return resolveModelRefConfig(ref);
  } catch {
    return null;
  }
}

export async function runMixtureOfAgents(config: MoaConfig): Promise<MoaResult> {
  const referenceRefs = config.referenceModelIds.map((s) => s.trim()).filter(Boolean);
  if (referenceRefs.length === 0) throw new Error("No reference model IDs provided");

  const referenceConfigs = referenceRefs
    .map((ref) => resolveModelConfig(ref))
    .filter((c): c is ModelConfig => c !== null && Boolean(c.apiKey || c.provider === "ollama"));

  if (referenceConfigs.length === 0) {
    throw new Error("No active reference models found");
  }

  const { callModel } = await import("@/lib/agents/multi-provider");

  const referencePromises = referenceConfigs.map(async (model) => {
    try {
      const result = await callModel({
        provider: model.provider,
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl || undefined,
        systemPrompt: "You are a helpful analyst. Be concise.",
        userMessage: `Provide your analysis on: ${config.topic}\n\nBe concise (2-3 paragraphs max).`,
        maxTokens: Math.min(config.maxTokens || 500, 500),
      });
      return {
        modelId: `${model.provider}:${model.modelId}`,
        response: result.response,
      };
    } catch (err) {
      return {
        modelId: `${model.provider}:${model.modelId}`,
        response: "",
        error: String(err),
      };
    }
  });

  const referenceResponses = await Promise.all(referencePromises);
  const validResponses = referenceResponses.filter((r) => r.response);

  if (validResponses.length === 0) {
    throw new Error("All reference models failed to produce a response");
  }

  const aggregatorConfig = config.aggregatorModelId
    ? resolveModelConfig(config.aggregatorModelId)
    : referenceConfigs[0];

  if (!aggregatorConfig) {
    throw new Error("No aggregator model available");
  }

  const referenceText = validResponses
    .map((r, i) => `### Analysis ${i + 1} (${r.modelId}):\n${r.response}`)
    .join("\n\n");

  const synthesisResult = await callModel({
    provider: aggregatorConfig.provider,
    modelId: aggregatorConfig.modelId,
    apiKey: aggregatorConfig.apiKey,
    baseUrl: aggregatorConfig.baseUrl || undefined,
    systemPrompt: "You are an expert synthesizer. Synthesize the key insights, identify points of agreement and disagreement, and produce a single comprehensive verdict.",
    userMessage: `Below are ${validResponses.length} independent analyses on the topic "${config.topic}".\n\nSynthesize the key insights, identify points of agreement and disagreement, and produce a single comprehensive verdict.\n\n${referenceText}\n\n## Synthesized Verdict:`,
    maxTokens: Math.min(config.maxTokens || 800, 800),
  });

  return {
    referenceResponses,
    synthesis: synthesisResult.response,
    modelUsed: `${aggregatorConfig.provider}:${aggregatorConfig.modelId}`,
  };
}
