import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";
import { listAllCapabilities, type CapabilityManifestEntry } from "@/lib/channels/capability-manifest";
import { callModel } from "@/lib/agents/multi-provider";
import type { ModelProvider } from "@/types/model";

export type TaskType =
  | "direct_answer"
  | "composition"
  | "transformation"
  | "session_recall"
  | "web_research"
  | "repo_inspection"
  | "app_state_read"
  | "app_design"
  | "app_mutation_proposal"
  | "benchmark_artifact_analysis"
  | "mixed";

export type Operation =
  | "answer"
  | "compare"
  | "summarize"
  | "transform"
  | "compose"
  | "research"
  | "inspect"
  | "plan"
  | "design"
  | "act";

export type EvidenceNeed =
  | "provided_text"
  | "recent_session"
  | "durable_memory"
  | "repo_files"
  | "app_state"
  | "benchmark_artifacts"
  | "current_web"
  | "general_knowledge";

export type TurnPlan = {
  userGoal: string;
  taskType: TaskType;
  operation: Operation;
  evidenceNeeded: EvidenceNeed[];
  toolPolicy: "forbidden" | "optional" | "required";
  allowedToolGroups: string[];
  forbiddenToolGroups: string[];
  mutationPolicy: "forbidden" | "requires_confirmation" | "allowed_after_confirmation";
  answerDepth: "brief" | "normal" | "deep";
  confidence: "very_high" | "high" | "medium" | "low";
  uncertainty: string[];
  rationale: string[];
};

export function buildTurnPlanFromContract(
  message: string,
  selectedCapabilities?: CapabilityManifestEntry[],
): TurnPlan {
  const contract = determineTaskIntentContract(message);
  const capabilities = selectedCapabilities ?? listAllCapabilities();
  const lowered = message.toLowerCase();
  const uncertainty: string[] = [];
  const rationale: string[] = [];

  for (const reason of contract.reasons) {
    rationale.push(reason);
  }

  const taskType = mapContractToTaskType(contract);
  const evidenceNeeded = mapContractToEvidenceNeeds(contract);

  const allowedToolGroups: string[] = [];
  const forbiddenToolGroups: string[] = [];
  for (const cap of capabilities) {
    if (cap.toolGroups.length === 0) continue;
    if (cap.mutatesState) {
      forbiddenToolGroups.push(...cap.toolGroups);
    }
  }

  if (contract.toolPolicy === "forbidden") {
    // No tools allowed
  } else if (contract.toolPolicy === "required") {
    for (const cap of capabilities) {
      if (cap.mutatesState) continue;
      if (evidenceNeeded.some((need) => cap.evidenceProvided.includes(need))) {
        allowedToolGroups.push(...cap.toolGroups);
      }
    }
  } else {
    for (const cap of capabilities) {
      if (cap.mutatesState) continue;
      allowedToolGroups.push(...cap.toolGroups);
    }
  }

  const mutationPolicy = contract.toolPolicy === "forbidden"
    ? "forbidden"
    : /create|save|build|run|execute|schedule|send|write|mutate/i.test(lowered)
      ? "requires_confirmation"
      : "forbidden";

  const answerDepth: "brief" | "normal" | "deep" =
    /\b(short|brief|quick|concise|one\s+word|one\s+line)\b/i.test(lowered) ? "brief"
    : /\b(deep|thorough|comprehensive|detailed|in\s+detail|investigate|review|audit|plan|design|strategy|architecture|compare|research)\b/i.test(lowered) ? "deep"
    : "normal";

  if (contract.confidence === "low") {
    uncertainty.push("The user's intent could map to multiple evidence sources.");
  }
  if (contract.operation === "compare" && contract.toolPolicy === "optional") {
    uncertainty.push("The user asked to compare but did not specify a source boundary.");
  }

  const userGoal = extractUserGoal(message, contract);

  return {
    userGoal,
    taskType,
    operation: contract.operation,
    evidenceNeeded,
    toolPolicy: contract.toolPolicy,
    allowedToolGroups: Array.from(new Set(allowedToolGroups)).slice(0, 6),
    forbiddenToolGroups: Array.from(new Set(forbiddenToolGroups)).slice(0, 6),
    mutationPolicy,
    answerDepth,
    confidence: contract.confidence === "high" ? "high" : contract.confidence === "medium" ? "medium" : "low",
    uncertainty,
    rationale,
  };
}

