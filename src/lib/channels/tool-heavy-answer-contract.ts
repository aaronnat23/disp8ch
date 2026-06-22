import type { ToolHeavyTaskPlan } from "@/lib/channels/tool-heavy-task-plan";

export type ToolHeavyAnswerContractResult = {
  ok: boolean;
  issues: string[];
  missingSections: string[];
  evidenceDeficit: boolean;
  gapDeficit: boolean;
  repairInstruction: string;
};

export function evaluateToolHeavyAnswerContract(
  plan: ToolHeavyTaskPlan,
  answer: string,
  evidenceCount: number,
): ToolHeavyAnswerContractResult {
  const issues: string[] = [];
  const missingSections: string[] = [];
  const lowered = answer.toLowerCase();

  // Check required sections
  const sectionChecks: Record<string, RegExp> = {
    evidence_table: /(?:evidence|source|artifact)\s+(?:table|list|items?)/i,
    remaining_gaps: /(?:remaining|unresolved|missing)\s+(?:gaps?|issues?|limitations?)/i,
    prioritized_plan: /(?:priorit|priority|ordered|phased).*(?:plan|roadmap|implementation)/i,
    regression_tests: /(?:regression|test\s+case|test\s+suite|should\s+test|verify)/i,
    uncertainty: /(?:uncertain|not\s+verified|could\s+not\s+verify|unknown|unclear|unsure)/i,
    files_to_touch: /(?:files?\s+to\s+touch|src\/|app\/|lib\/|components?\/)/i,
    db_api_ui_changes: /(?:api|endpoint|route|database|schema|alter\s+table|ui|components?)/i,
    readiness_checks: /(?:readiness|ready|missing\s+key|missing\s+model|budget\s+blocked|agent.*active)/i,
    transcript_persistence: /(?:transcript|persist|store|record|council.*session)/i,
    prompt_schema: /(?:prompt|schema|json|fields?|structured|system\s+prompt)/i,
    risks: /(?:risk|failure|rollback|break|regression)/i,
    tests: /(?:test|regression|verify|should\s+pass|acceptance)/i,
    capability_table: /(?:implemented|configured|available|planned|missing).*(?:image|video|transcript|memory|benchmark)/i,
    file_references: /(?:src\/|app\/|lib\/|tools\.ts|config|\.tsx|\.ts)/i,
    benchmark_artifacts: /(?:benchmark|comparison|artifact|local_llm|result)/i,
    next_comparison_run: /(?:next\s+(?:comparison|run|test)|recommend.*run|should\s+run)/i,
  };

  for (const section of plan.finalAnswerSections) {
    const regex = sectionChecks[section];
    if (!regex || !regex.test(lowered)) {
      missingSections.push(section);
    }
  }

  if (missingSections.length > 0) {
    issues.push(`Missing required sections: ${missingSections.join(", ")}`);
  }

  // Check evidence sufficiency
  const evidenceDeficit = evidenceCount < plan.expectedEvidenceCount;
  if (evidenceDeficit) {
    issues.push(`Evidence deficit: collected ${evidenceCount}/${plan.expectedEvidenceCount} expected items`);
  }

  // Check remaining gaps
  const gapMatches = answer.match(/gap\s*(?:\d+|#|:)/gi) ?? [];
  const hasEnoughGaps = gapMatches.length >= plan.expectedGapCount ||
    /(?:remaining|unresolved)\s+(?:gaps?|limitations?)/i.test(lowered);
  const gapDeficit = !hasEnoughGaps && plan.expectedGapCount > 0;
  if (gapDeficit) {
    issues.push(`Gap deficit: expected ${plan.expectedGapCount} remaining gaps explicitly listed`);
  }

  // Check tool markup leakage
  if (/\b(?:<tool_call|<function_call|TOOL_CATALOG|executeTool\(|<read_file>|<search_files>)/i.test(answer)) {
    issues.push("Raw tool markup leaked into final answer");
  }

  // Build repair instruction
  const repairParts: string[] = ["Tool-heavy answer contract failed.", `Issues: ${issues.join("; ") || "none"}.`];
  if (missingSections.length > 0) {
    repairParts.push(`Add these sections: ${missingSections.join(", ")}.`);
  }
  if (evidenceDeficit) {
    repairParts.push(`Add more concrete file references or source links. Target: ${plan.expectedEvidenceCount}.`);
  }
  if (gapDeficit) {
    repairParts.push(`List at least ${plan.expectedGapCount} specific remaining gaps.`);
  }
  repairParts.push("Repair using only the collected evidence. Do not add new tool calls.");

  return {
    ok: issues.length === 0,
    issues,
    missingSections,
    evidenceDeficit,
    gapDeficit,
    repairInstruction: repairParts.join("\n"),
  };
}
