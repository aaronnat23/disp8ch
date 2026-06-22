export type DeepAuditKind =
  | "root_cause"
  | "architecture_trace"
  | "quality_gap"
  | "comparison_gap"
  | "implementation_plan"
  | "regression_design";

export type DeepAuditSection =
  | "pipeline_or_trace"
  | "evidence_table"
  | "failure_gates"
  | "hollow_example"
  | "fix_contract"
  | "regression_tests"
  | "remaining_gaps"
  | "uncertainty";

export type DepthTier = "normal" | "thorough" | "exhaustive";

export type DeepAuditProfile = {
  enabled: boolean;
  kind: DeepAuditKind | null;
  confidence: "high" | "medium" | "low";
  depthTier: DepthTier;
  requiredSections: DeepAuditSection[];
  evidenceFocus: Array<"call_chain" | "contracts" | "tests" | "configs" | "artifacts" | "web_sources">;
  minVerifiedReads: number;
  minSearches: number;
  synthesisBudget: "normal" | "expanded";
  reasons: string[];
};

const AUDIT_PATTERNS: Array<{ pattern: RegExp; kind: DeepAuditKind; confidence: "high" | "medium" | "low" }> = [
  // Root cause
  { pattern: /\broot\s+cause\b|\bwhy\s+(?:does|is|are)\b.*\b(?:fail|slow|break|crash|time\s*out|hang)\b/i, kind: "root_cause", confidence: "high" },
  { pattern: /\bexplain\s+why\b.*\b(?:pass|fail|shallow|deep|missing|wrong)\b/i, kind: "root_cause", confidence: "medium" },

  // Tool loop / no-progress failure
  { pattern: /\b(?:no[-\s]?progress|kept\s+calling|stuck\s+in\s+loop|tool\s+loop|never\s+synthesi[sz]ed)\b/i, kind: "root_cause", confidence: "high" },
  { pattern: /\b(?:agent\s+trace|trace\s+failed|why\s+did\s+it\s+keep)\b.*\b(?:call|try|retry|repeat|loop|fail)\b/i, kind: "root_cause", confidence: "high" },
  { pattern: /\b(?:tool\s+budget|exceeded\s+budget|too\s+many\s+(?:tool\s+)?calls?|ran\s+out\s+of)\b/i, kind: "root_cause", confidence: "medium" },

  // Markup leakage / raw tool output
  { pattern: /\b(?:raw\s+markup|xml\s+tags?|dsml|tool\s+schema\s+leak|markup\s+leak)\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:tool\s+output\s+leak|raw\s+tool\s+trace|leaked\s+(?:tool|xml|dsml))\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:why.*leak|why.*raw|why.*xml|prevent.*(?:leak|raw|xml|dsml))\b/i, kind: "quality_gap", confidence: "medium" },
  
  // Architecture trace  
  { pattern: /\b(?:pipeline|call\s+chain|data\s+flow|control\s+flow|entry\s+point|trace\s+the)\b.*\b(?:trace|follow|map|inspect|from.*to)\b/i, kind: "architecture_trace", confidence: "high" },
  { pattern: /\bhow\s+(?:does|is)\b.*\b(?:route|work|handle|process|execut)\b.*\b(?:exactly|step|flow)\b/i, kind: "architecture_trace", confidence: "medium" },
  
  // Quality gap
  { pattern: /\b(?:quality\s+gap|remaining\s+gap|why.*better|what\s+makes.*better|compare.*and\s+explain.*remaining)\b/i, kind: "comparison_gap", confidence: "high" },
  { pattern: /\b(?:propose|suggest|design)\b.*\b(?:stricter\s+contract|better\s+contract|improved\s+gate)\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:where|how)\b.*\b(?:grounding|evidence|contract)\b.*\b(?:enforced|checked|validated)\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:propose|suggest|recommend)\b.*\bimprovement\b.*\b(?:shallow|grounding|evidence|contract|regression)\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:shallow\s+answer|pass\s+metadata.*shallow|hollow)\b/i, kind: "quality_gap", confidence: "high" },
  { pattern: /\b(?:why.*pass.*fail|why.*shallow|what.*missing.*check)\b/i, kind: "quality_gap", confidence: "medium" },
  
  // Comparison gap
  { pattern: /\b(?:compare|versus|vs\.?)\b.*\b(?:both\s+(?:apps?|agents?|systems?|implementations?)|difference|gap)\b/i, kind: "comparison_gap", confidence: "high" },
  { pattern: /\bwhat\s+(?:is|are)\s+the\s+(?:remaining|current)\s+(?:gap|difference)\b/i, kind: "comparison_gap", confidence: "high" },
  
  // Implementation plan
  { pattern: /\b(?:implementation\s+plan|files?\s+to\s+touch|create\s+a\s+minimal\s+plan)\b/i, kind: "implementation_plan", confidence: "high" },
  { pattern: /\b(?:plan|design)\b.*\b(?:tests?|acceptance|rollout)\b.*\b(?:do\s+not\s+implement|read\s*.?only)\b/i, kind: "implementation_plan", confidence: "medium" },
  
  // Regression design
  { pattern: /\b(?:regression\s+tests?|test\s+cases?|test\s+suite)\b.*\b(?:design|create|propos|add|include)\b/i, kind: "regression_design", confidence: "high" },
  { pattern: /\b(?:design|create|propos|add)\s+(?:regression\s+tests?|test\s+cases?)\b/i, kind: "regression_design", confidence: "high" },
  { pattern: /\b(?:should\s+test|need\s+to\s+test|verify\s+that)\b.*\b(?:regression|coverage|acceptance)\b/i, kind: "regression_design", confidence: "medium" },
];

