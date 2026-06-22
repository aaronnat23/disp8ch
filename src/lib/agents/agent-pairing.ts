import type { AgentRecord } from "@/lib/agents/registry";
import { getAgentById } from "@/lib/agents/registry";
import { getModelConfig } from "@/lib/agents/model-router";

export function classifyAgentFamily(agent: AgentRecord): "claude" | "codex" | "openai" | "google" | "local" | "other" {
  const modelId = (agent.modelRef ?? "").toLowerCase();
  if (modelId.includes("claude") || modelId.startsWith("anthropic:")) return "claude";
  if (modelId.includes("codex")) return "codex";
  if (modelId.includes("gpt") || modelId.startsWith("openai:")) return "openai";
  if (modelId.includes("gemini") || modelId.startsWith("google:")) return "google";
  if (
    modelId.includes("qwen") ||
    modelId.includes("llama") ||
    modelId.includes("mistral") ||
    modelId.includes("mixtral") ||
    modelId.startsWith("ollama:") ||
    modelId.startsWith("vllm:") ||
    modelId.startsWith("sglang:") ||
    modelId.startsWith("lm-studio:")
  ) {
    return "local";
  }

  try {
    const model = getModelConfig({ agentId: agent.id });
    const provider = model.provider.toLowerCase();
    if (provider === "anthropic") return "claude";
    if (provider === "openai") return "openai";
    if (provider === "google" || provider === "google-gemini-cli") return "google";
    if (
      provider === "ollama" ||
      provider === "vllm" ||
      provider === "sglang" ||
      provider === "lm-studio" ||
      provider === "deepseek" ||
      provider === "zhipu" ||
      provider === "moonshot" ||
      provider === "qwen"
    ) {
      return "local";
    }
  } catch {
    // fall through
  }

  return "other";
}

export interface DiscussionPair {
  claudeAgentId: string | null;
  codexAgentId: string | null;
  ready: boolean;
  missing: string[];
}

export function findDiscussionPair(agents: AgentRecord[]): DiscussionPair {
  let claudeAgentId: string | null = null;
  let codexAgentId: string | null = null;
  const missing: string[] = [];

  for (const agent of agents) {
    if (!agent.isActive) continue;
    const family = classifyAgentFamily(agent);
    if (family === "claude" && !claudeAgentId) {
      claudeAgentId = agent.id;
    } else if ((family === "codex" || family === "openai") && !codexAgentId) {
      codexAgentId = agent.id;
    }
  }

  if (!claudeAgentId) {
    missing.push("No active Claude/Anthropic agent found.");
  }
  if (!codexAgentId) {
    missing.push("No active Codex/OpenAI agent found.");
  }

  return {
    claudeAgentId,
    codexAgentId,
    ready: Boolean(claudeAgentId && codexAgentId),
    missing,
  };
}

export interface PairReadinessDetail {
  agentId: string;
  family: "claude" | "codex" | "openai" | "google" | "local" | "other";
  ready: boolean;
  issue?: string;
}

export function checkPairReadiness(agentIds: string[]): PairReadinessDetail[] {
  const details: PairReadinessDetail[] = [];
  for (const agentId of agentIds) {
    try {
      const agent = getAgentById(agentId);
      if (!agent) {
        details.push({ agentId, family: "other", ready: false, issue: "Agent not found." });
        continue;
      }
      if (!agent.isActive) {
        details.push({ agentId, family: classifyAgentFamily(agent), ready: false, issue: "Agent is inactive." });
        continue;
      }
      try {
        const model = getModelConfig({ agentId: agent.id });
        if (!model.apiKey && model.provider !== "ollama" && model.provider !== "vllm" && model.provider !== "sglang" && model.provider !== "lmstudio" && model.provider !== "deepseek" && model.provider !== "zhipu" && model.provider !== "moonshot" && model.provider !== "qwen") {
          details.push({
            agentId,
            family: classifyAgentFamily(agent),
            ready: false,
            issue: `Missing API key for provider ${model.provider}.`,
          });
          continue;
        }
      } catch {
        details.push({
          agentId,
          family: classifyAgentFamily(agent),
          ready: false,
          issue: "Failed to resolve model config.",
        });
        continue;
      }
      details.push({
        agentId,
        family: classifyAgentFamily(agent),
        ready: true,
      });
    } catch {
      details.push({ agentId, family: "other", ready: false, issue: "Agent lookup failed." });
    }
  }
  return details;
}
