export type ResearchSourcePurpose =
  | "official_primary_product"
  | "official_integration_product"
  | "model_runtime"
  | "community_report"
  | "youtube_transcript"
  | "github_issues"
  | "github_discussions"
  | "github_releases"
  | "docs_readme"
  | "independent_blog"
  | "generic";

export type WebResearchTaskKind =
  | "local_model_setup"
  | "current_source_synthesis"
  | "general_research"
  | "youtube_transcript_summary"
  | "comparison"
  | "troubleshooting";

export type WebResearchDepthTier = "normal" | "deep" | "exhaustive";

export type ResearchAnswerArtifact =
  | "commands"
  | "setup_matrix"
  | "validation_checklist"
  | "measurement_table"
  | "failure_diagnostics"
  | "source_category_table"
  | "unknowns";

export type ResearchAnswerRequirement =
  | "recommendation"
  | "setup_steps"
  | "tradeoffs"
  | "failure_risks"
  | "source_category_separation"
  | "uncertainty_statement"
  | "concrete_example"
  | "timestamped_bullets"
  | "confirmed_facts"
  | "likely_inferences"
  | "unknowns"
  | "metadata_disclaimer";

export interface WebResearchTaskSpec {
  taskKind: WebResearchTaskKind;
  entities: string[];
  constraints: string[];
  requiredSourcePurposes: ResearchSourcePurpose[];
  requiredAnswerSections: ResearchAnswerRequirement[];
  requiredAnswerArtifacts?: ResearchAnswerArtifact[];
  depthTier?: WebResearchDepthTier;
  mustMention: string[];
}

const LOCAL_MODEL_TERMS = /\b(?:qwen|llama|ollama|vllm|lm\s*studio|llama\.cpp|lms|local\s+model|openai\s*[-]\s*compatible)\b/i;
const WINDOWS_TERMS = /\b(?:windows|win\d+|wsl|power\s*shell)\b/i;
const VRAM_TERMS = /\b(?:16\s*gb\s+vram|16gb|16\s*gb|vram|gpu\s+memory)\b/i;
const SETUP_TERMS = /\b(?:set\s*up|setup|install|configure|run\s+local(?:ly)?|self\s*[-]?\s*host|how\s+to\s+run|running)\b/i;

const DEPTH_TERMS = /\b(?:verbose|detailed|decision[-\s]?ready|exact\s+(?:commands|steps|setup)|validation\s+checklist|failure\s+diagnostics|source\s+(?:categor|matrix)|measurement|step[-\s]by[-\s]step|comprehensive|deep|thorough|specific\s+(?:commands|files|steps|details))\b/i;

const CURRENT_SOURCE_TERMS = /\b(?:research\s+whether|currently\s+supports?|offic(?:ial|ially)\s+(?:documented|supported)\b|confirmed\s+facts?|likely\s+inferences?|what\s+(?:do|does)\s+.+currently\s+support|what\s+is\s+currently\s+supported|current\s+state\s+of)\b/i;
const PUBLIC_DISCUSSION_TERMS = /\b(?:public\s+discussion|community\s+(?:discussion|reports?|reaction)|people\s+(?:say|think|report)|top\s+\d+\s+themes?|reaction|sentiment)\b/i;
const KNOWN_RUNTIME_ENTITY = /\b(?:qwen|llama|mistral|gemma|phi|deepseek|whisper|mixtral|ollama|vllm|lm\s*studio|llama\.cpp|sglang|gguf|cuda|rocm|vulkan|windows|linux|macos|openai-compatible)\b/i;

