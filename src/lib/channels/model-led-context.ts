import {
  BROAD_RESEARCH_QUALITY_GATE,
  BROAD_RESEARCH_SEARCH_RECOVERY,
  BROAD_RESEARCH_TOOL_GUIDANCE,
  getBroadResearchSourceHints,
  isLikelyBroadResearchPrompt,
  isSessionOnlyDirectAnswerPrompt,
  needsCurrentPublicFacts,
  needsRepoGrounding,
} from "@/lib/channels/broad-research-prompt";
import { WEB_RESEARCH_RESILIENCE_PLAYBOOK } from "@/lib/channels/web-research-resilience";
import { buildDisp8chSystemMap } from "@/lib/channels/disp8ch-system-map";
import { buildLanePlaybook } from "@/lib/channels/lane-playbooks";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";
import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";
import { buildCompactToolIndex, buildAppFeatureContext } from "@/lib/channels/app-feature-context";
import { buildCapabilityManifestPrompt } from "@/lib/channels/capability-manifest";
import type { AccuracyMode } from "@/lib/agents/tool-trace";

export type ModelLedLane =
  | "direct"
  | "read_only_workspace"
  | "broad_research"
  | "repo_inspection"
  | "app_design"
  | "app_mutation_proposal"
  | "memory_recall";

const REPO_PATTERNS = [
  /\b(repo|repository|codebase|workspace|files?|src\/|route\.ts|implementation|latency|bug|review|inspect)\b/i,
  /\bdo not edit\b/i,
  /\bfile paths?\b/i,
];

const APP_DESIGN_PATTERNS = [
  /\b(plan|proposal|propose|design|draft|blueprint|how would|how can we improve)\b/i,
  /\b(workflow|agent|board|task|hierarchy|council|schedule|automation|automations|webhook|webhooks|cron|channel|memory|model)\b/i,
];

const MEMORY_PATTERNS = [
  /\b(remember|recall|what did i say|what is .*codename|memory|saved fact|last time)\b/i,
];

const MUTATION_PATTERNS = [
  /\b(create|update|delete|save|run|start|execute|schedule|send|install|connect|configure|set\s+up|enable|disable|toggle|rotate|regenerate|reset)\b/i,
];

const READ_ONLY_QUALIFIERS = [
  /\bdo not (create|edit|implement|save|run|start|execute|schedule|send)\b/i,
  /\bwithout (creating|editing|implementing|saving|running|starting|executing|scheduling|sending)\b/i,
  /\bplan\b/i,
  /\bdraft\b/i,
  /\bproposal\b/i,
];

const SESSION_POLICY_PATTERNS = [
  /\bcurrent\s+(?:webchat\s+)?session\b/i,
  /\b(?:webchat\s+)?session\s+(?:should\s+)?decide\b/i,
  /\btool\s+(?:mode|usage|policy|budget)\b/i,
  /\bfast,\s*balanced,\s*(?:and\s*)?thorough\b/i,
  /\bbroad\s+non[-\s]?deterministic\s+prompts?\b/i,
];

export const TOOL_PACKS: Record<ModelLedLane, string[]> = {
  direct: [],
  read_only_workspace: [
    "channel_status",
    "documents_list",
    "documents_search",
    "documents_semantic_search",
    "document_get",
    "memory_search",
    "memory_get",
    "session_recall",
  ],
  broad_research: [
    "web_search",
    "web_extract",
    "web_crawl",
    "fetch_url",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_get_text",
    "browser_get_links",
    "browser_get_images",
    "browser_vision",
    "browser_cdp",
    "browser_dialog",
    "browser_wait",
    "browser_back",
    "browser_console",
    "browser_action",
    "computer_observe",
    "computer_list_apps",
    "computer_zoom",
    "computer_wait",
    "documents_search",
    "documents_semantic_search",
    "document_get",
    "memory_search",
    "memory_get",
    "search_files",
    "read_file",
    "pc_specs",
  ],
  repo_inspection: [
    "list_files",
    "search_files",
    "read_file",
    "code_review",
    "memory_search",
    "session_recall",
  ],
  app_design: [
    "channel_status",
    "workflow_templates",
    "workflow_list",
    "workflow_get",
    "workflow_execution_status",
    "schedules_list",
    "webhooks_list",
    "board_tasks",
    "governance_queue",
    "documents_list",
    "documents_search",
    "documents_semantic_search",
    "document_get",
    "memory_search",
    "memory_get",
    "session_recall",
    "search_files",
    "read_file",
  ],
  app_mutation_proposal: [
    "channel_status",
    "workflow_templates",
    "workflow_list",
    "workflow_get",
    "workflow_run",
    "workflow_execution_status",
    "workflow_toggle_active",
    "workflow_duplicate",
    "workflow_update_node",
    "workflow_set_model",
    "workflow_create_credential",
    "workflow_attach_credential",
    "workflow_update_schedule",
    "workflow_delete",
    "schedules_list",
    "webhooks_list",
    "webhooks_create",
    "webhooks_rotate_secret",
    "webhooks_toggle",
    "webhooks_delete",
    "board_tasks",
    "governance_queue",
    "documents_list",
    "documents_search",
    "documents_semantic_search",
    "document_get",
    "memory_search",
    "memory_get",
    "session_recall",
  ],
  memory_recall: [
    "session_recall",
    "memory_search",
    "memory_get",
  ],
};

