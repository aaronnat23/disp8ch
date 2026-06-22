import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import { isRepoCriterionAuditRequest } from "@/lib/channels/repo-audit-discipline";
import { isReadOnlyWorkflowInventoryReview } from "@/lib/channels/workflow-readonly-review";

export type UniversalEvidenceKind =
  | "repo"
  | "web"
  | "app_state"
  | "runtime"
  | "files"
  | "current_config"
  | "execution"
  | "user_context";

export type UniversalInvestigationDimension = {
  id: string;
  question: string;
  whyItMatters: string;
  evidenceNeeded: UniversalEvidenceKind[];
  suggestedTools: string[];
  doneCriteria: string;
  priority: "required" | "useful" | "optional";
};

export type UniversalInvestigationPlan = {
  taskSummary: string;
  assumptions: string[];
  dimensions: UniversalInvestigationDimension[];
  sideEffectBoundary: string;
  finalAnswerCriteria: string[];
};

const PLANNER_SYSTEM_PROMPT = `Create an investigation plan for the user's request.
Do not answer the user yet.
Do not use benchmark IDs or memorized test cases.
Identify the dimensions that would make the answer complete and non-misleading.
Include adjacent layers only when they materially affect correctness.
Prefer tools over memory for repo files, current facts, live config, system state, and execution results.
Return compact JSON only with these fields:
taskSummary, assumptions, dimensions, sideEffectBoundary, finalAnswerCriteria.
Each dimension must include id, question, whyItMatters, evidenceNeeded, suggestedTools, doneCriteria, and priority.`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeEvidenceKind(value: string): UniversalEvidenceKind | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "repo" ||
    normalized === "web" ||
    normalized === "app_state" ||
    normalized === "runtime" ||
    normalized === "files" ||
    normalized === "current_config" ||
    normalized === "execution" ||
    normalized === "user_context"
  ) {
    return normalized;
  }
  return null;
}

function normalizePriority(value: unknown): "required" | "useful" | "optional" {
  return value === "required" || value === "optional" ? value : "useful";
}

