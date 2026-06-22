export type OutputQualityIssue =
  | "promise_without_action"
  | "missing_reference_mechanisms"
  | "missing_disp8ch_mapping"
  | "missing_implementation_targets"
  | "missing_tests_or_validation"
  | "missing_prioritized_plan"
  | "missing_safety_boundary"
  | "too_shallow_for_gap_analysis"
  | "too_shallow_for_depth_prompt"
  | "insufficient_concrete_mechanisms"
  | "insufficient_file_targets"
  | "insufficient_sources_cited"
  | "insufficient_safety_boundaries";

export type DepthScore = {
  concreteMechanisms: number;
  implementationTargets: number;
  evidenceCitations: number;
  validationSteps: number;
  explicitUnknowns: number;
  safetyBoundaries: number;
};

export type OutputQualityResult = {
  applicable: boolean;
  ok: boolean;
  issues: OutputQualityIssue[];
  repairInstruction: string;
  depthScore?: DepthScore;
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function issueList(value: OutputQualityIssue[]): string {
  return value.length > 0 ? value.join(", ") : "none";
}

function asksReferenceComparison(message: string): boolean {
  return /\b(?:reference\s+(?:app|agent|implementation)|compare|comparison|versus|vs\.?|better|gap)\b/i.test(message) &&
    /\b(?:better|gap|compare|code|directly|makes|improve|output|quality|verbose|depth|grounding|instruction|tool[-\s]?use|safety)\b/i.test(message) ||
    /\b(?:after\s+(?:looking|checking|inspecting|reading)\s+(?:directly\s+)?at\s+.+\bcode|what\s+makes\s+.+\s+(?:good|better|stronger)|why\s+(?:does|is)\s+.+\s+(?:better|stronger|richer))\b/i.test(message);
}

function asksImplementationPlan(message: string): boolean {
  return /\b(?:implement|implementation\s+plan|how\s+to\s+implement|what\s+files?|what\s+should\s+we\s+add|add\s+to\s+our\s+app|improve|solve|fix|close\s+the\s+gap|upgrade)\b/i.test(message);
}

function asksGapReview(message: string): boolean {
  return /\b(?:gaps?|remaining|problematic|test\s+cases?|parity|quality\s+gap)\b/i.test(message);
}

function asksOutputQuality(message: string): boolean {
  return /\b(?:output|answers?|verbose|depth|grounding|instruction\s+following|tool[-\s]?use\s+safety|high\s+quality)\b/i.test(message);
}

function asksDepthExplicitly(message: string): boolean {
  return /\b(?:depth|deep|verbose|detailed|comprehensive|thorough|exhaustive|decision[-\s]?ready|exact\s+(?:commands|setup|steps)|validation\s+checklist|source\s+categor|step[-\s]by[-\s]step)\b/i.test(message);
}

function isLocalModelSetupPrompt(message: string): boolean {
  return /\b(?:qwen|ollama|llama|local\s+model|16\s*gb\s+vram|windows\s+(?:setup|install|run)|run\s+local(?:ly)?|self[-\s]?host)\b/i.test(message) &&
    /\b(?:set\s*up|setup|install|configure|run|how\s+to|running)\b/i.test(message);
}

function isCurrentSourcePrompt(message: string): boolean {
  return /\b(?:currently\s+supports?|research\s+whether|conflict(?:ing)?\s+sources?|confirmed\s+facts?|what\s+(?:do|does).+currently\s+support)\b/i.test(message);
}

function shouldApplyReferenceOutputGate(message: string): boolean {
  return asksReferenceComparison(message) || (
    asksImplementationPlan(message) &&
    asksGapReview(message) &&
    asksOutputQuality(message)
  );
}

function shouldApplyDepthGate(message: string): boolean {
  return asksDepthExplicitly(message) ||
    isLocalModelSetupPrompt(message) ||
    isCurrentSourcePrompt(message) ||
    /\b(?:implementation|gap|parity|output\s+quality|reference\s+(?:app|agent|implementation))\b/i.test(message);
}

function hasPromiseWithoutAction(answer: string): boolean {
  const firstParagraph = answer.split(/\n\s*\n/)[0] ?? answer;
  return /\b(?:I\s+(?:will|would|can)\s+(?:check|look|inspect|review|compare|research|see)|let\s+me\s+(?:check|look|inspect|review)|need\s+to\s+(?:check|inspect|review|compare))\b/i.test(firstParagraph) &&
    !/\b(?:found|implemented|changed|added|verified|read|inspected|compared|tests?\s*:|verification)\b/i.test(answer);
}

function countReferenceMechanisms(answer: string): number {
  const mechanisms = [
    /\b(?:toolsets?|tool\s+registry|dynamic\s+tools?|schema\s+saniti[sz]ation|tool\s+schema)\b/i,
    /\b(?:prompt\s+builder|context\s+files?|startup\s+context|prompt[-\s]?injection|SOUL\.md|AGENTS\.md)\b/i,
    /\b(?:agent\s+loop|iteration\s+budget|max_iterations|empty\s+response|recovery\s+pass|fallback)\b/i,
    /\b(?:stream\s+replay|subscriber\s+replay|offline\s+buffer|active[-\s]?run|session\s+lock|stream\s+ownership)\b/i,
    /\b(?:reasoning|tool\s+telemetry|tool\s+cards?|trace|callbacks?|step\s+callbacks?)\b/i,
    /\b(?:memory\s+context|ephemeral\s+context|context\s+compression|prompt\s+caching)\b/i,
    /\b(?:file\s+mutation|verifier|guardrail|budget\s+exhaustion)\b/i,
  ];
  return mechanisms.reduce((total, pattern) => total + (pattern.test(answer) ? 1 : 0), 0);
}

function hasDisp8chMapping(answer: string): boolean {
  return /\b(?:disp8ch AI|Disp8ch)\b/i.test(answer) &&
    /\b(?:src\/lib\/channels|src\/app\/api\/channels|answer-quality-gate|deep-answer-contract|broad-answer-contract|webchat-system-prompt|fallback-assistant|tool-caller|route\.ts)\b/i.test(answer);
}

function hasImplementationTargets(answer: string): boolean {
  return /\b(?:src\/|scripts\/|docs\/|CLAUDE\.md|CLAUDE_SESSION_HISTORY\.md)\S*/.test(answer) ||
    /\b(?:files?\s+to\s+(?:change|touch)|implementation\s+targets?|where\s+to\s+change)\b/i.test(answer);
}

function hasTestsOrValidation(answer: string): boolean {
  return /\b(?:tests?|regression|verification|validate|smoke|tsc|playwright|acceptance\s+criteria)\b/i.test(answer);
}

function hasPrioritizedPlan(answer: string): boolean {
  return /\b(?:priority|prioritized|P0|P1|phase\s+\d+|first|next|then|order(?:ed)?)\b/i.test(answer) &&
    /\b(?:plan|implement|step|fix|change)\b/i.test(answer);
}

function hasSafetyBoundary(answer: string): boolean {
  return /\b(?:ground(?:ed|ing)|evidence|verified|read[-\s]?only|confirmation|tool[-\s]?use\s+safety|contract|guardrail|schema|citations?)\b/i.test(answer);
}

function countConcreteMechanisms(answer: string): number {
  const patterns = [
    /\b(?:toolsets?|tool\s+registry|dynamic\s+tools?|schema\s+saniti[sz]ation)\b/i,
    /\b(?:prompt\s+builder|context\s+files?|prompt[-\s]?injection)\b/i,
    /\b(?:agent\s+loop|iteration\s+budget|max_iterations|empty\s+response|recovery)\b/i,
    /\b(?:stream\s+replay|subscriber\s+replay|offline\s+buffer)\b/i,
    /\b(?:reasoning|tool\s+telemetry|tool\s+cards?|visual\s+progress)\b/i,
    /\b(?:compression|prompt\s+caching|evidence\s+metadata)\b/i,
    /\b(?:file\s+mutation|verifier|guardrail|budget\s+exhaustion)\b/i,
    /\b(?:Ollama|llama\.cpp|LM\s+Studio|OpenAI[-\s]compatible|local\s+runtime|endpoint)\b/i,
    /\b(?:ollama\s+pull|ollama\s+serve|winget\s+install|curl\s+http)\b/i,
  ];
  return patterns.reduce((total, pattern) => total + (pattern.test(answer) ? 1 : 0), 0);
}

function countFileTargets(answer: string): number {
  const matches = answer.match(/\b(?:src\/|scripts\/|docs\/)\S+/g);
  return matches ? new Set(matches).size : 0;
}

function countEvidenceCitations(answer: string): number {
  const urlCount = (answer.match(/https?:\/\/[^\s)]+/g) ?? []).length;
  const fileRefCount = (answer.match(/\b(?:src|lib|app|scripts|docs)\/[A-Za-z0-9._/-]+/g) ?? []).length;
  return urlCount + fileRefCount;
}