export function classifyContextLane(input: {
  message: string;
  intentKind?: string;
  readOnly: boolean;
}): ModelLedLane {
  const message = String(input.message || "");
  const intentKind = String(input.intentKind || "");

  if (intentKind === "direct-answer") return "direct";
  if (isSessionOnlyDirectAnswerPrompt(message)) return "direct";

  const contract = determineTaskIntentContract(message);
  if (contract.toolPolicy === "forbidden") return "direct";
  if (intentKind === "app-mutation-proposal" && input.readOnly && READ_ONLY_QUALIFIERS.some((pattern) => pattern.test(message))) {
    return "app_design";
  }
  if (intentKind === "app-mutation-proposal") return "app_mutation_proposal";
  if (MEMORY_PATTERNS.some((pattern) => pattern.test(message))) return "memory_recall";
  if (isLikelyBroadResearchPrompt(message) || needsCurrentPublicFacts(message)) return "broad_research";
  if (SESSION_POLICY_PATTERNS.some((pattern) => pattern.test(message))) {
    return /\b(?:ground|grounded|app\s+behavior|code|files?|implementation|current\s+behavior)\b/i.test(message)
      ? "repo_inspection"
      : "read_only_workspace";
  }
  if (needsRepoGrounding(message) || REPO_PATTERNS.some((pattern) => pattern.test(message))) return "repo_inspection";

  const appDesign = APP_DESIGN_PATTERNS.some((pattern) => pattern.test(message));
  const mutation = MUTATION_PATTERNS.some((pattern) => pattern.test(message));
  const readOnlyQualifier = READ_ONLY_QUALIFIERS.some((pattern) => pattern.test(message));
  if (appDesign && (!mutation || readOnlyQualifier || input.readOnly)) return "app_design";
  if (mutation && !input.readOnly) return "app_mutation_proposal";
  return "read_only_workspace";
}

export function getToolsForModelLedLane(lane: ModelLedLane, opts: { forceTools?: boolean } = {}): string[] {
  if (opts.forceTools && lane === "direct") {
    return Array.from(new Set([
      ...TOOL_PACKS.read_only_workspace,
      ...TOOL_PACKS.broad_research,
      ...TOOL_PACKS.repo_inspection,
    ]));
  }
  return TOOL_PACKS[lane] ?? TOOL_PACKS.read_only_workspace;
}

export function buildWorkspaceAuthorityBlock(workspacePath?: string | null): string {
  const workspace = workspacePath?.trim() || process.cwd();
  return [
    "Workspace authority:",
    `- Current workspace: ${workspace}`,
    "- This workspace context is newer than prior conversation context.",
    "- For file and repo claims, prefer current tool results from this workspace.",
    "- Cite real file paths for repo-specific claims.",
    "- Do not assume files exist unless listed, searched, read, or present in the startup snapshot.",
  ].join("\n");
}

function buildDisp8chCapabilityContext(): string {
  const templates = listWorkflowTemplateCatalog()
    .map((entry) => `${entry.name} (${entry.key})`)
    .join("; ");
  return [
    "disp8ch AI capability context:",
    "- disp8ch AI can configure agents, tools, skills, extensions, models, channel routes, schedules, boards, memory, hierarchy organizations, council debates, and workflow templates.",
    "- For vague app requests, design the best disp8ch AI path first. Do not execute or mutate until the user approves an explicit operation.",
    "- Visual workflow node types are different from WebChat tools. For visual workflow drafts, use node types such as cron-trigger, run-code, http-request, board-task, send-webchat, if-else, switch, filter, loop, aggregate, merge, delay, memory-recall, and claude-agent.",
    "- WebChat tools such as workflow_templates, workflow_create, schedule_task, board_tasks, and send_message are assistant/app-control tools; use them for inspection or confirmation boundaries, not as visual node types.",
    `- Workflow templates available: ${templates}`,
  ].join("\n");
}