function addStructuralDimensions(input: {
  plan: UniversalInvestigationPlan;
  message: string;
  toolNames: string[];
}): UniversalInvestigationPlan {
  const ml = input.message.toLowerCase();
  const hasEvidence = (kind: UniversalEvidenceKind) =>
    input.plan.dimensions.some((dimension) => dimension.evidenceNeeded.includes(kind));
  const hasDimension = (id: string) =>
    input.plan.dimensions.some((dimension) => dimension.id === id);
  const dimensions = [...input.plan.dimensions];
  const sourceCategoryRequest =
    /\b(?:source\s+categor|official\s+(?:docs?|sources?)|community\s+(?:reports?|sources?|signal)|third[- ]party|weak\s+(?:or\s+missing\s+)?source|missing\s+(?:source|evidence)|confirmed\s+facts|likely\s+inferences|unknowns)\b/i.test(ml);
  const capabilityStateRequest =
    /\b(?:implemented|configured|callable|available\s+(?:now|right\s+now|currently)|merely\s+planned|planned\s+capabilit|not\s+configured|missing\s+(?:key|secret|model|provider))\b/i.test(ml) &&
    /\b(?:this\s+app|this\s+project|codebase|capabilit|tool|provider|runtime|feature|image|video|voice|stt|transcript|slack|teams|discord|email)\b/i.test(ml);
  const criterionAuditRequest = isRepoCriterionAuditRequest(input.message, input.plan);

  if (
    !hasEvidence("repo") &&
    input.toolNames.some((name) => name === "search_files" || name === "read_file") &&
    /\b(?:repo|repository|codebase|workspace|src\/|server\/|scripts\/|this\s+app|this\s+project|this\s+code|file|function|implementation)\b/i.test(ml)
  ) {
    dimensions.push({
      id: "repo_direct_evidence",
      question: "Which repository files and call paths directly answer the request?",
      whyItMatters: "Repo-facing requests are misleading if they rely on memory or symbol names without reading the actual files.",
      evidenceNeeded: ["repo", "files"],
      suggestedTools: ["search_files", "read_file", "list_files"],
      doneCriteria: "The final answer cites concrete files, functions, and tests or labels any file-level gap.",
      priority: "required",
    });
  }

  if (
    !hasEvidence("web") &&
    input.toolNames.some((name) => name === "web_search" || name === "web_extract" || name === "fetch_url") &&
    /\b(?:current|latest|recent|today|web|online|public|source|citation|link|docs?|documentation)\b/i.test(ml)
  ) {
    dimensions.push({
      id: "current_source_evidence",
      question: "Which current external sources directly support or contradict the answer?",
      whyItMatters: "Current/public claims can become stale and need source-backed verification.",
      evidenceNeeded: ["web"],
      suggestedTools: ["web_search", "web_extract", "fetch_url"],
      doneCriteria: "The final answer cites current sources for major external claims or states what could not be verified.",
      priority: "required",
    });
  }

  if (
    sourceCategoryRequest &&
    !hasDimension("source_category_coverage") &&
    input.toolNames.some((name) => name === "web_search" || name === "web_extract" || name === "fetch_url")
  ) {
    dimensions.push({
      id: "source_category_coverage",
      question: "Which source categories are represented, weak, or missing?",
      whyItMatters: "A research answer can overstate certainty when official, runtime/product, and community evidence are blended together.",
      evidenceNeeded: ["web"],
      suggestedTools: ["web_search", "web_extract", "fetch_url"],
      doneCriteria: "The final answer labels official/primary sources, product/runtime/model docs, community or third-party evidence, and weak or missing categories.",
      priority: "required",
    });
  }

  if (
    capabilityStateRequest &&
    !hasDimension("capability_state_matrix") &&
    input.toolNames.some((name) => name === "search_files" || name === "read_file" || name === "channel_status")
  ) {
    dimensions.push({
      id: "capability_state_matrix",
      question: "For each requested capability, what is implemented, configured/callable now, and planned or missing?",
      whyItMatters: "Capability answers are misleading if code existence is treated as runtime availability or if active fallbacks are hidden.",
      evidenceNeeded: ["repo", "files", "current_config", "app_state"],
      suggestedTools: ["search_files", "read_file", "channel_status", "list_files"],
      doneCriteria: "The final answer includes a status matrix separating implemented code, current configuration/callability, active fallback, and planned or missing pieces with file/config evidence.",
      priority: "required",
    });
  }

  if (
    criterionAuditRequest &&
    !hasDimension("criterion_evidence_matrix") &&
    input.toolNames.some((name) => name === "search_files" || name === "read_file" || name === "list_files")
  ) {
    dimensions.unshift({
      id: "criterion_evidence_matrix",
      question: "For each requested criterion, what source/code evidence and test/verification evidence proves, partially proves, or fails to prove it?",
      whyItMatters: "Release/readiness answers are misleading when broad repository evidence is not mapped back to each criterion.",
      evidenceNeeded: ["repo", "files"],
      suggestedTools: ["search_files", "read_file", "list_files"],
      doneCriteria: "The final answer includes a compact criterion table with status, code evidence, test evidence, and gaps for every criterion.",
      priority: "required",
    });
  }

  const automationStateRequest =
    /\b(?:webhook|cron|schedule|automation|automations)\b/i.test(ml) &&
    /\b(?:list|show|current|existing|what|which|my|all|any|status|active|enabled|configured|live)\b/i.test(ml) &&
    !hasEvidence("app_state") &&
    !hasDimension("automation_live_state") &&
    input.toolNames.some((name) => name === "webhooks_list" || name === "schedules_list");

  if (automationStateRequest) {
    dimensions.push({
      id: "automation_live_state",
      question: "What webhook automations and cron schedules currently exist in the live app database?",
      whyItMatters: "Automation queries must reflect the live DB state, not source code descriptions. Only tool output is authoritative.",
      evidenceNeeded: ["app_state", "runtime"],
      suggestedTools: ["webhooks_list", "schedules_list"],
      doneCriteria: "The answer reports actual webhook names, URLs, active status, and cron job names/expressions from tool output, not from source code.",
      priority: "required",
    });
  }

  if (
    isReadOnlyWorkflowInventoryReview(input.message, input.plan) &&
    !hasDimension("workflow_inventory_review") &&
    input.toolNames.some((name) => name === "workflow_list")
  ) {
    dimensions.unshift({
      id: "workflow_inventory_review",
      question: "Which current workflows exist, and which ones are candidates for consolidation or cleanup without making changes?",
      whyItMatters: "Workflow cleanup advice should be based on the live workflow inventory, not assumptions or template examples.",
      evidenceNeeded: ["app_state", "runtime"],
      suggestedTools: ["workflow_list", "workflow_get"],
      doneCriteria: "The final answer uses workflow_list output as authoritative, avoids mutations, and separates inventory facts from consolidation suggestions.",
      priority: "required",
    });
  }

  return { ...input.plan, dimensions: dimensions.slice(0, 8) };
}

