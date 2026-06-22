import type { ToolDefinition } from "@/lib/engine/tools";
import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";
import type { UniversalAnswerShape } from "@/lib/channels/universal-answer-shape";
import { isRepoCriterionAuditRequest } from "@/lib/channels/repo-audit-discipline";

export type EvidenceBudget = {
  maxToolCalls: number;
  continuationLimit: number;
  perDimensionMinimum: number;
  requiredToolFamilies: string[];
  stopWhen: string[];
  profile?: "default" | "criterion_repo_audit";
};

function toolFamily(name: string): string {
  if (/web|fetch|browser/i.test(name)) return "web";
  if (/file|repo|grep|search/i.test(name)) return "repo";
  if (/workflow|node/i.test(name)) return "workflow";
  if (/memory|session/i.test(name)) return "memory";
  if (/schedule|webhook|channel|status|board|goal/i.test(name)) return "app_state";
  return "general";
}

export function createEvidenceBudget(input: {
  message?: string;
  plan: UniversalInvestigationPlan;
  answerShape: UniversalAnswerShape;
  availableTools: ToolDefinition[];
  requestedMaxToolCalls: number;
}): EvidenceBudget {
  const requiredFamilies = new Set<string>();
  for (const dimension of input.plan.dimensions) {
    for (const evidence of dimension.evidenceNeeded) {
      if (evidence === "web") requiredFamilies.add("web");
      if (evidence === "repo" || evidence === "files") requiredFamilies.add("repo");
      if (evidence === "app_state" || evidence === "current_config" || evidence === "runtime" || evidence === "execution") {
        requiredFamilies.add("app_state");
      }
    }
    for (const tool of dimension.suggestedTools) {
      requiredFamilies.add(toolFamily(tool));
    }
  }

  const availableFamilies = new Set(input.availableTools.map((tool) => toolFamily(tool.name)));
  const requiredToolFamilies = Array.from(requiredFamilies).filter((family) => availableFamilies.has(family));
  const criterionAudit = isRepoCriterionAuditRequest(input.message ?? "", input.plan);
  if (criterionAudit && availableFamilies.has("repo") && !requiredToolFamilies.includes("repo")) {
    requiredToolFamilies.unshift("repo");
  }
  const richMultiplier = input.answerShape.depth === "rich" ? 1.25 : input.answerShape.depth === "brief" ? 0.65 : 1;
  const structuralMinimum = Math.max(4, requiredToolFamilies.length * 3, input.plan.dimensions.filter((d) => d.priority === "required").length * 2);
  if (criterionAudit) {
    const criterionCap = Math.max(1, Math.min(input.requestedMaxToolCalls, 24));
    return {
      profile: "criterion_repo_audit",
      maxToolCalls: Math.min(Math.max(8, structuralMinimum), criterionCap),
      continuationLimit: 1,
      perDimensionMinimum: 1,
      requiredToolFamilies,
      stopWhen: [
        "each requested criterion has source/code evidence and test/verification evidence, or an explicit missing-evidence marker",
        "package/script evidence is enough to give repo-native verification commands",
        "the next tool call would broaden the audit instead of resolving a specific criterion",
      ],
    };
  }
  const maxToolCalls = Math.max(
    structuralMinimum,
    Math.min(120, Math.floor(input.requestedMaxToolCalls * richMultiplier)),
  );

  return {
    profile: "default",
    maxToolCalls,
    continuationLimit: input.answerShape.depth === "rich" ? 4 : input.answerShape.depth === "brief" ? 1 : 2,
    perDimensionMinimum: input.answerShape.depth === "rich" ? 2 : 1,
    requiredToolFamilies,
    stopWhen: [
      "all required dimensions have direct evidence or an explicit unavailable/unknown marker",
      "additional tool calls would only repeat the same source category",
      "the answer can cite concrete repo files/source URLs/app-state records for major claims",
    ],
  };
}

export function formatEvidenceBudgetForPrompt(budget: EvidenceBudget): string {
  return [
    `Evidence budget profile: ${budget.profile ?? "default"}.`,
    `Evidence budget: up to ${budget.maxToolCalls} tool calls.`,
    `Continuation limit: ${budget.continuationLimit}.`,
    `Required tool families when available: ${budget.requiredToolFamilies.join(", ") || "none"}.`,
    `Per required dimension minimum: ${budget.perDimensionMinimum} direct evidence item(s) or an explicit unknown/blocker.`,
    `Stop when: ${budget.stopWhen.join("; ")}`,
  ].join("\n");
}
