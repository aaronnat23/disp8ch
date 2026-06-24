import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";

export interface MemoryScope {
  agentId: string;
  memoryAgentId: string;
  workspacePath: string;
}

/**
 * Resolves the authoritative memory agent scope from a requested agent id.
 * Shared by the memory API route and the visual memory nodes so both write and
 * search under the exact same agent key.
 */
export function resolveMemoryScope(agentIdRaw?: string | null): MemoryScope {
  const requested = String(agentIdRaw || "").trim();
  if (!requested || requested === "default") {
    const agent = getDefaultAgent();
    return { agentId: agent.id, memoryAgentId: "default", workspacePath: agent.workspacePath };
  }
  const agent = getAgentById(requested);
  if (!agent) {
    const fallback = getDefaultAgent();
    return { agentId: fallback.id, memoryAgentId: "default", workspacePath: fallback.workspacePath };
  }
  const defaultAgent = getDefaultAgent();
  const memoryAgentId = agent.id === defaultAgent.id ? "default" : agent.id;
  return { agentId: agent.id, memoryAgentId, workspacePath: agent.workspacePath };
}