function extractPromptEntities(message: string): string[] {
  const entities = new Set<string>();
  for (const quoted of message.matchAll(/["'`]([^"'`]{2,80})["'`]/g)) {
    const value = quoted[1]?.replace(/\s+/g, " ").trim();
    if (value) entities.add(value);
  }
  for (const match of message.matchAll(/\b([A-Z][A-Za-z0-9.+_-]*(?:\s+[A-Z][A-Za-z0-9.+_-]*){0,3})\b/g)) {
    const value = match[1]?.replace(/\s+/g, " ").trim();
    if (!value || /^(?:I|The|This|That|What|How|When|Where|Which|Can|Does|Do|Please|Windows|Linux|Mac|GPU|VRAM)$/i.test(value)) continue;
    entities.add(value);
  }
  return Array.from(entities).slice(0, 4);
}

function productEntitiesForOfficialSources(message: string): string[] {
  return extractPromptEntities(message).filter((entity) => !KNOWN_RUNTIME_ENTITY.test(entity)).slice(0, 2);
}

export function classifyResearchTaskSpec(message: string): WebResearchTaskSpec {
  const normalized = message.toLowerCase();

  // --- current source synthesis ---
  // Keep this before local_model_setup: prompts like "research whether X
  // currently supports Y" may mention local models, Windows, or Qwen, but the
  // requested output is a facts/inferences/unknowns synthesis, not setup steps.
  if (CURRENT_SOURCE_TERMS.test(normalized) || /\bconflict(?:ing)?\s+sources?\b/i.test(normalized)) {
    const requiredSourcePurposes: ResearchSourcePurpose[] = ["generic"];
    if (/\b(?:official\s+source|official\s+docs?|official)\b/i.test(normalized)) {
      requiredSourcePurposes.push("official_primary_product");
      if (productEntitiesForOfficialSources(message).length > 1) requiredSourcePurposes.push("official_integration_product");
    }
    if (/\b(?:non[-\s]?official|community|user\s+report|github\s+issue|discussion)\b/i.test(normalized)) {
      requiredSourcePurposes.push("community_report");
    }
    const isDepthRequested = DEPTH_TERMS.test(normalized);
    const depthArtifacts: ResearchAnswerArtifact[] = isDepthRequested
      ? ["commands", "source_category_table", "unknowns", "failure_diagnostics"]
      : [];
    return {
      taskKind: "current_source_synthesis",
      entities: [],
      constraints: [],
      requiredSourcePurposes: Array.from(new Set(requiredSourcePurposes)),
      requiredAnswerSections: ["confirmed_facts", "likely_inferences", "unknowns", "source_category_separation", "uncertainty_statement"],
      requiredAnswerArtifacts: depthArtifacts.length > 0 ? depthArtifacts : undefined,
      depthTier: isDepthRequested ? "deep" : "normal",
      mustMention: [],
    };
  }

  // --- local model setup ---
  // Classify local-model setup prompts: require local model terms + setup/hardware intent.
  // Official source roles are derived from named non-runtime products in the prompt.
  const qualifiesForLocalModelSetup = LOCAL_MODEL_TERMS.test(normalized) && (
    SETUP_TERMS.test(normalized) ||
    VRAM_TERMS.test(normalized) ||
    WINDOWS_TERMS.test(normalized)
  );
  if (qualifiesForLocalModelSetup) {
    const entities: string[] = [];
    const mustMention: string[] = [];
    const productEntities = productEntitiesForOfficialSources(message);
    entities.push(...productEntities);
    if (/\bqwen\b/i.test(normalized)) { entities.push("Qwen"); mustMention.push("Qwen"); }
    mustMention.push("Ollama or another runtime");
    mustMention.push("OpenAI-compatible serving");
    if (VRAM_TERMS.test(normalized)) {
      // Derive VRAM number from prompt instead of hardcoding
      const vramMatch = normalized.match(/(\d+)\s*gb/);
      const vramGb = vramMatch ? parseInt(vramMatch[1]) : 16;
      mustMention.push(`${vramGb}GB VRAM`);
    }
    if (WINDOWS_TERMS.test(normalized)) mustMention.push("Windows");

    const isDepthRequested = DEPTH_TERMS.test(normalized);

    const requiredPurposes: ResearchSourcePurpose[] = ["model_runtime", "community_report"];
    if (productEntities.length > 0) requiredPurposes.push("official_primary_product");
    if (productEntities.length > 1) requiredPurposes.push("official_integration_product");

    return {
      taskKind: "local_model_setup",
      entities: entities.length > 0 ? entities : ["local model"],
      constraints: WINDOWS_TERMS.test(normalized) ? ["Windows"] : [],
      requiredSourcePurposes: Array.from(new Set(requiredPurposes)),
      requiredAnswerSections: ["recommendation", "setup_steps", "tradeoffs", "failure_risks", "source_category_separation", "uncertainty_statement"],
      requiredAnswerArtifacts: isDepthRequested
        ? ["commands", "setup_matrix", "validation_checklist", "measurement_table", "failure_diagnostics", "source_category_table", "unknowns"]
        : undefined,
      depthTier: isDepthRequested ? "deep" : "normal",
      mustMention: mustMention.length > 0 ? mustMention : ["local model"],
    };
  }

  // --- public discussion / community signal ---
  if (PUBLIC_DISCUSSION_TERMS.test(normalized)) {
    const purposes: ResearchSourcePurpose[] = ["community_report", "github_issues", "github_discussions", "github_releases", "docs_readme"];
    const entities = productEntitiesForOfficialSources(message);
    if (entities.length > 0) purposes.push("official_primary_product");
    if (entities.length > 1) purposes.push("official_integration_product");
    const requiredSections: ResearchAnswerRequirement[] = ["source_category_separation", "uncertainty_statement", "confirmed_facts", "likely_inferences", "unknowns"];
    return {
      taskKind: "general_research",
      entities,
      constraints: ["public discussion"],
      requiredSourcePurposes: Array.from(new Set(purposes)),
      requiredAnswerSections: requiredSections,
      mustMention: [],
    };
  }

  // --- youtube transcript summary ---
  if (/(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i.test(normalized) && /\b(?:summari[sz]e|analy[sz]e|transcript|inspect|extract\s+claims?)\b/i.test(normalized)) {
    return {
      taskKind: "youtube_transcript_summary",
      entities: [],
      constraints: [],
      requiredSourcePurposes: ["youtube_transcript"],
      requiredAnswerSections: ["timestamped_bullets", "metadata_disclaimer"],
      mustMention: [],
    };
  }

  // --- comparison ---
  if (/\b(?:compare|versus|vs\.?|benchmark|better|worse)\b/i.test(normalized)) {
    return {
      taskKind: "comparison",
      entities: [],
      constraints: [],
      requiredSourcePurposes: ["generic"],
      requiredAnswerSections: ["recommendation", "tradeoffs", "source_category_separation"],
      mustMention: [],
    };
  }

  // --- troubleshooting ---
  if (/\b(?:troubleshoot|fix|error|bug|broken|not\s+working|failed|crash)\b/i.test(normalized)) {
    return {
      taskKind: "troubleshooting",
      entities: [],
      constraints: [],
      requiredSourcePurposes: ["generic"],
      requiredAnswerSections: ["recommendation", "concrete_example", "uncertainty_statement"],
      mustMention: [],
    };
  }

  // --- general web research ---
  return {
    taskKind: "general_research",
    entities: [],
    constraints: [],
    requiredSourcePurposes: ["generic"],
    requiredAnswerSections: [],
    mustMention: [],
  };
}

export function taskSpecToAnswerSections(spec: WebResearchTaskSpec): string {
  if (spec.requiredAnswerSections.length === 0) return "";

  const sectionLabels: Record<ResearchAnswerRequirement, string> = {
    recommendation: "Recommendation",
    setup_steps: "Setup Steps",
    tradeoffs: "Tradeoffs",
    failure_risks: "Failure Risks",
    source_category_separation: "Source Categories",
    uncertainty_statement: "Uncertainty / What I Could Not Verify",
    concrete_example: "Concrete Example",
    timestamped_bullets: "Timestamped Bullets",
    confirmed_facts: "Confirmed Facts",
    likely_inferences: "Likely Inferences",
    unknowns: "Unknowns",
    metadata_disclaimer: "Metadata / Disclaimer",
  };

  return spec.requiredAnswerSections
    .map((s) => `- ## ${sectionLabels[s]}`)
    .join("\n");
}