function normalizePlan(value: unknown, message: string, toolNames: string[]): UniversalInvestigationPlan | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const dimensionsRaw = Array.isArray(obj.dimensions) ? obj.dimensions : [];
  const dimensions = dimensionsRaw
    .map((dimension, index): UniversalInvestigationDimension | null => {
      if (!dimension || typeof dimension !== "object") return null;
      const d = dimension as Record<string, unknown>;
      const evidenceNeeded = asStringArray(d.evidenceNeeded)
        .map(normalizeEvidenceKind)
        .filter((kind): kind is UniversalEvidenceKind => kind !== null);
      return {
        id: typeof d.id === "string" && d.id.trim() ? d.id.trim() : `dimension_${index + 1}`,
        question: typeof d.question === "string" && d.question.trim() ? d.question.trim() : "What evidence is needed?",
        whyItMatters: typeof d.whyItMatters === "string" ? d.whyItMatters.trim() : "",
        evidenceNeeded: evidenceNeeded.length > 0 ? evidenceNeeded : ["user_context"],
        suggestedTools: asStringArray(d.suggestedTools),
        doneCriteria: typeof d.doneCriteria === "string" && d.doneCriteria.trim()
          ? d.doneCriteria.trim()
          : "Enough evidence exists to answer without misleading the user.",
        priority: normalizePriority(d.priority),
      };
    })
    .filter((dimension): dimension is UniversalInvestigationDimension => dimension !== null)
    .slice(0, 7);

  if (dimensions.length === 0) return null;

  return addStructuralDimensions({
    message,
    toolNames,
    plan: {
    taskSummary: typeof obj.taskSummary === "string" && obj.taskSummary.trim()
      ? obj.taskSummary.trim()
      : message.slice(0, 240),
    assumptions: asStringArray(obj.assumptions).slice(0, 5),
    dimensions,
    sideEffectBoundary: typeof obj.sideEffectBoundary === "string" && obj.sideEffectBoundary.trim()
      ? obj.sideEffectBoundary.trim()
      : "Do not perform irreversible side effects unless the user explicitly requested them and the available tools allow it.",
    finalAnswerCriteria: asStringArray(obj.finalAnswerCriteria).slice(0, 8),
    },
  });
}