function mapContractToTaskType(contract: ReturnType<typeof determineTaskIntentContract>): TaskType {
  if (contract.operation === "compose" || contract.operation === "transform") {
    if (contract.requiresSessionHistory) return "transformation";
    if (contract.requiresProvidedTextOnly) return "composition";
    return contract.toolPolicy === "forbidden" ? "composition" : "mixed";
  }
  if (contract.requiresCurrentFacts) return "web_research";
  if (contract.requiresRepoEvidence) return "repo_inspection";
  if (contract.evidenceSources.includes("benchmark_artifacts")) return "benchmark_artifact_analysis";
  if (contract.requiresSessionHistory) return "session_recall";
  if (contract.toolPolicy === "forbidden") return "direct_answer";
  return "mixed";
}

function mapContractToEvidenceNeeds(contract: ReturnType<typeof determineTaskIntentContract>): EvidenceNeed[] {
  const needs: EvidenceNeed[] = [];
  for (const source of contract.evidenceSources) {
    switch (source) {
      case "provided_text": needs.push("provided_text"); break;
      case "session_history": needs.push("recent_session"); break;
      case "memory": needs.push("durable_memory"); break;
      case "repo_files": needs.push("repo_files"); break;
      case "app_state": needs.push("app_state"); break;
      case "benchmark_artifacts": needs.push("benchmark_artifacts"); break;
      case "current_web": needs.push("current_web"); break;
      case "general_knowledge": needs.push("general_knowledge"); break;
    }
  }
  return Array.from(new Set(needs));
}