function countValidationSteps(answer: string): number {
  const checkPatterns = [
    /\b(?:check|verify|validate|confirm|test|ensure)\b/gi,
    /\b(?:pnpm|npm|tsc|eslint|node|python|curl)\b/gi,
    /\b(?:regression|smoke|acceptance|unit|integration)\b/gi,
  ];
  let count = 0;
  let remaining = answer;
  for (const pattern of checkPatterns) {
    const matches = remaining.match(pattern);
    if (matches) {
      count += Math.min(matches.length, 5);
      remaining = remaining.replace(pattern, "");
    }
  }
  return count;
}

function countExplicitUnknowns(answer: string): number {
  return (answer.match(/\b(?:could\s+not\s+verif|unable\s+to\s+verif|not\s+verif(?:ied|iable)|unknown|unclear|missing\s+evidence|insufficient\s+(?:evidence|sources))/gi) ?? []).length;
}

function countSafetyBoundaries(answer: string): number {
  const boundaries = [
    /\b(?:read[-\s]?only)/i,
    /\b(?:confirmation|approval)\s+(?:boundary|gate|required|needed)/i,
    /\b(?:no\s+mutation|do\s+not\s+(?:create|run|execute|schedule|save|delete))/i,
    /\b(?:verified|grounded|evidence[-\s]?backed)/i,
    /\b(?:contract|gate|guardrail|schema\s+check)/i,
  ];
  return boundaries.reduce((total, pattern) => total + (pattern.test(answer) ? 1 : 0), 0);
}