export function buildFallbackUniversalPlan(message: string): UniversalInvestigationPlan {
  const ml = message.toLowerCase();
  const likelyRepo = /\b(?:repo|repository|codebase|workspace|src\/|server\/|scripts\/|this\s+app|this\s+project|this\s+code|file|function|implementation)\b/i.test(message);
  const likelyWebResearch = /\b(?:research|current|latest|recent|today|web|online|public|official|community|source|sources|citation|link|docs?|documentation|guidance|reports?)\b/i.test(message);
  const capabilityStateRequest =
    /\b(?:implemented|configured|callable|available\s+(?:now|right\s+now|currently)|merely\s+planned|planned\s+capabilit|not\s+configured|missing\s+(?:key|secret|model|provider))\b/i.test(message) &&
    /\b(?:this\s+app|this\s+project|codebase|capabilit|tool|provider|runtime|feature|image|video|voice|stt|transcript|slack|teams|discord|email)\b/i.test(message);

  if (likelyWebResearch && !likelyRepo) {
    return {
      taskSummary: message.slice(0, 240),
      assumptions: ["Treat this as an external evidence-gathering task and separate source categories rather than filling gaps from memory."],
      sideEffectBoundary: "Keep actions read-only; only gather public evidence and synthesize it.",
      finalAnswerCriteria: [
        "Answer the user's actual research question directly.",
        "Separate official documentation, model/runtime documentation, and community or third-party reports when requested or relevant.",
        "Cite sources for major external claims.",
        "State weak or missing source categories plainly.",
        "Preserve concrete setup details, risks, and tradeoffs found in evidence.",
      ],
      dimensions: [
        {
          id: "official_sources",
          question: "What official or primary sources directly answer the user's question?",
          whyItMatters: "Official sources establish what is actually supported and prevent community claims from being over-weighted.",
          evidenceNeeded: ["web"],
          suggestedTools: ["web_search", "web_extract", "fetch_url"],
          doneCriteria: "Official or primary source claims are cited, or their absence is explicitly reported.",
          priority: "required",
        },
        {
          id: "runtime_or_product_sources",
          question: "What product, model, runtime, or setup documentation constrains the practical recommendation?",
          whyItMatters: "Practical setup advice needs model/runtime limits, platform constraints, and configuration details, not only high-level docs.",
          evidenceNeeded: ["web"],
          suggestedTools: ["web_search", "web_extract", "fetch_url"],
          doneCriteria: "The answer includes concrete constraints and setup details from relevant documentation or labels them missing.",
          priority: "required",
        },
        {
          id: "community_or_field_reports",
          question: "What non-official reports, issues, or community evidence confirm risks, failures, or real-world feasibility?",
          whyItMatters: "Community reports surface practical failures and caveats that official docs often omit.",
          evidenceNeeded: ["web"],
          suggestedTools: ["web_search", "web_extract", "fetch_url"],
          doneCriteria: "Non-official evidence is summarized separately from confirmed official facts, or the missing category is stated.",
          priority: "useful",
        },
        {
          id: "missing_evidence",
          question: "Which requested source categories or concrete facts remain weak or unverified?",
          whyItMatters: "Research answers should not imply certainty when a source category could not be verified.",
          evidenceNeeded: ["user_context"],
          suggestedTools: [],
          doneCriteria: "Known gaps and unsupported inferences are named in the final answer.",
          priority: "required",
        },
      ],
    };
  }

  if (likelyRepo || capabilityStateRequest) {
    if (capabilityStateRequest) {
      return {
        taskSummary: message.slice(0, 240),
        assumptions: ["Treat this as a capability/status audit and inspect actual implementation plus runtime configuration before finalizing."],
        sideEffectBoundary: "Keep actions read-only. Do not run paid provider calls, download models, or perform side effects unless the user explicitly confirms them.",
        finalAnswerCriteria: [
          "Answer whether each requested capability is available now.",
          "Separate implemented/code exists from configured/callable now and planned or missing work.",
          "Identify active fallbacks separately from native/provider-backed capability.",
          "Cite concrete files, config/app-state evidence, and unknowns.",
          "Do not treat benchmark artifacts or roadmap text as current runtime availability.",
        ],
        dimensions: [
          {
            id: "capability_state_matrix",
            question: "For each requested capability, what is implemented, configured/callable now, and planned or missing?",
            whyItMatters: "Capability answers are misleading if code existence is treated as runtime availability or if active fallbacks are hidden.",
            evidenceNeeded: ["repo", "files", "current_config", "app_state"],
            suggestedTools: ["search_files", "read_file", "channel_status", "list_files"],
            doneCriteria: "The final answer includes a status matrix separating implemented code, current configuration/callability, active fallback, and planned or missing pieces with file/config evidence.",
            priority: "required",
          },
          {
            id: "cost_and_side_effect_boundary",
            question: "Would proving the capability require paid provider calls, model downloads, account actions, or other side effects?",
            whyItMatters: "A status audit should avoid spending money or mutating the system when the user only asked for inspection.",
            evidenceNeeded: ["repo", "current_config", "app_state"],
            suggestedTools: ["search_files", "read_file", "channel_status"],
            doneCriteria: "The final answer states which checks were inspection-only and which runtime proof would require explicit confirmation.",
            priority: "required",
          },
          {
            id: "verification_path",
            question: "What focused non-destructive test would prove the status after configuration is added?",
            whyItMatters: "The user needs a clear next check without accidental paid calls or downloads.",
            evidenceNeeded: ["repo", "execution"],
            suggestedTools: ["search_files"],
            doneCriteria: "The final answer includes safe verification commands or acceptance criteria, or labels why no safe check was run.",
            priority: "useful",
          },
        ],
      };
    }

    const repoDimensions: UniversalInvestigationDimension[] = [
      {
        id: "repo_direct_evidence",
        question: "Which repository files and call paths directly answer the request?",
        whyItMatters: "Repo-facing requests are misleading if they rely on memory or symbol names without reading actual files.",
        evidenceNeeded: ["repo", "files"],
        suggestedTools: ["search_files", "read_file", "list_files"],
        doneCriteria: "The final answer cites concrete files, functions, and tests or labels any file-level gap.",
        priority: "required",
      },
      {
        id: "behavior_contract",
        question: "What behavioral contract or invariant should the implementation satisfy?",
        whyItMatters: "A repo-grounded plan should explain what behavior changes, not just which files exist.",
        evidenceNeeded: ["repo", "files"],
        suggestedTools: ["search_files", "read_file"],
        doneCriteria: "The answer maps current behavior to a stricter contract or clear next action.",
        priority: "required",
      },
      {
        id: "verification",
        question: "Which tests or checks would prove the answer or proposed change?",
        whyItMatters: "Implementation advice is incomplete without targeted verification.",
        evidenceNeeded: ["repo", "execution"],
        suggestedTools: ["search_files"],
        doneCriteria: "The final answer includes existing or proposed regression tests.",
        priority: "required",
      },
    ];
    const repoCriteria = [
      "Name the files and functions that support the answer.",
      "Separate observed implementation from proposed improvement.",
      "Include concrete acceptance criteria and regression tests when the user asks for a plan.",
      "State any repo areas that were not inspected.",
    ];
    if (isRepoCriterionAuditRequest(message)) {
      repoDimensions.unshift({
        id: "criterion_evidence_matrix",
        question: "For each requested criterion, what source/code evidence and test/verification evidence proves, partially proves, or fails to prove it?",
        whyItMatters: "Release/readiness answers are misleading when broad repository evidence is not mapped back to each criterion.",
        evidenceNeeded: ["repo", "files"],
        suggestedTools: ["search_files", "read_file", "list_files"],
        doneCriteria: "The final answer includes a compact criterion table with status, code evidence, test evidence, and gaps for every criterion.",
        priority: "required",
      });
      repoCriteria.push(
        "Map every criterion to proven, partial, not proven, or blocked.",
        "Include exact repo-native Windows verification commands when requested.",
      );
    }

    return {
      taskSummary: message.slice(0, 240),
      assumptions: ["Treat this as a repository-grounded request and inspect actual files before finalizing."],
      sideEffectBoundary: "Keep actions read-only unless the user explicitly requested code changes and write tools are available.",
      finalAnswerCriteria: repoCriteria,
      dimensions: repoDimensions,
    };
  }

  return {
    taskSummary: message.slice(0, 240),
    assumptions: ["Proceed with a reasonable interpretation of the request when the needed context can be gathered with tools."],
    sideEffectBoundary: "Keep actions read-only unless the user explicitly requested workspace changes and write tools are available.",
    finalAnswerCriteria: [
      "Answer the user's actual request directly.",
      "Ground factual claims in gathered evidence when tools are available.",
      "State important unknowns or unsupported claims plainly.",
    ],
    dimensions: [
      {
        id: "understand_request",
        question: "What outcome is the user asking for?",
        whyItMatters: "The investigation should optimize for the user's real goal, not a generic answer.",
        evidenceNeeded: ["user_context"],
        suggestedTools: [],
        doneCriteria: "The requested outcome and constraints are clear enough to proceed.",
        priority: "required",
      },
      {
        id: "gather_direct_evidence",
        question: "What direct evidence would make the answer accurate?",
        whyItMatters: "Non-trivial answers need verification from available sources rather than memory alone.",
        evidenceNeeded: ["repo", "web", "files", "runtime", "current_config"],
        suggestedTools: ["search_files", "read_file", "web_search", "web_extract"],
        doneCriteria: "The answer has direct evidence for its main claims or clearly labels gaps.",
        priority: "required",
      },
      {
        id: "verify_final_answer",
        question: "What would make the final answer complete and non-misleading?",
        whyItMatters: "The final answer should include caveats, assumptions, and next steps when needed.",
        evidenceNeeded: ["user_context", "execution"],
        suggestedTools: [],
        doneCriteria: "The final answer satisfies the user's constraints without hiding uncertainty.",
        priority: "required",
      },
    ],
  };
}