const EXHAUSTIVE_PATTERNS = [
  /\b(?:deep|exhaustive|comprehensive|full)\s+(?:audit|inspection|analysis|review|investigation)\b/i,
  /\b(?:root\s+cause|call\s+chain|data\s+flow|architecture\s+trace)\b.*\b(?:complete|detailed|thorough|exhaustive)\b/i,
  /\b(?:compare|versus|vs\.?|benchmark|parity)\b.*\b(?:both\s+(?:apps?|agents?|systems?|implementations?)|multiple\s+(?:apps?|systems?))\b.*\b(?:detailed|full|complete|exhaustive)\b/i,
  /\b(?:files?\s+to\s+touch|risks?|tests?|acceptance\s+criteria)\b.*\b(?:implementation\s+plan|fix\s+plan|upgrade\s+plan)\b/i,
  /\b(?:exhaustive|comprehensive)\s+(?:list|table|breakdown|summary)\b/i,
  /\b(?:trace|map)\s+(?:every|all|the\s+full)\s+(?:call|path|route|flow)\b/i,
];

const EXCLUDE_PATTERNS = [
  /\b(?:brief|short|quick|concise|one\s+word|one\s+line|simple)\b/i,
  /\bdo\s+not\s+(?:inspect|read|search|modif)\b/i,
  /\b(?:create|save|run|execute|schedule|send|delete)\b.*\b(?:task|workflow|board|schedule)\b/i,
  /\b(?:list|show|what)\s+(?:agents?|models?|tools?|templates?|workflows?)\s*(?:\?|$)/i,
];

function sectionByKind(kind: DeepAuditKind): DeepAuditSection[] {
  switch (kind) {
    case "root_cause":
      return ["pipeline_or_trace", "failure_gates", "fix_contract", "regression_tests", "uncertainty"];
    case "architecture_trace":
      return ["pipeline_or_trace", "evidence_table", "remaining_gaps"];
    case "quality_gap":
      return ["pipeline_or_trace", "failure_gates", "hollow_example", "fix_contract", "regression_tests"];
    case "comparison_gap":
      return ["evidence_table", "failure_gates", "remaining_gaps", "fix_contract"];
    case "implementation_plan":
      return ["evidence_table", "fix_contract", "regression_tests", "remaining_gaps", "uncertainty"];
    case "regression_design":
      return ["failure_gates", "hollow_example", "regression_tests"];
  }
}

function focusByKind(kind: DeepAuditKind): Array<"call_chain" | "contracts" | "tests" | "configs" | "artifacts" | "web_sources"> {
  switch (kind) {
    case "root_cause": return ["call_chain", "contracts", "tests"];
    case "architecture_trace": return ["call_chain", "configs"];
    case "quality_gap": return ["call_chain", "contracts", "tests"];
    case "comparison_gap": return ["contracts", "artifacts", "web_sources"];
    case "implementation_plan": return ["call_chain", "contracts", "tests", "configs"];
    case "regression_design": return ["tests", "contracts"];
  }
}

function classifyDepthTier(message: string, auditKind: DeepAuditKind | null): DepthTier {
  if (!auditKind) return "normal";

  for (const pattern of EXHAUSTIVE_PATTERNS) {
    if (pattern.test(message)) return "exhaustive";
  }

  switch (auditKind) {
    case "root_cause":
    case "comparison_gap":
    case "quality_gap":
      return "thorough";
    case "architecture_trace":
      return /\b(?:detailed|thorough|full)\b/i.test(message) ? "thorough" : "normal";
    case "implementation_plan":
      return "thorough";
    case "regression_design":
      return "normal";
    default:
      return "normal";
  }
}

export function classifyDeepAudit(message: string, readOnly: boolean, hasTools: boolean): DeepAuditProfile {
  if (!readOnly || message.length < 30) {
    return { enabled: false, kind: null, confidence: "low", depthTier: "normal", requiredSections: [], evidenceFocus: [], minVerifiedReads: 0, minSearches: 0, synthesisBudget: "normal", reasons: [] };
  }

  if (EXCLUDE_PATTERNS.some((p) => p.test(message))) {
    return { enabled: false, kind: null, confidence: "low", depthTier: "normal", requiredSections: [], evidenceFocus: [], minVerifiedReads: 0, minSearches: 0, synthesisBudget: "normal", reasons: ["excluded by brevity or mutation pattern"] };
  }

  for (const { pattern, kind, confidence } of AUDIT_PATTERNS) {
    if (pattern.test(message)) {
      const depthTier = classifyDepthTier(message, kind);
      return {
        enabled: true,
        kind,
        confidence,
        depthTier,
        requiredSections: sectionByKind(kind),
        evidenceFocus: focusByKind(kind),
        minVerifiedReads: depthTier === "exhaustive" ? 6 : confidence === "high" ? 3 : 2,
        minSearches: depthTier === "exhaustive" ? 2 : 1,
        synthesisBudget: depthTier === "exhaustive" ? "expanded" : "expanded",
        reasons: [`matched audit pattern: ${pattern.source.slice(0, 60)}`, `depth tier: ${depthTier}`],
      };
    }
  }

  return { enabled: false, kind: null, confidence: "low", depthTier: "normal", requiredSections: [], evidenceFocus: [], minVerifiedReads: 0, minSearches: 0, synthesisBudget: "normal", reasons: [] };
}
