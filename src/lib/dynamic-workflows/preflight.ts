import path from "node:path";
import { getAgentById } from "@/lib/agents/registry";
import { getModelConfig, resolveModelRefForAgent } from "@/lib/agents/model-router";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import type { DynamicWorkflowPlan } from "./types";

export interface DynamicWorkflowPreflightIssue {
  field: string;
  message: string;
}

export function preflightDynamicWorkflowPlan(
  plan: DynamicWorkflowPlan,
  runModelRef?: string | null,
): { ok: true } | { ok: false; issues: DynamicWorkflowPreflightIssue[] } {
  const issues: DynamicWorkflowPreflightIssue[] = [];
  if (plan.workspaceRoot && !path.isAbsolute(plan.workspaceRoot)) {
    issues.push({ field: "workspaceRoot", message: "Workspace root must be an absolute path." });
  }
  if (plan.supervision?.mode === "supervised") {
    if (!Number.isInteger(plan.supervision.maxRepairPasses) || plan.supervision.maxRepairPasses < 0 || plan.supervision.maxRepairPasses > 2) {
      issues.push({ field: "supervision.maxRepairPasses", message: "Repair passes must be between 0 and 2." });
    }
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const binding = plan.supervision[role];
      const agent = binding.agentId ? getAgentById(binding.agentId) : null;
      if (binding.agentId && !agent) {
        issues.push({ field: `supervision.${role}.agentId`, message: `The selected ${role} agent does not exist.` });
        continue;
      }
      if (agent && !agent.isActive) {
        issues.push({ field: `supervision.${role}.agentId`, message: `The selected ${role} agent is inactive.` });
      }
      const modelRef = binding.modelRef || agent?.modelRef || runModelRef;
      const model = resolveModelRefForAgent(modelRef, agent?.id) ?? getModelConfig({ agentId: agent?.id });
      if (!model) {
        issues.push({ field: `supervision.${role}.modelRef`, message: `No callable model is configured for the ${role}.` });
      } else if (!model.apiKey && providerRequiresApiKey(model.provider)) {
        issues.push({
          field: `supervision.${role}.modelRef`,
          message: `The ${role} model ${model.provider}/${model.modelId} has no configured credential.`,
        });
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