function computeDepthScore(answer: string): DepthScore {
  return {
    concreteMechanisms: countConcreteMechanisms(answer),
    implementationTargets: countFileTargets(answer),
    evidenceCitations: countEvidenceCitations(answer),
    validationSteps: countValidationSteps(answer),
    explicitUnknowns: countExplicitUnknowns(answer),
    safetyBoundaries: countSafetyBoundaries(answer),
  };
}

function depthGateMinWordCount(message: string): number {
  if (isLocalModelSetupPrompt(message)) return 1200;
  if (/\b(?:implementation|gap|parity|output quality)\b/i.test(message)) return 900;
  if (isCurrentSourcePrompt(message)) return 600;
  if (asksDepthExplicitly(message)) return 700;
  return 400;
}

function depthGateMinMechanisms(message: string): number {
  if (isLocalModelSetupPrompt(message)) return 5;
  if (/\b(?:implementation|gap|parity|output quality)\b/i.test(message)) return 4;
  return 2;
}

function depthGateMinFileTargets(message: string): number {
  if (/\b(?:implementation|gap|parity|output quality)\b/i.test(message)) return 5;
  if (isLocalModelSetupPrompt(message)) return 3;
  return 1;
}

function depthGateMinTests(message: string): number {
  if (/\b(?:implementation|gap|parity|output quality)\b/i.test(message)) return 3;
  return 1;
}

function depthGateMinSafety(message: string): number {
  if (/\b(?:implementation|gap|parity|output quality)\b/i.test(message)) return 2;
  return 1;
}

