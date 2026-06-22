import type { ResearchAnswerRequirement, ResearchAnswerArtifact, WebResearchTaskSpec } from "@/lib/channels/web-research-task-spec";

export type PlannedAnswerSection = {
  id: string;
  title: string;
  required: boolean;
  minBullets?: number;
  requiredEvidencePurposes?: string[];
  requiredArtifacts?: Array<"commands" | "table" | "checklist" | "risks" | "unknowns">;
};

const SECTION_TEMPLATES: Record<string, Omit<PlannedAnswerSection, "id">> = {
  recommendation: { title: "Recommendation", required: true, minBullets: 1 },
  verified_vs_inferred: { title: "Verified vs Inferred", required: true, requiredEvidencePurposes: ["official_primary_product", "official_integration_product", "model_runtime"] },
  source_category_table: { title: "Source Category Table", required: true, requiredArtifacts: ["table"] },
  setup_steps: { title: "Setup Steps", required: true, minBullets: 3, requiredArtifacts: ["commands"] },
  runtime_options: { title: "Runtime Options Matrix", required: true, requiredArtifacts: ["table"] },
  exact_endpoint_checks: { title: "Exact Endpoint Checks", required: true, requiredArtifacts: ["table", "commands"] },
  windows_native_setup: { title: "Windows-Native Setup Path", required: false, requiredArtifacts: ["commands"] },
  validation_checklist: { title: "Validation Checklist", required: true, requiredArtifacts: ["checklist"] },
  measurement_table: { title: "Measurement Table", required: true, requiredArtifacts: ["table"] },
  failure_diagnostics: { title: "Failure Diagnostics", required: true, requiredArtifacts: ["table", "risks"] },
  risks: { title: "Tool-Calling / Context-Window Risks", required: true, requiredArtifacts: ["risks"] },
  unknowns: { title: "Unknowns and Local Measurements", required: true, requiredArtifacts: ["unknowns"] },
  sources: { title: "Sources", required: true, minBullets: 2 },
  confirmed_facts: { title: "Confirmed Facts", required: true, requiredEvidencePurposes: ["official_primary_product", "official_integration_product", "docs_readme"] },
  likely_inferences: { title: "Likely Inferences", required: true },
  what_could_not_verify: { title: "What Could Not Be Verified", required: true, requiredArtifacts: ["unknowns"] },
  reference_mechanisms: { title: "Reference Mechanisms Behind the Gap", required: true, minBullets: 3 },
  disp8ch_mapping: { title: "disp8ch AI File/Module Mapping", required: true, minBullets: 5 },
  implementation_plan: { title: "Prioritized Implementation Plan", required: true, minBullets: 3 },
  tests_validation: { title: "Tests and Validation", required: true, minBullets: 3, requiredArtifacts: ["commands"] },
  safety_boundaries: { title: "Grounding and Tool-Use Safety Boundaries", required: true, minBullets: 2, requiredArtifacts: ["risks"] },
  capability_status: { title: "Capability Status", required: true, requiredArtifacts: ["table"] },
  required_checklist: { title: "Required Component Checklist", required: true, requiredArtifacts: ["checklist"] },
  direct_answer: { title: "Direct Answer", required: true },
  attempt_routes: { title: "Attempted Routes", required: true },
  diagnostics: { title: "Diagnostics", required: true, requiredArtifacts: ["table"] },
  transcript_fallback: { title: "User-Provided Transcript Fallback", required: true },
  will_not_do: { title: "What Will Not Be Done", required: true },
};

const LOCAL_MODEL_SETUP_SECTIONS: PlannedAnswerSection[] = [
  { id: "recommendation", ...SECTION_TEMPLATES.recommendation },
  { id: "verified_vs_inferred", ...SECTION_TEMPLATES.verified_vs_inferred },
  { id: "source_category_table", ...SECTION_TEMPLATES.source_category_table },
  { id: "windows_native_setup", ...SECTION_TEMPLATES.windows_native_setup },
  { id: "setup_steps", ...SECTION_TEMPLATES.setup_steps },
  { id: "runtime_options", ...SECTION_TEMPLATES.runtime_options },
  { id: "exact_endpoint_checks", ...SECTION_TEMPLATES.exact_endpoint_checks },
  { id: "validation_checklist", ...SECTION_TEMPLATES.validation_checklist },
  { id: "measurement_table", ...SECTION_TEMPLATES.measurement_table },
  { id: "failure_diagnostics", ...SECTION_TEMPLATES.failure_diagnostics },
  { id: "risks", ...SECTION_TEMPLATES.risks },
  { id: "unknowns", ...SECTION_TEMPLATES.unknowns },
  { id: "sources", ...SECTION_TEMPLATES.sources },
];