export function formatUniversalPlanForPrompt(plan: UniversalInvestigationPlan): string {
  const dimensions = plan.dimensions
    .map((dimension) => {
      return [
        `- ${dimension.id} (${dimension.priority})`,
        `  Question: ${dimension.question}`,
        `  Evidence: ${dimension.evidenceNeeded.join(", ")}`,
        `  Done: ${dimension.doneCriteria}`,
      ].join("\n");
    })
    .join("\n");

  return [
    "Investigation plan:",
    `Task: ${plan.taskSummary}`,
    plan.assumptions.length ? `Assumptions: ${plan.assumptions.join("; ")}` : "Assumptions: none yet",
    `Side-effect boundary: ${plan.sideEffectBoundary}`,
    "Dimensions:",
    dimensions,
    plan.finalAnswerCriteria.length
      ? `Final answer criteria: ${plan.finalAnswerCriteria.join("; ")}`
      : "Final answer criteria: answer directly, with evidence and caveats.",
  ].join("\n");
}

export async function createUniversalInvestigationPlan(input: {
  message: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  toolNames?: string[];
  taskHints?: Record<string, unknown>;
}): Promise<{ plan: UniversalInvestigationPlan; usedFallback: boolean; raw?: string }> {
  const toolNames = input.toolNames ?? [];
  try {
    const result = await callModel({
      provider: input.provider as ModelProvider,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userMessage: [
        `User request:\n${input.message}`,
        toolNames.length ? `Available tool names:\n${toolNames.join(", ")}` : "",
        input.taskHints ? `Runtime task hints:\n${JSON.stringify(input.taskHints)}` : "",
      ].filter(Boolean).join("\n\n"),
      maxTokens: 1400,
      temperature: 0.1,
    });
    const parsed = JSON.parse(stripJsonFence(result.response));
    const plan = normalizePlan(parsed, input.message, toolNames);
    if (plan) return { plan, usedFallback: false, raw: result.response };
    return { plan: buildFallbackUniversalPlan(input.message), usedFallback: true, raw: result.response };
  } catch (error) {
    return {
      plan: buildFallbackUniversalPlan(input.message),
      usedFallback: true,
      raw: error instanceof Error ? error.message : String(error),
    };
  }
}
