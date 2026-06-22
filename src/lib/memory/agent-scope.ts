import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";

export function resolveMemoryAgentId(agentIdRaw?: string | null): string {
  const requested = String(agentIdRaw || "").trim();
  const defaultAgent = getDefaultAgent();
  if (!requested || requested === "default" || requested === defaultAgent.id) {
    return "default";
  }
  return getAgentById(requested)?.id || "default";
}