const CURRENT_SOURCE_SECTIONS: PlannedAnswerSection[] = [
  { id: "confirmed_facts", ...SECTION_TEMPLATES.confirmed_facts },
  { id: "likely_inferences", ...SECTION_TEMPLATES.likely_inferences },
  { id: "unknowns", ...SECTION_TEMPLATES.unknowns },
  { id: "source_category_table", ...SECTION_TEMPLATES.source_category_table },
  { id: "what_could_not_verify", ...SECTION_TEMPLATES.what_could_not_verify },
  { id: "sources", ...SECTION_TEMPLATES.sources },
];

const IMPLEMENTATION_AUDIT_SECTIONS: PlannedAnswerSection[] = [
  { id: "reference_mechanisms", ...SECTION_TEMPLATES.reference_mechanisms },
  { id: "disp8ch_mapping", ...SECTION_TEMPLATES.disp8ch_mapping },
  { id: "implementation_plan", ...SECTION_TEMPLATES.implementation_plan },
  { id: "tests_validation", ...SECTION_TEMPLATES.tests_validation },
  { id: "safety_boundaries", ...SECTION_TEMPLATES.safety_boundaries },
  { id: "unknowns", ...SECTION_TEMPLATES.unknowns },
];

const CAPABILITY_DIAGNOSTIC_SECTIONS: PlannedAnswerSection[] = [
  { id: "capability_status", ...SECTION_TEMPLATES.capability_status },
  { id: "direct_answer", ...SECTION_TEMPLATES.direct_answer },
  { id: "required_checklist", ...SECTION_TEMPLATES.required_checklist },
  { id: "failure_diagnostics", ...SECTION_TEMPLATES.failure_diagnostics },
  { id: "unknowns", ...SECTION_TEMPLATES.unknowns },
];

const TRANSCRIPT_FAILURE_SECTIONS: PlannedAnswerSection[] = [
  { id: "attempt_routes", ...SECTION_TEMPLATES.attempt_routes },
  { id: "diagnostics", ...SECTION_TEMPLATES.diagnostics },
  { id: "transcript_fallback", ...SECTION_TEMPLATES.transcript_fallback },
  { id: "will_not_do", ...SECTION_TEMPLATES.will_not_do },
];

export type DepthAnswerClass =
  | "local_model_setup"
  | "implementation_audit"
  | "current_source_synthesis"
  | "capability_diagnostic"
  | "transcript_failure"
  | "scraping_comparison"
  | "generic_deep_answer";

export function classifyDepthAnswerClass(taskSpec: WebResearchTaskSpec, userMessage: string, routeKind: string): DepthAnswerClass {
  const lowered = userMessage.toLowerCase();
  if (taskSpec.taskKind === "local_model_setup") return "local_model_setup";
  if (taskSpec.taskKind === "current_source_synthesis") return "current_source_synthesis";
  if (/\b(?:youtube|transcript|caption)s?\b/i.test(lowered) && /\b(?:fail|failed|unavailable|could not|no captions?|missing)\b/i.test(lowered)) return "transcript_failure";
  if (/\b(?:scrape?|crawl|document|ingest|fetch)\b/i.test(lowered) && /\b(?:compare|better|faster|improve|superior)\b/i.test(lowered)) return "scraping_comparison";
  if (/\b(?:reference\s+(?:app|agent)|implementation|gap|parity|output quality|fix plan|improvement)\b/i.test(lowered)) return "implementation_audit";
  if (/\b(?:image|youtube|transcript|caption|capability|configured|available)\b/i.test(lowered)) return "capability_diagnostic";
  return "generic_deep_answer";
}