export function buildToolBudgetInstruction(lane: ModelLedLane): string {
  const laneSpecific = (() => {
    switch (lane) {
      case "broad_research":
        return "Broad research budget: gather enough source diversity for the question; use fetched/read sources for citations.";
      case "repo_inspection":
        return "Repo inspection budget: map, search, and read enough real files to support the conclusion; reread the same file only for a different range.";
      case "app_design":
      case "app_mutation_proposal":
        return "App design budget: inspect actual app surfaces, templates, schedules, boards, governance, memory, or docs before proposing a non-trivial design. Do not call mutation tools unless explicitly approved.";
      case "memory_recall":
        return "Memory budget: prefer exact/session recall first; use at most 3 semantic memory searches.";
      default:
        return "Use tools only when they materially improve correctness.";
    }
  })();
  return [
    "Tool budget:",
    "- Use the minimum sufficient evidence, not the minimum number of tools.",
    "- For thorough prompts, do not stop after the first plausible answer. Continue until the required evidence types are satisfied or a real stop condition is reached.",
    "- Prefer parallel independent tool calls when the provider supports them, such as reading multiple candidate files or fetching multiple sources in one model step.",
    "- Do not repeat the same tool call with the same arguments.",
    "- Stop only when additional tools are unlikely to change the conclusion, would repeat prior evidence, or would violate the user's side-effect boundary.",
    "- If a budget stops further tools, answer from collected evidence and state what remains unverified.",
    laneSpecific,
  ].join("\n");
}

export function buildEvidenceLedgerInstruction(): string {
  return [
    "Evidence standard:",
    "- Important claims should trace to an observed source, file, memory item, document, or app-state result.",
    "- Separate verified facts from inference.",
    "- For web research, search results are hints. Fetch or open a source before treating it as evidence. Do not cite a URL unless it appears in fetched/browser evidence.",
    "- For repo work, cite real file paths.",
    "- Do not invent citations or claim a source was checked if it was not.",
  ].join("\n");
}

function buildToolCards(lane: ModelLedLane, accuracyMode?: string): string {
  const allowed = new Set(TOOL_PACKS[lane] ?? []);
  const toolNames = Array.from(allowed);
  if (toolNames.length === 0) return "";

  if (accuracyMode === "thorough") {
    const cards: Record<string, string> = {
      web_search: "finds candidate URLs only; search results are hints and cannot be cited by themselves.",
      web_extract: "opens URLs and returns verified page content, title/final URL/date when available.",
      web_crawl: "bounded crawl for small docs/release/source clusters; cite only returned verified URLs.",
      fetch_url: "low-level URL fetch; useful fallback when web_extract fails.",
      browser_navigate: "opens dynamic or blocked pages when extract is thin; use with browser_snapshot for page state.",
      browser_snapshot: "returns compact page state and interactive refs; use full=true for full text/links on research pages.",
      browser_get_links: "extracts real candidate URLs from search/index/dynamic pages.",
      read_file: "direct repo evidence; required before making behavior claims about code.",
      search_files: "find candidate files/symbols; search output alone does not prove behavior.",
      list_files: "map repo structure before targeted reads.",
      memory_search: "recall user/project preferences; not public facts.",
      memory_get: "read a durable memory by id/source.",
      schedules_list: "reads live Automations cron state from the database and scheduler; use before answering current schedule inventory.",
      webhooks_list: "reads live webhook automation state plus exact HMAC signing contract without secrets; use before answering current webhook inventory or signing instructions.",
      webhooks_create: "creates a webhook automation for an existing workflow and returns the signing secret once.",
      webhooks_rotate_secret: "rotates a webhook signing secret and returns the new secret once.",
      webhooks_toggle: "enables or disables a webhook automation.",
      webhooks_delete: "deletes a webhook automation after explicit user request.",
    };
    const lines = Object.entries(cards)
      .filter(([tool]) => allowed.has(tool))
      .map(([tool, text]) => `- ${tool}: ${text}`);
    if (!lines.length) return buildCompactToolIndex(toolNames);
    return [
      `Tool cards for ${lane}:`,
      ...lines,
      "",
      "Use tool_docs_search to get full documentation for any tool listed above.",
    ].join("\n");
  }

  return buildCompactToolIndex(toolNames);
}

function buildLaneSkillCard(lane: ModelLedLane): string {
  switch (lane) {
    case "broad_research":
      return [
        "Lane skill: web-research v1",
        "Purpose: answer current/public/source-backed questions with verified sources.",
        "Use tools: search for candidates, extract/open sources, browser-escalate when extraction is blocked or thin.",
        "Stop when: source diversity is enough for the requested decision or the answer must honestly state limited evidence.",
        "Never: cite search snippets, fabricate source links, or paste raw evidence-pack text.",
      ].join("\n");
    case "repo_inspection":
      return [
        "Lane skill: repo-inspection v1",
        "Purpose: answer codebase questions from real workspace evidence.",
        "Use tools: map/search/read files before behavior claims; cite real paths.",
        "Stop when: relevant code paths have been read and risks/tests are grounded.",
        "Never: name implementation targets as existing unless listed/read, or claim verification from a repo map alone.",
      ].join("\n");
    case "app_design":
    case "app_mutation_proposal":
      return [
        "Lane skill: workflow-design v1",
        "Purpose: design disp8ch AI workflows and app plans using actual surfaces.",
        "Use tools: inspect templates, node registry, schedules, boards, documents, and memory as needed.",
        "Stop when: trigger, nodes/tools, data flow, risks, tests, and confirmation boundary are clear.",
        "Never: mutate app state for a plan request or mix WebChat tool names with visual node types.",
      ].join("\n");
    case "memory_recall":
      return [
        "Lane skill: memory-recall v1",
        "Purpose: recall durable user/project facts accurately.",
        "Use tools: exact/session recall first for recent identifiers, semantic memory for stable preferences.",
        "Stop when: source memory is found or uncertainty is explicit.",
        "Never: treat memory as public/current fact evidence.",
      ].join("\n");
    default:
      return "";
  }
}