export function evaluateOutputQuality(input: {
  answer: string;
  userMessage: string;
  route?: string;
}): OutputQualityResult {
  const answer = String(input.answer || "").trim();
  const message = String(input.userMessage || "");
  const issues: OutputQualityIssue[] = [];
  const referenceGateApplicable = shouldApplyReferenceOutputGate(message);
  const depthGateApplicable = shouldApplyDepthGate(message);
  const applicable = referenceGateApplicable || depthGateApplicable;

  if (!applicable) {
    return { applicable: false, ok: true, issues: [], repairInstruction: "" };
  }

  if (referenceGateApplicable) {
    if (hasPromiseWithoutAction(answer)) {
      issues.push("promise_without_action");
    }

    if (asksReferenceComparison(message) && countReferenceMechanisms(answer) < 3) {
      issues.push("missing_reference_mechanisms");
    }

    if (asksImplementationPlan(message) && !hasDisp8chMapping(answer)) {
      issues.push("missing_disp8ch_mapping");
    }

    if (asksImplementationPlan(message) && !hasImplementationTargets(answer)) {
      issues.push("missing_implementation_targets");
    }

    if (asksImplementationPlan(message) && !hasTestsOrValidation(answer)) {
      issues.push("missing_tests_or_validation");
    }

    if (asksGapReview(message) && !hasPrioritizedPlan(answer)) {
      issues.push("missing_prioritized_plan");
    }

    if (asksOutputQuality(message) && !hasSafetyBoundary(answer)) {
      issues.push("missing_safety_boundary");
    }

    if ((asksReferenceComparison(message) || asksGapReview(message)) && wordCount(answer) < 260) {
      issues.push("too_shallow_for_gap_analysis");
    }
  }

  const depthScore = depthGateApplicable ? computeDepthScore(answer) : undefined;
  if (depthGateApplicable && depthScore) {
    const referenceGatePassed = referenceGateApplicable && (
      (asksReferenceComparison(message) ? countReferenceMechanisms(answer) >= 3 : true) &&
      (asksImplementationPlan(message) ? hasDisp8chMapping(answer) && hasImplementationTargets(answer) && hasTestsOrValidation(answer) : true) &&
      (asksGapReview(message) ? hasPrioritizedPlan(answer) : true) &&
      (asksOutputQuality(message) ? hasSafetyBoundary(answer) : true) &&
      !hasPromiseWithoutAction(answer)
    );

    const words = wordCount(answer);
    const baseMinWords = depthGateMinWordCount(message);
    if (!referenceGatePassed && words < baseMinWords) {
      issues.push("too_shallow_for_depth_prompt");
    }

    const minMechanisms = depthGateMinMechanisms(message);
    if (depthScore.concreteMechanisms < minMechanisms) {
      issues.push("insufficient_concrete_mechanisms");
    }

    const minFiles = depthGateMinFileTargets(message);
    if (depthScore.implementationTargets < minFiles) {
      issues.push("insufficient_file_targets");
    }

    const minTests = depthGateMinTests(message);
    if (depthScore.validationSteps < minTests) {
      issues.push("insufficient_sources_cited");
    }

    const minSafety = depthGateMinSafety(message);
    if (depthScore.safetyBoundaries < minSafety) {
      issues.push("insufficient_safety_boundaries");
    }
  }

  const uniqueIssues = unique(issues);
  const repairParts = [
    "Evidence-rich output quality contract failed.",
    `Issues: ${issueList(uniqueIssues)}.`,
  ];

  if (applicable) {
    repairParts.push(
      "Repair the final answer so it is decision-ready, not just correct.",
      "Include the concrete reference-app mechanisms that explain the gap, the disp8ch AI files/modules to change, a prioritized implementation path, tests/validation, and grounding/tool-safety boundaries.",
      "Do not say you will inspect or compare later. Use the evidence already collected and produce the final artifact now.",
    );
  }

  if (depthGateApplicable && depthScore) {
    const minWords = depthGateMinWordCount(message);
    repairParts.push(
      `Depth gate failed. The answer has ${words(answer)} words (need at least ${minWords}).`,
      `Depth score: mechs=${depthScore.concreteMechanisms}, files=${depthScore.implementationTargets}, citations=${depthScore.evidenceCitations}, validation=${depthScore.validationSteps}, unknowns=${depthScore.explicitUnknowns}, safety=${depthScore.safetyBoundaries}.`,
    );

    if (isLocalModelSetupPrompt(message)) {
      repairParts.push(
        "This is a local-model setup prompt. The answer must include: recommendation, verified vs inferred, source category table, Windows-native setup path with exact commands, runtime options matrix, exact endpoint checks, validation checklist, measurement table, failure diagnostics, tool-calling/context-window risks, unknowns, and sources.",
      );
    }

    if (isCurrentSourcePrompt(message)) {
      repairParts.push(
        "This is a current-source synthesis prompt. The answer must include: confirmed facts, likely inferences, unknowns, source categories, what could not be verified, and sources. Separate official from community sources.",
      );
    }

    repairParts.push(
      "Expand the answer with the verified evidence already collected. Add concrete details, not more caveats.",
    );
  }

  return {
    applicable: applicable || depthGateApplicable,
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    repairInstruction: [
      ...repairParts,
      "Do not say you will inspect or compare later. Expand using already-collected evidence.",
    ].join("\n"),
    depthScore,
  };
}

function words(answer: string): number {
  return wordCount(answer);
}
