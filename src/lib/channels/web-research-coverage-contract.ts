import type { ResearchSourcePurpose, ResearchAnswerRequirement, WebResearchTaskSpec } from "@/lib/channels/web-research-task-spec";

export interface WebResearchCoverageResult {
  pass: boolean;
  missingSourcePurposes: ResearchSourcePurpose[];
  missingExactSourcePurposes: ResearchSourcePurpose[];
  missingGroupedSourcePurposes: ResearchSourcePurpose[];
  missingAnswerSections: ResearchAnswerRequirement[];
  missingMustMention: string[];
  missingDimensions: CoverageDimensionResult[];
  notes: string[];
}

export interface CoverageDimensionResult {
  key: string;
  label: string;
  whyItMatters: string;
  verified: boolean;
  tried?: string;
}

export const COVERAGE_DIMENSIONS: Record<string, { label: string; whyItMatters: string }> = {
  vram_budget: {
    label: "VRAM budget breakdown",
    whyItMatters: "GPU memory must fit weights+KV+system+headroom — exact numbers determine viability",
  },
  windows_native_path: {
    label: "OS-native install path",
    whyItMatters: "Platform-specific install steps avoid bridge overhead and compatibility issues",
  },
  tokens_per_second: {
    label: "Real-world throughput benchmarks",
    whyItMatters: "Determines if model is usable (below 3 t/s is painful for interactive use)",
  },
  tool_calling_fidelity: {
    label: "Tool-call JSON fidelity at this quant",
    whyItMatters: "Agent loops break with malformed JSON; Q4/Q5 quants may degrade precision",
  },
  context_window_at_q: {
    label: "Usable context window at this quant",
    whyItMatters: "KV cache size dominates VRAM — Q4_K_M 14B at 32k context needs ~4.5 GB",
  },
  port_binding: {
    label: "API server port + base URL",
    whyItMatters: "Must match the bridge UI config — 11434 for Ollama, 8080 for llama.cpp",
  },
  flash_attention: {
    label: "Flash Attention 2 support",
    whyItMatters: "Cuts KV cache memory ~50% — critical for fitting larger models on limited VRAM",
  },
  quant_options: {
    label: "Available quantization options",
    whyItMatters: "IQ2_M/IQ3_XXS quants can fit larger models; standard Q4_K_M is the safe default",
  },
  gpu_support: {
    label: "GPU compute layer status",
    whyItMatters: "CUDA/ROCm/Vulkan backend must be active — CPU-only is unusable for >7B",
  },
  agent_framework_compatibility: {
    label: "Agent framework compatibility",
    whyItMatters: "Agent connects via OpenAI-compatible endpoint; non-standard models may fail tool calling",
  },
};

export function isLocalModelSetupDimensionsPrompt(message: string): boolean {
  // Only match when the prompt is specifically about local model setup with hardware/OS constraints
  const hasLocalModel = /\b(?:qwen|ollama|llama\.cpp|lm\s*studio|local\s+model|gguf|quantiz)\b/i.test(message);
  const hasHardwareConstraint = /\b(?:16\s*gb|vram|gpu|nvidia|cuda|rtx)\b/i.test(message);
  const hasWindowsPlatform = /\b(?:windows|win10|win11|native)\b/i.test(message);
  const hasSetupIntent = /\b(?:setup|set\s+up|install|run|serve|configure|getting\s+started)\b/i.test(message);
  // Require local model + hardware constraint + setup intent. Windows is optional (Linux local model setup is valid too).
  return hasLocalModel && hasHardwareConstraint && hasSetupIntent;
}