function extractUserGoal(message: string, contract: ReturnType<typeof determineTaskIntentContract>): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 77)}...`;
}

export const TURN_PLANNER_SYSTEM_PROMPT = [
  "You are a task-router for disp8ch AI, a personal AI assistant with node-based visual workflow builder.",
  "Your job is to produce a TurnPlan — a structured plan for handling one user turn.",
  "",
  "RULES:",
  "1. Do NOT infer task type from one keyword. 'compare' is an operation, not a route.",
  "2. Decide what evidence is needed before deciding whether tools are required.",
  "3. If the user says 'using only', 'from above', 'from this session', or 'do not search', respect that boundary.",
  "4. If public/current facts, repo behavior, or benchmark artifacts are needed, mark the relevant evidence source.",
  "5. Prefer tools=optional over tools=required when evidence would help but is not strictly required.",
  "6. Require tools only when answering without evidence would be misleading.",
  "7. Choose answerDepth=deep for strategy, debugging, architecture, repo analysis, or quality tasks.",
  "8. Choose answerDepth=brief when asked for short/quick/concise output.",
  "9. mutationPolicy=requires_confirmation for any create/save/schedule/send operation.",
  "10. Output ONLY valid JSON with no additional text.",
].join("\n");

export function shouldUseLlmTurnPlanner(message: string): boolean {
  const contract = determineTaskIntentContract(message);
  if (contract.toolPolicy === "forbidden" && contract.confidence === "high") return false;
  return contract.confidence !== "high" || contract.toolPolicy === "optional";
}

export async function buildTurnPlanWithLlm(params: {
  message: string;
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  fallback?: TurnPlan;
}): Promise<{ plan: TurnPlan; usedLlm: boolean; error?: string; raw?: string }> {
  const fallback = params.fallback ?? buildTurnPlanFromContract(params.message);
  try {
    const result = await callModel({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl ?? undefined,
      systemPrompt: TURN_PLANNER_SYSTEM_PROMPT,
      userMessage: buildTurnPlannerUserPrompt(params.message),
      maxTokens: Math.min(1200, Math.max(600, params.maxTokens ?? 900)),
      temperature: params.temperature ?? 0,
    });
    const plan = parseTurnPlanJson(result.response, fallback);
    return { plan, usedLlm: true, raw: result.response };
  } catch (error) {
    return {
      plan: fallback,
      usedLlm: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTurnPlannerUserPrompt(message: string): string {
  const capabilities = listAllCapabilities()
    .map((cap) => ({
      id: cap.id,
      description: cap.description,
      evidenceProvided: cap.evidenceProvided,
      mutatesState: cap.mutatesState,
      requiresConfirmation: cap.requiresConfirmation,
      toolGroups: cap.toolGroups,
      examples: cap.examples.slice(0, 2),
    }));
  return JSON.stringify({
    userMessage: message,
    capabilities,
    requiredShape: {
      userGoal: "string",
      taskType: [
        "direct_answer",
        "composition",
        "transformation",
        "session_recall",
        "web_research",
        "repo_inspection",
        "app_state_read",
        "app_design",
        "app_mutation_proposal",
        "benchmark_artifact_analysis",
        "mixed",
      ],
      operation: ["answer", "compare", "summarize", "transform", "compose", "research", "inspect", "plan", "design", "act"],
      evidenceNeeded: [
        "provided_text",
        "recent_session",
        "durable_memory",
        "repo_files",
        "app_state",
        "benchmark_artifacts",
        "current_web",
        "general_knowledge",
      ],
      toolPolicy: ["forbidden", "optional", "required"],
      mutationPolicy: ["forbidden", "requires_confirmation", "allowed_after_confirmation"],
      answerDepth: ["brief", "normal", "deep"],
      confidence: ["very_high", "high", "medium", "low"],
    },
  });
}

function parseTurnPlanJson(raw: string, fallback: TurnPlan): TurnPlan {
  const json = extractJsonObject(raw);
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json) as Partial<TurnPlan>;
    return coerceTurnPlan(parsed, fallback);
  } catch {
    return fallback;
  }
}

function extractJsonObject(raw: string): string | null {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function coerceTurnPlan(input: Partial<TurnPlan>, fallback: TurnPlan): TurnPlan {
  const taskTypes: TaskType[] = ["direct_answer", "composition", "transformation", "session_recall", "web_research", "repo_inspection", "app_state_read", "app_design", "app_mutation_proposal", "benchmark_artifact_analysis", "mixed"];
  const operations: Operation[] = ["answer", "compare", "summarize", "transform", "compose", "research", "inspect", "plan", "design", "act"];
  const evidenceNeeds: EvidenceNeed[] = ["provided_text", "recent_session", "durable_memory", "repo_files", "app_state", "benchmark_artifacts", "current_web", "general_knowledge"];
  const toolPolicies: TurnPlan["toolPolicy"][] = ["forbidden", "optional", "required"];
  const mutationPolicies: TurnPlan["mutationPolicy"][] = ["forbidden", "requires_confirmation", "allowed_after_confirmation"];
  const answerDepths: TurnPlan["answerDepth"][] = ["brief", "normal", "deep"];
  const confidences: TurnPlan["confidence"][] = ["very_high", "high", "medium", "low"];

  return {
    userGoal: typeof input.userGoal === "string" && input.userGoal.trim() ? input.userGoal.trim().slice(0, 300) : fallback.userGoal,
    taskType: taskTypes.includes(input.taskType as TaskType) ? input.taskType as TaskType : fallback.taskType,
    operation: operations.includes(input.operation as Operation) ? input.operation as Operation : fallback.operation,
    evidenceNeeded: Array.isArray(input.evidenceNeeded)
      ? input.evidenceNeeded.filter((need): need is EvidenceNeed => evidenceNeeds.includes(need as EvidenceNeed))
      : fallback.evidenceNeeded,
    toolPolicy: toolPolicies.includes(input.toolPolicy as TurnPlan["toolPolicy"]) ? input.toolPolicy as TurnPlan["toolPolicy"] : fallback.toolPolicy,
    allowedToolGroups: Array.isArray(input.allowedToolGroups) ? input.allowedToolGroups.filter((v): v is string => typeof v === "string").slice(0, 8) : fallback.allowedToolGroups,
    forbiddenToolGroups: Array.isArray(input.forbiddenToolGroups) ? input.forbiddenToolGroups.filter((v): v is string => typeof v === "string").slice(0, 8) : fallback.forbiddenToolGroups,
    mutationPolicy: mutationPolicies.includes(input.mutationPolicy as TurnPlan["mutationPolicy"]) ? input.mutationPolicy as TurnPlan["mutationPolicy"] : fallback.mutationPolicy,
    answerDepth: answerDepths.includes(input.answerDepth as TurnPlan["answerDepth"]) ? input.answerDepth as TurnPlan["answerDepth"] : fallback.answerDepth,
    confidence: confidences.includes(input.confidence as TurnPlan["confidence"]) ? input.confidence as TurnPlan["confidence"] : fallback.confidence,
    uncertainty: Array.isArray(input.uncertainty) ? input.uncertainty.filter((v): v is string => typeof v === "string").slice(0, 8) : fallback.uncertainty,
    rationale: Array.isArray(input.rationale) ? input.rationale.filter((v): v is string => typeof v === "string").slice(0, 8) : fallback.rationale,
  };
}