function shouldIncludeDisp8chSystemMap(input: {
  lane: ModelLedLane;
  message: string;
  repoGrounded: boolean;
}): boolean {
  if (input.lane === "app_design" || input.lane === "app_mutation_proposal" || input.lane === "repo_inspection") return true;
  if (input.lane === "broad_research" && input.repoGrounded) return true;
  return /\b(disp8ch|reference\s+(?:app|agent)|workflow|scheduler|board|hierarchy|council|tools?|agents?|channels?)\b/i.test(input.message);
}

export function buildModelLedContextPack(input: {
  lane: ModelLedLane;
  message: string;
  sessionId: string;
  agentId: string;
  workspacePath?: string | null;
  startupSnapshot?: string | null;
  appStateSummary?: string | null;
  modelId?: string | null;
  provider?: string | null;
  accuracyMode?: AccuracyMode | null;
}): string {
  const broadResearch = input.lane === "broad_research";
  const sourceHints = broadResearch ? getBroadResearchSourceHints(input.message) : "";
  const repoGrounded = input.lane === "repo_inspection" || needsRepoGrounding(input.message);
  const currentFacts = broadResearch && needsCurrentPublicFacts(input.message);
  const needsWorkspace = repoGrounded || input.lane === "app_design" || input.lane === "app_mutation_proposal";
  const accuracyMode = input.accuracyMode ?? (input.lane === "broad_research" || input.lane === "repo_inspection" ? "thorough" : undefined);

  const parts = [
    "You are operating inside disp8ch AI.",
    "Answer the user's actual request. Do not replace analysis, comparison, research, design, or planning with an app mutation.",
    "The model decides the strategy. disp8ch AI policy decides the allowed tools, side-effect boundary, and evidence standard.",
    "Never output raw tool-call syntax. If a tool is unavailable, say what could not be verified and continue with the best supported answer.",
    `Selected model-led lane: ${input.lane}.`,
    `Session: ${input.sessionId}. Agent: ${input.agentId}.`,
    input.provider || input.modelId ? `Model context: ${input.provider || "unknown"}:${input.modelId || "unknown"}.` : "",
    buildToolBudgetInstruction(input.lane),
    buildEvidenceLedgerInstruction(),
    buildLanePlaybook(input.lane),
    buildToolCards(input.lane, accuracyMode),
    buildLaneSkillCard(input.lane),
    shouldIncludeDisp8chSystemMap({ lane: input.lane, message: input.message, repoGrounded }) ? buildDisp8chSystemMap() : "",
    input.lane !== "direct" ? buildCapabilityManifestPrompt() : "",
    needsWorkspace ? buildWorkspaceAuthorityBlock(input.workspacePath) : "",
    input.lane === "app_design" || input.lane === "app_mutation_proposal" ? [
      buildDisp8chCapabilityContext(),
      buildAppFeatureContext(["nodes", "templates", "workflow_mgmt"]),
    ].filter(Boolean).join("\n\n") : "",
    input.lane === "read_only_workspace" ? buildAppFeatureContext(["surfaces", "commands"]) : "",
    broadResearch ? BROAD_RESEARCH_TOOL_GUIDANCE : "",
    broadResearch ? BROAD_RESEARCH_SEARCH_RECOVERY : "",
    broadResearch ? BROAD_RESEARCH_QUALITY_GATE : "",
    broadResearch ? WEB_RESEARCH_RESILIENCE_PLAYBOOK : "",
    sourceHints ? `Candidate sources. Treat as hints, not facts; verify before relying on them.\n${sourceHints}` : "",
    currentFacts ? "This request may depend on current public facts. Use web/source tools before making current claims." : "",
    repoGrounded ? "This request may depend on this repository. Use repo tools before making repo-specific claims, and cite real local file paths." : "",
    input.startupSnapshot || "",
    input.appStateSummary || "",
  ];

  return parts.filter((part) => part && part.trim()).join("\n\n");
}