export function planAnswerSections(input: {
  taskSpec: WebResearchTaskSpec;
  contractIssues: string[];
  routeKind: string;
  userMessage?: string;
  answerClass?: DepthAnswerClass;
}): PlannedAnswerSection[] {
  const answerClass = input.answerClass ?? classifyDepthAnswerClass(input.taskSpec, input.userMessage ?? "", input.routeKind);

  let sections: PlannedAnswerSection[];
  switch (answerClass) {
    case "local_model_setup":
      sections = [...LOCAL_MODEL_SETUP_SECTIONS];
      break;
    case "current_source_synthesis":
      sections = [...CURRENT_SOURCE_SECTIONS];
      break;
    case "implementation_audit":
      sections = [...IMPLEMENTATION_AUDIT_SECTIONS];
      break;
    case "capability_diagnostic":
      sections = [...CAPABILITY_DIAGNOSTIC_SECTIONS];
      break;
    case "transcript_failure":
      sections = [...TRANSCRIPT_FAILURE_SECTIONS];
      break;
    case "scraping_comparison":
      sections = [
        { id: "confirmed_facts", ...SECTION_TEMPLATES.confirmed_facts },
        { id: "measurement_table", ...SECTION_TEMPLATES.measurement_table },
        { id: "failure_diagnostics", ...SECTION_TEMPLATES.failure_diagnostics },
        { id: "implementation_plan", ...SECTION_TEMPLATES.implementation_plan },
        { id: "tests_validation", ...SECTION_TEMPLATES.tests_validation },
        { id: "safety_boundaries", ...SECTION_TEMPLATES.safety_boundaries },
        { id: "unknowns", ...SECTION_TEMPLATES.unknowns },
      ];
      break;
    default:
      sections = [...LOCAL_MODEL_SETUP_SECTIONS.slice(0, 5), ...CURRENT_SOURCE_SECTIONS.slice(0, 4)];
      break;
  }

  const issueSet = new Set(input.contractIssues.map((i) => i.toLowerCase()));

  for (const section of sections) {
    section.required = true;
  }

  if (issueSet.has("too_shallow_for_depth_prompt") || issueSet.has("too_shallow")) {
    for (const section of sections) {
      if (section.minBullets !== undefined) {
        section.minBullets = Math.max(section.minBullets, Math.ceil(section.minBullets * 1.5));
      }
    }
  }

  return sections;
}

export function sectionPlanToString(plan: PlannedAnswerSection[]): string {
  const required = plan.filter((s) => s.required);
  const optional = plan.filter((s) => !s.required);
  const parts: string[] = ["Required sections:"];

  for (const section of required) {
    const modifiers: string[] = [];
    if (section.minBullets) modifiers.push(`at least ${section.minBullets} concrete items`);
    if (section.requiredArtifacts?.length) modifiers.push(`must include: ${section.requiredArtifacts.join(", ")}`);
    if (section.requiredEvidencePurposes?.length) modifiers.push(`needs evidence from: ${section.requiredEvidencePurposes.join(", ")}`);
    parts.push(`- ## ${section.title}${modifiers.length > 0 ? ` (${modifiers.join("; ")})` : ""}`);
  }

  if (optional.length > 0) {
    parts.push("", "Optional sections (include if evidence supports):");
    for (const section of optional) {
      parts.push(`- ## ${section.title}`);
    }
  }

  return parts.join("\n");
}

export function mapRequirementsToAnswerArtifacts(spec: WebResearchTaskSpec): ResearchAnswerArtifact[] {
  const artifacts: ResearchAnswerArtifact[] = [];
  if (spec.requiredAnswerSections.includes("recommendation") || spec.requiredAnswerSections.includes("setup_steps")) {
    artifacts.push("commands");
  }
  if (spec.requiredAnswerSections.includes("source_category_separation")) {
    artifacts.push("source_category_table");
  }
  if (spec.requiredAnswerSections.includes("setup_steps")) {
    artifacts.push("setup_matrix");
    artifacts.push("validation_checklist");
  }
  if (spec.requiredAnswerSections.includes("failure_risks") || spec.requiredAnswerSections.includes("tradeoffs")) {
    artifacts.push("failure_diagnostics");
  }
  if (spec.requiredAnswerSections.includes("tradeoffs")) {
    artifacts.push("measurement_table");
  }
  if (spec.requiredAnswerSections.includes("unknowns") || spec.requiredAnswerSections.includes("uncertainty_statement")) {
    artifacts.push("unknowns");
  }
  return Array.from(new Set(artifacts));
}
