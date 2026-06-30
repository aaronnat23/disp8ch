import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";

export type FinalSynthesisContractType =
  | "repo_audit"
  | "web_research"
  | "capability_audit"
  | "workflow_review"
  | "computer_observation"
  | "general";

export type FinalSynthesisContract = {
  type: FinalSynthesisContractType;
  requiredSignals: string[];
  instructions: string;
};

export type FinalSynthesisValidation = {
  ok: boolean;
  missingSignals: string[];
};

function textFrom(input: {
  message: string;
  taskHints?: Record<string, unknown>;
  plan?: UniversalInvestigationPlan | null;
}): string {
  return [
    input.message,
    input.plan?.taskSummary ?? "",
    input.plan?.finalAnswerCriteria.join(" ") ?? "",
    input.plan?.dimensions.map((dimension) => `${dimension.id} ${dimension.doneCriteria}`).join(" ") ?? "",
    JSON.stringify(input.taskHints ?? {}),
  ].join("\n");
}

export function detectSynthesisContract(input: {
  message: string;
  taskHints?: Record<string, unknown>;
  plan?: UniversalInvestigationPlan | null;
}): FinalSynthesisContract {
  const text = textFrom(input);
  const lower = text.toLowerCase();
  const hasWorkflowReview =
    /\bworkflow_inventory_review\b/.test(lower) ||
    (/\b(?:review|audit|inspect|consolidat|cleanup|clean\s+up)\b/i.test(text) &&
      /\bworkflows?\b/i.test(text) &&
      /\b(?:do\s+not|without|don't|dont|read[-\s]?only|no\s+changes?)\b/i.test(text));
  const hasCapabilityAudit =
    /\bcapability_state_matrix\b/.test(lower) ||
    (/\b(?:implemented|configured|callable|available\s+(?:now|currently)|planned|missing)\b/i.test(text) &&
      /\b(?:capabilit|feature|tool|provider|runtime|image|video|mcp|parallel|voice|workflow)\b/i.test(text));
  const hasRepoAudit =
    /\b(?:repo_direct_evidence|criterion_evidence_matrix|repository|codebase|src\/|scripts\/|file-level|release-ready|readiness|implementation)\b/i.test(text) ||
    /\b(?:inspect|audit|verify|review)\b[\s\S]{0,120}\b(?:repo|repository|codebase|implementation|tests?)\b/i.test(text);
  const hasWebResearch =
    /\b(?:current_source_evidence|source_category_coverage|official\s+(?:docs?|sources?)|community|third[- ]party|latest|current|web|online|source\s+links?|citations?)\b/i.test(text);
  const explicitlyRequestsCapabilityState =
    /\b(?:implemented|configured|callable|available\s+(?:now|currently)|planned|missing)\b/i.test(input.message) &&
    /\b(?:capabilit|feature|tool|provider|runtime|image|video|mcp|parallel|voice|workflow)\b/i.test(input.message);
  const isComputerObservation =
    input.taskHints?.originalMode === "computer_use" ||
    (Array.isArray(input.taskHints?.requestedSurfaces) && input.taskHints.requestedSurfaces.includes("computer_use"));

  if (isComputerObservation) {
    return {
      type: "computer_observation",
      requiredSignals: ["direct_answer", "tool_evidence", "verification_state"],
      instructions: buildFinalSynthesisInstructions({ type: "computer_observation" }),
    };
  }

  if (hasWorkflowReview) {
    return {
      type: "workflow_review",
      requiredSignals: ["no_mutation_boundary", "inventory_evidence", "recommendations"],
      instructions: buildFinalSynthesisInstructions({ type: "workflow_review" }),
    };
  }
  if (explicitlyRequestsCapabilityState) {
    return {
      type: "capability_audit",
      requiredSignals: ["implemented", "configured_or_callable", "planned_or_missing", "evidence"],
      instructions: buildFinalSynthesisInstructions({ type: "capability_audit" }),
    };
  }
  if (hasRepoAudit) {
    return {
      type: "repo_audit",
      requiredSignals: ["direct_recommendation", "file_or_no_file_evidence", "proven_inferred_unknown", "next_tests"],
      instructions: buildFinalSynthesisInstructions({ type: "repo_audit" }),
    };
  }
  if (hasWebResearch && !explicitlyRequestsCapabilityState) {
    return {
      type: "web_research",
      requiredSignals: ["direct_answer", "source_categories", "links_or_missing_sources", "unknowns"],
      instructions: buildFinalSynthesisInstructions({ type: "web_research" }),
    };
  }
  if (hasCapabilityAudit) {
    return {
      type: "capability_audit",
      requiredSignals: ["implemented", "configured_or_callable", "planned_or_missing", "evidence"],
      instructions: buildFinalSynthesisInstructions({ type: "capability_audit" }),
    };
  }
  if (hasWebResearch) {
    return {
      type: "web_research",
      requiredSignals: ["direct_answer", "source_categories", "links_or_missing_sources", "unknowns"],
      instructions: buildFinalSynthesisInstructions({ type: "web_research" }),
    };
  }
  return {
    type: "general",
    requiredSignals: ["direct_answer"],
    instructions: buildFinalSynthesisInstructions({ type: "general" }),
  };
}

export function buildFinalSynthesisInstructions(input: { type: FinalSynthesisContractType }): string {
  switch (input.type) {
    case "repo_audit":
      return [
        "Final synthesis contract: repo audit.",
        "The first non-empty line must be a verdict sentence, not a title or table. Start with 'Recommendation:', 'Yes:', 'No:', 'Release-ready:', or 'Not release-ready:'.",
        "Include concrete file paths, function/script names, or say explicitly that file-level evidence was unavailable.",
        "Separate evidence under explicit labels: Proven, Inferred, and Unknown.",
        "List the top residual risks and exact repo-native verification commands/tests.",
        "Prefer a compact evidence table over long prose.",
      ].join("\n");
    case "web_research":
      return [
        "Final synthesis contract: web research.",
        "The first non-empty line must be the direct practical answer or recommendation, not a title or table. Start with 'Use:', 'Recommendation:', 'Yes:', or 'No:'.",
        "Label source quality: official/source-of-truth, product/runtime docs, community/third-party, and weak or missing evidence.",
        "Include visible source URLs when web evidence exists; if an expected source category is missing, say so.",
        "Separate evidence under explicit labels: Proven, Inferred, and Unknown.",
      ].join("\n");
    case "capability_audit":
      return [
        "Final synthesis contract: capability audit.",
        "The first non-empty line must directly answer whether the requested capabilities are usable now. Start with 'Implemented:', 'Configured:', 'Missing:', or 'Recommendation:'.",
        "Use a compact status matrix.",
        "Separate implemented/code exists, configured/callable now, active fallback, and planned/missing.",
        "Cite source/config/app-state evidence. Do not use prior comparison artifacts as runtime proof.",
      ].join("\n");
    case "workflow_review":
      return [
        "Final synthesis contract: read-only workflow review.",
        "Start by saying no workflows were created, edited, run, scheduled, or deleted.",
        "Use live workflow inventory as the evidence basis.",
        "Separate inventory facts from consolidation/cleanup recommendations.",
        "Give concise next actions and tests without applying changes.",
      ].join("\n");
    case "computer_observation":
      return [
        "Final synthesis contract: computer observation.",
        "Answer in at most six short lines unless the user requests detail.",
        "State the observed result first, then the direct UI evidence and any important unknown.",
        "Do not add repository paths, verification commands, recommendations, or generic risk sections.",
        "Treat executed_unverified as dispatched, not completed. Treat an approval boundary as pending, not executed.",
      ].join("\n");
    default:
      return [
        "Final synthesis contract: general.",
        "Answer directly first, cite concrete evidence when available, and state important unknowns plainly.",
        "Keep the final answer concise enough to act on.",
      ].join("\n");
  }
}

export function validateFinalSynthesisShape(answer: string, contract: FinalSynthesisContract): FinalSynthesisValidation {
  const missingSignals: string[] = [];
  const text = answer || "";
  const lower = text.toLowerCase();
  const hasPath = /\b(?:src|server|scripts|docs|data|app|components|lib)\/[\w./()[\]-]+|\b[\w.-]+\.(?:ts|tsx|js|mjs|md|json)\b/.test(text);
  const saysNoFileEvidence = /\b(?:no|not enough|missing|unavailable|could not)\b[\s\S]{0,80}\b(?:file|repo|source|evidence)\b/i.test(text);
  const hasUrl = /https?:\/\/[^\s)]+/i.test(text);
  const firstLine = text.split(/\n+/).find((line) => line.trim().length > 0)?.trim() ?? "";
  const hasActionDirectOpening = firstLine.length > 0 &&
    !/^(?:sure|here(?:'s| is)|i can|#{1,6}\s|\|)/i.test(firstLine) &&
    /\b(?:yes|no|recommend|recommendation|release-ready|not release-ready|implemented|missing|configured|callable|use|do not use|good enough|not enough|best|current|practical)\b/i.test(firstLine);
  const hasWorkflowNoMutationOpening = firstLine.length > 0 &&
    !/^(?:sure|here(?:'s| is)|i can|#{1,6}\s|\|)/i.test(firstLine) &&
    /\b(?:not\s+(?:created|edited|changed|run|scheduled|deleted|saved)|no\s+workflows?)\b/i.test(firstLine);
  const hasDirectOpening = contract.type === "computer_observation"
    ? firstLine.length > 0 && !/^(?:sure|here(?:'s| is)|i can|#{1,6}\s|\|)/i.test(firstLine)
    : contract.type === "workflow_review"
    ? hasActionDirectOpening || hasWorkflowNoMutationOpening
    : hasActionDirectOpening;

  if (!hasDirectOpening) missingSignals.push("direct_answer");

  if (contract.type === "repo_audit") {
    if (!hasDirectOpening) missingSignals.push("direct_recommendation");
    if (!hasPath && !saysNoFileEvidence) missingSignals.push("file_or_no_file_evidence");
    if (!/\bproven\b/i.test(text) || !/\binferred\b/i.test(text) || !/\bunknown\b/i.test(text)) missingSignals.push("proven_inferred_unknown");
    if (!/\b(?:pnpm\.cmd|npm|tsx|tsc|playwright|test|verify|verification|command)\b/i.test(text)) missingSignals.push("next_tests");
  }

  if (contract.type === "web_research") {
    if (!/\b(?:official|primary|source[- ]of[- ]truth|runtime|documentation|community|third[- ]party|missing|weak)\b/i.test(text)) {
      missingSignals.push("source_categories");
    }
    if (!hasUrl && !/\b(?:source|url|link).{0,60}(?:missing|unavailable|not found|weak)\b/i.test(text)) {
      missingSignals.push("links_or_missing_sources");
    }
    if (!/\bproven\b/i.test(text) || !/\binferred\b/i.test(text) || !/\bunknown\b/i.test(text)) missingSignals.push("unknowns");
  }

  if (contract.type === "capability_audit") {
    if (!/\bimplemented\b/i.test(text)) missingSignals.push("implemented");
    if (!/\b(?:configured|callable|available now|active|api key|secret|runtime)\b/i.test(text)) missingSignals.push("configured_or_callable");
    if (!/\b(?:planned|missing|not implemented|fallback|partial|roadmap)\b/i.test(text)) missingSignals.push("planned_or_missing");
    if (!hasPath && !/\bevidence\b/i.test(text)) missingSignals.push("evidence");
  }

  if (contract.type === "workflow_review") {
    if (!/\b(?:not|no)\b[\s\S]{0,80}\b(?:created|edited|changed|run|scheduled|deleted|saved)\b/i.test(text)) {
      missingSignals.push("no_mutation_boundary");
    }
    if (!/\b(?:workflow inventory|workflows?\s+\(|active workflows?|workflow list|live app state)\b/i.test(text)) {
      missingSignals.push("inventory_evidence");
    }
    if (!/\b(?:recommend\w*|consolidat\w*|cleanup|clean up|next action\w*|candidate\w*)\b/i.test(text)) {
      missingSignals.push("recommendations");
    }
  }

  if (contract.type === "computer_observation") {
    if (!/\b(?:observed|window|screen|desktop|browser|approval|blocked|dispatched|verified|status|heading|field|button|app)\b/i.test(text)) {
      missingSignals.push("tool_evidence");
    }
    if (!/\b(?:verified|unverified|unknown|approval|blocked|read-only|read only|observed|not found|could not)\b/i.test(text)) {
      missingSignals.push("verification_state");
    }
  }

  return { ok: missingSignals.length === 0, missingSignals };
}