export function getRequiredDimensions(message: string): CoverageDimensionResult[] {
  const isLocalSetup = isLocalModelSetupDimensionsPrompt(message);
  const isVram = /\b(?:vram|memory|16\s*gb|8\s*gb|24\s*gb|ram|fit)\b/i.test(message);
  const isSpeed = /\b(?:speed|tokens?.*second|t\/s|fast|slow|throughput|benchmark)\b/i.test(message);
  const isToolCalling = /\b(?:tool.*call|json|agent.*loop|fidelity|function.*call)\b/i.test(message);
  const isContext = /\b(?:context|32k|16k|8k|window|k\s*context)\b/i.test(message);
  const hasProductIntegration = /\b(?:agent|web\s*ui|webui|front[-\s]?end|integration|connector|workflow|tool\s*call)\b/i.test(message);

  const required: string[] = [];
  if (isLocalSetup && hasProductIntegration) {
    required.push("windows_native_path", "port_binding", "agent_framework_compatibility");
  } else if (isLocalSetup) {
    required.push("windows_native_path", "port_binding");
  }
  if (isVram) required.push("vram_budget");
  if (isSpeed) required.push("tokens_per_second");
  if (isToolCalling) required.push("tool_calling_fidelity");
  if (isContext) required.push("context_window_at_q", "flash_attention");
  if (isLocalSetup && /\b(?:quant|q4|q5|q3|iq2|iq3|gguf|model.*size|file.*size)\b/i.test(message)) {
    required.push("quant_options");
  }
  if (isLocalSetup && /\b(?:gpu|cuda|rocm|vulkan|nvidia|amd|accelerat)\b/i.test(message)) {
    required.push("gpu_support");
  }

  const unique = [...new Set(required)];
  return unique.map((key) => ({
    key,
    label: COVERAGE_DIMENSIONS[key]?.label ?? key,
    whyItMatters: COVERAGE_DIMENSIONS[key]?.whyItMatters ?? "",
    verified: false,
  }));
}

export const PURPOSE_GROUPS: Record<string, ResearchSourcePurpose[]> = {
  community_report: ["community_report", "github_issues", "github_discussions"],
  github_issues: ["github_issues", "community_report", "github_discussions"],
  github_discussions: ["github_discussions", "github_issues", "community_report"],
  github_releases: ["github_releases", "docs_readme"],
  docs_readme: ["docs_readme", "github_releases"],
  official_primary_product: ["official_primary_product"],
  official_integration_product: ["official_integration_product"],
  model_runtime: ["model_runtime"],
  youtube_transcript: ["youtube_transcript"],
  independent_blog: ["independent_blog", "docs_readme"],
  generic: ["generic"],
};

export function isSourcePurposeCoveredByGroup(
  required: ResearchSourcePurpose,
  available: ResearchSourcePurpose[],
): boolean {
  if (required === "generic") return available.length > 0;
  const group = PURPOSE_GROUPS[required];
  if (!group || group.length <= 1) return available.includes(required);
  return group.some((member) => available.includes(member));
}

