export type EvidenceNeed =
  | "workspace_files"
  | "app_state"
  | "web_current"
  | "official_docs"
  | "memory"
  | "benchmark_artifacts"
  | "tool_catalog"
  | "workflow_templates"
  | "scheduler_state"
  | "board_state"
  | "hierarchy_state"
  | "council_state"
  | "source_verification"
  | "none";

export type EvidenceNeedItem = {
  kind: EvidenceNeed;
  reason: string;
  priority: "required" | "helpful" | "optional";
};

export type EvidencePlan = {
  mode: "fast" | "balanced" | "thorough";
  needs: EvidenceNeedItem[];
  stopCriteria: string[];
  risks: string[];
};

const WORKSPACE_PATTERNS = [
  /\b(repo|codebase|file|src\/|route|workspace|inspect|bottleneck|bug|latency|implementation)\b/i,
];
const WEB_PATTERNS = [
  /\b(current|latest|recent|today|news|web|online|public|compare.*model|model.*compare|search)\b/i,
];
const APP_STATE_PATTERNS = [
  /\b(config|setting|channel|workflow|agent|board|schedule|status)\b/i,
];
const MEMORY_PATTERNS = [
  /\b(remember|recall|what did|memory|saved|last time|history)\b/i,
];
const BENCHMARK_PATTERNS = [
  /\b(benchmark|comparison|reference\s+(?:app|agent)|result|test|score|timing|run)\b/i,
];
const TOOL_CATALOG_PATTERNS = [/\b(tool|node|workflow node|available tools|can you use)\b/i];
const WORKFLOW_TEMPLATE_PATTERNS = [/\b(template|workflow|automation|cron|schedule|reminder)\b/i];
const BOARD_PATTERNS = [/\b(board|task|kanban|acceptance criteria)\b/i];
const HIERARCHY_PATTERNS = [/\b(hierarchy|organization|goal|crew|worker|orchestrator)\b/i];
const COUNCIL_PATTERNS = [/\b(council|debate|panel|roles|verdict)\b/i];
const SOURCE_VERIFICATION_PATTERNS = [/\b(cite|source|url|public web|online|research)\b/i];

export function buildEvidencePlan(input: {
  message: string;
  mode: "fast" | "balanced" | "thorough";
  lane: string;
}): EvidencePlan {
  const { message, mode } = input;

  if (mode === "fast") {
    return {
      mode,
      needs: [{ kind: "none", reason: "fast mode: no external evidence needed", priority: "optional" }],
      stopCriteria: ["Answer from available context."],
      risks: [],
    };
  }

  const needs: EvidenceNeedItem[] = [];

  if (WORKSPACE_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "workspace_files", reason: "message references repo or workspace files", priority: "required" });
  }
  if (WEB_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "web_current", reason: "message references current or public information", priority: "required" });
  }
  if (APP_STATE_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "app_state", reason: "message references app configuration or state", priority: "helpful" });
  }
  if (MEMORY_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "memory", reason: "message references user memory or history", priority: "required" });
  }
  if (BENCHMARK_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "benchmark_artifacts", reason: "message references benchmark, comparison, or test results", priority: "helpful" });
  }
  if (TOOL_CATALOG_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "tool_catalog", reason: "message references tools or workflow node vocabulary", priority: input.lane === "app_design" ? "required" : "helpful" });
  }
  if (WORKFLOW_TEMPLATE_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "workflow_templates", reason: "message references workflows, templates, schedules, or reminders", priority: input.lane === "app_design" ? "required" : "helpful" });
  }
  if (BOARD_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "board_state", reason: "message references board tasks or acceptance criteria", priority: "helpful" });
  }
  if (HIERARCHY_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "hierarchy_state", reason: "message references hierarchy, goals, organizations, or crew structure", priority: "helpful" });
  }
  if (COUNCIL_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "council_state", reason: "message references council debate, roles, or verdicts", priority: "helpful" });
  }
  if (SOURCE_VERIFICATION_PATTERNS.some((p) => p.test(message))) {
    needs.push({ kind: "source_verification", reason: "message asks for source-grounded research or citations", priority: "required" });
  }

  if (needs.length === 0) {
    needs.push({ kind: "none", reason: "no specific evidence need detected; use available context", priority: "optional" });
  }

  const requiredNeeds = needs.filter((n) => n.priority === "required").map((n) => n.kind);
  const stopCriteria = [
    requiredNeeds.length > 0
      ? `Stop when these required evidence needs are satisfied: ${requiredNeeds.join(", ")}.`
      : "Stop when available context is sufficient.",
    "Stop when two consecutive tools return no new useful information.",
    "Stop when the same tool/path fails twice.",
    "Stop when enough evidence exists to answer the key question.",
  ];

  const risks = [
    "Do not invent file paths or sources not confirmed by tool results.",
    "Separate verified facts from inference.",
    "If a required evidence need cannot be satisfied, say what is missing.",
  ];

  return { mode, needs, stopCriteria, risks };
}

export function formatEvidencePlanInstruction(plan: EvidencePlan): string {
  const required = plan.needs.filter((n) => n.priority === "required");
  const helpful = plan.needs.filter((n) => n.priority === "helpful");
  if (plan.mode === "fast" || (required.length === 0 && helpful.length === 0)) {
    return "";
  }
  const lines = ["Evidence plan:"];
  if (required.length > 0) {
    lines.push(`Required evidence: ${required.map((n) => `${n.kind} (${n.reason})`).join("; ")}.`);
  }
  if (helpful.length > 0) {
    lines.push(`Helpful evidence: ${helpful.map((n) => n.kind).join(", ")}.`);
  }
  lines.push(`Stop criteria: ${plan.stopCriteria[0]}`);
  lines.push(`Risk: ${plan.risks[0]}`);
  return lines.join("\n");
}
