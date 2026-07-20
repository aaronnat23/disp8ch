import path from "node:path";
import { getAgentById, getDefaultAgent, type AgentRecord } from "@/lib/agents/registry";
import { getModelConfig, resolveModelRefForAgent } from "@/lib/agents/model-router";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import { resolveToolNamesFromToolsets } from "@/lib/engine/toolsets";
import type { ModelConfig } from "@/types/execution";
import type { DynamicWorkflowPlan, DynamicWorkflowWorkerRecord } from "./types";

export interface DynamicWorkerContext {
  agent: AgentRecord;
  model: ModelConfig;
  effectiveToolNames: string[];
  workspaceRoot: string;
}

function readWorkerToolsets(worker: DynamicWorkflowWorkerRecord): string[] {
  if (!worker.toolPolicyJson) return [];
  try {
    const parsed = JSON.parse(worker.toolPolicyJson) as { toolsets?: unknown };
    return Array.isArray(parsed.toolsets) ? parsed.toolsets.map(String) : [];
  } catch {
    return [];
  }
}

export function resolveDynamicWorkerContext(
  worker: DynamicWorkflowWorkerRecord,
  plan: DynamicWorkflowPlan,
  runModelRef?: string | null,
): DynamicWorkerContext {
  const agent = (worker.agentId ? getAgentById(worker.agentId) : null) ?? getDefaultAgent();
  if (!agent.isActive) throw new Error(`Bound agent "${agent.name}" is inactive.`);

  const model =
    resolveModelRefForAgent(worker.modelRef, agent.id) ??
    resolveModelRefForAgent(agent.modelRef, agent.id) ??
    resolveModelRefForAgent(runModelRef, agent.id) ??
    getModelConfig({ agentId: agent.id });

  if (!model.modelId || !model.provider) throw new Error("No callable model is configured for this worker.");
  if (!model.apiKey && providerRequiresApiKey(model.provider)) {
    throw new Error(`No credential is configured for ${model.provider}/${model.modelId}.`);
  }

  const agentTools = new Set(resolveToolNamesFromToolsets(agent.enabledToolsets));
  const requestedToolsets = readWorkerToolsets(worker);
  const requestedTools = requestedToolsets.length > 0
    ? new Set(resolveToolNamesFromToolsets(requestedToolsets))
    : agentTools;
  const disabled = new Set(agent.disabledTools);
  const effectiveToolNames = [...agentTools]
    .filter((name) => requestedTools.has(name))
    .filter((name) => !disabled.has(name))
    .filter((name) => name !== "send-webchat" && name !== "send_webchat")
    .sort();

  const requestedRoot = String(plan.workspaceRoot || agent.workspacePath || "").trim();
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) {
    throw new Error("The supervised run requires an absolute, confirmed workspace root.");
  }

  return {
    agent,
    model,
    effectiveToolNames,
    workspaceRoot: path.resolve(requestedRoot),
  };
}