export function evaluateWebResearchCoverage(
  spec: WebResearchTaskSpec,
  answer: string,
  evidenceSourcePurposes: ResearchSourcePurpose[],
): WebResearchCoverageResult {
  const missingSourcePurposes: ResearchSourcePurpose[] = [];
  const missingExactSourcePurposes: ResearchSourcePurpose[] = [];
  const missingGroupedSourcePurposes: ResearchSourcePurpose[] = [];
  const missingAnswerSections: ResearchAnswerRequirement[] = [];
  const missingMustMention: string[] = [];
  const missingDimensions: CoverageDimensionResult[] = [];
  const notes: string[] = [];

  const publicDiscussionLimited =
    spec.constraints.includes("public discussion") &&
    /(?:limited|weak|missing|could\s+not\s+verify|could\s+not\s+find)[^\n]{0,120}(?:public\s+discussion|community|ranked\s+community\s+consensus)/i.test(answer);

  for (const purpose of spec.requiredSourcePurposes) {
    if (publicDiscussionLimited && spec.constraints.includes("public discussion")) continue;
    if (!isSourcePurposeCoveredByGroup(purpose, evidenceSourcePurposes)) {
      missingSourcePurposes.push(purpose);
      missingGroupedSourcePurposes.push(purpose);
    }
    if (!evidenceSourcePurposes.includes(purpose)) {
      missingExactSourcePurposes.push(purpose);
    }
  }

  const answerNormalized = answer.toLowerCase();

  const sectionHeaders: Record<ResearchAnswerRequirement, RegExp> = {
    recommendation: /(?:^|\n)\s*#+\s*[^\n]*?(?:recommendation|verdict|conclusion|best\s+option|chosen\s+approach)/i,
    setup_steps: /(?:^|\n)\s*#+\s*[^\n]*?(?:setup|steps|installation|getting\s+started|commands?|config(?:uration)?|validation)/i,
    tradeoffs: /(?:^|\n)\s*#+\s*[^\n]*?(?:tradeoffs?|pros\s+(?:and|&)\s+cons?|risks?\s+(?:and|&)\s+benefits?|considerations|rejected\s+options?|what\s+won['']?t\s+work|fit\s+(?:table|matrix)|why\s+not)/i,
    failure_risks: /(?:^|\n)\s*#+\s*[^\n]*?(?:failure\s+risks?|risks?|limitations?|caveats?|warnings?|diagnostics?|what\s+won['']?t\s+work)/i,
    source_category_separation: /(?:official\s+(?:docs?|guidance|source)|community\s+(?:reports?|source|discussion)|model\s+(?:and|&)\s+runtime|runtime\s+(?:docs?|documentation)|source\s+(?:category|categories|types?))/i,
    uncertainty_statement: /(?:could\s+not\s+verif|unclear|undetermined|insufficient\s+evidence|not\s+sure|\bcould\s+not\s+(?:determine|confirm|find)|\bunknowns?\b|evidence\s+(?:gap|weak|missing)|not\s+verified)/i,
    concrete_example: /(?:for\s+example|e\.g\.|example:|example\s+code|example\s+config|```)/i,
    timestamped_bullets: /\d+:\d{2}/,
    confirmed_facts: /(?:^|\n)\s*#+\s*[^\n]*?(?:confirmed\s+facts?|verified\s+facts?|facts?)/i,
    likely_inferences: /(?:^|\n)\s*#+\s*[^\n]*?(?:likely\s+inferences?|inferences?|likely)/i,
    unknowns: /(?:^|\n)\s*#+\s*[^\n]*?(?:unknowns?|open\s+questions?|unresolved)/i,
    metadata_disclaimer: /(?:metadata|disclaimer|transcript\s+(?:un)?available|no?\s+captions?)/i,
  };

  for (const section of spec.requiredAnswerSections) {
    const regex = sectionHeaders[section];
    if (!regex || !regex.test(answer)) {
      missingAnswerSections.push(section);
    }
  }

  for (const must of spec.mustMention) {
    if (!mustMentionCovered(answerNormalized, must)) {
      missingMustMention.push(must);
    }
  }

  if (/transcript\s+access\s+worked/i.test(answer) || /captions?\s+access\s+worked/i.test(answer)) {
    if (!evidenceSourcePurposes.includes("youtube_transcript")) {
      notes.push("Answer claims transcript access but no youtube_transcript evidence was collected.");
      missingSourcePurposes.push("youtube_transcript");
    }
  }

  if (!publicDiscussionLimited && /request\s+covered/i.test(answer) && (
    missingAnswerSections.length > 0 || missingSourcePurposes.length > 0
  )) {
    notes.push("Answer says 'Request covered' but required sections or source purposes are missing.");
  }

  const pass = missingSourcePurposes.length === 0 &&
    missingAnswerSections.length === 0 &&
    missingMustMention.length === 0 &&
    missingDimensions.length === 0 &&
    notes.length === 0;

  return { pass, missingSourcePurposes, missingExactSourcePurposes, missingGroupedSourcePurposes, missingAnswerSections, missingMustMention, missingDimensions, notes };
}

function mustMentionCovered(answerNormalized: string, must: string): boolean {
  const normalizedMust = must.toLowerCase();
  if (answerNormalized.includes(normalizedMust)) return true;
  if (normalizedMust === "ollama or another runtime") {
    return /\b(?:ollama|lm\s*studio|llama\.cpp|vllm|jan|koboldcpp)\b/i.test(answerNormalized);
  }
  if (normalizedMust === "openai-compatible serving") {
    return /\bopenai[-\s]*compatible\b/i.test(answerNormalized) || /\b(?:\/v1\/chat\/completions|openai\s+api\s+compatible)\b/i.test(answerNormalized);
  }
  if (normalizedMust === "16gb vram") {
    return /\b16\s*gb\b[\s\S]{0,40}\bvram\b/i.test(answerNormalized) ||
      /\bvram\b[\s\S]{0,40}\b16\s*gb\b/i.test(answerNormalized);
  }
  return false;
}
