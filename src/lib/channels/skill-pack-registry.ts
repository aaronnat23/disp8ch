import type { BroadTaskKind } from "@/lib/channels/broad-task-decision";
import { TOOL_CATALOG } from "@/lib/engine/tools";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";
import { WEB_RESEARCH_RESILIENCE_PLAYBOOK } from "@/lib/channels/web-research-resilience";

export type SkillPackId =
  | "disp8ch-workflow-design"
  | "disp8ch-repo-plan"
  | "disp8ch-web-research"
  | "disp8ch-composition";

export type SkillPack = {
  id: SkillPackId;
  name: string;
  description: string;
  injectOnlyWhenNeeded: boolean;
  systemPrompt: string;
};

const WORKFLOW_DESIGN_SKILL: SkillPack = {
  id: "disp8ch-workflow-design",
  name: "disp8ch AI Workflow Design",
  description: "Lane-scoped skill pack for disp8ch AI workflow/automation design tasks",
  injectOnlyWhenNeeded: true,
  systemPrompt: (() => {
    const templateNames = listWorkflowTemplateCatalog().map((t) => `${t.key} (${t.name})`).join(", ");
    const toolNames = Object.keys(TOOL_CATALOG).filter((n) => TOOL_CATALOG[n]).slice(0, 20).map((n) => `- ${n}`).join("\n");
    return [
      "disp8ch AI Workflow Design Skill:",
      "",
      "Real node vocabulary (use exact names):",
      "- Trigger nodes: cron-trigger, message-trigger, webhook-trigger, manual-trigger",
      "- Agent nodes: claude-agent, parallel-agents, call-workflow",
      "- Channel nodes: send-webchat, send-telegram, send-discord, send-whatsapp, send-slack, send-bluebubbles, send-teams, send-email",
      "- Logic nodes: if-else, switch, filter, delay, set-variables, loop, aggregate, merge, error-handler",
      "- Memory nodes: memory-recall, memory-store",
      "- Tool nodes: system-command, http-request, run-code, read-file, write-file, board-task, document-tool, workflow-template, scheduler-job, date-time, channel-status, council",
      "- Adv nodes: wait-for-input, rate-limiter, json-transform, split-text, regex-extract, compare-text, database-query, clipboard, notification, git-operation, archive",
      "",
      `Available workflow templates: ${templateNames}`,
      `Available WebChat tools: ${toolNames}`,
      "",
      "Confirmation boundaries:",
      "- Do NOT create, save, schedule, run, send, or execute anything unless the user explicitly confirms a specific operation.",
      "- Produce a plan with trigger, nodes, data flow, risks, and tests.",
      "- Only propose node types that exist in the registry above — label unknown ones explicitly.",
      "- Separate visual workflow node types from WebChat app-control tools.",
      "",
      "Expected answer sections:",
      "- Trigger: what starts the workflow",
      "- Nodes: list of node types with their role",
      "- Data flow: how data moves between nodes",
      "- Error handling: what happens on failure",
      "- Risks: what could go wrong",
      "- Tests: how to validate the workflow",
      "- Confirmation boundary: what the user must approve before execution",
    ].join("\n");
  })(),
};

const REPO_PLAN_SKILL: SkillPack = {
  id: "disp8ch-repo-plan",
  name: "disp8ch AI Repo Plan",
  description: "Lane-scoped skill pack for repo-grounded implementation plans",
  injectOnlyWhenNeeded: true,
  systemPrompt: [
    "disp8ch AI Repo Plan Skill:",
    "",
    "How to cite files:",
    "- Cite only files actually read or listed by tools.",
    "- Search/list results are hints — classify targets as 'candidates'.",
    "- File read results are verified evidence — cite the exact path.",
    "- For proposed new files, prefix with 'proposed:'.",
    "",
    "What counts as verified evidence:",
    "- File content from read_file: verified.",
    "- Directory listing from list_files: verified for existence, unverified for contents.",
    "- Search results from search_files: verified for pattern match, unverified for file contents.",
    "- Web search/fetch results: verified if fetched/opened.",
    "",
    "Required implementation-plan sections when requested:",
    "- Files to touch: concrete file paths (verified evidence or clearly proposed)",
    "- Risks: what could break or fail",
    "- Dependencies: what the change depends on or which packages/libs are needed (or 'no dependency' rationale)",
    "- Tests: how to validate correctness",
    "- Acceptance criteria: how to know the work is done",
    "",
    "Rules:",
    "- Do not implement or edit files unless explicitly asked.",
    "- Do not name exact behavior or file contents without read evidence.",
    "- If evidence is insufficient, say what is missing and label recommendations as inference.",
  ].join("\n"),
};

const WEB_RESEARCH_SKILL: SkillPack = {
  id: "disp8ch-web-research",
  name: "disp8ch AI Web Research",
  description: "Lane-scoped skill pack for web research tasks",
  injectOnlyWhenNeeded: true,
  systemPrompt: [
    "disp8ch AI Web Research Skill:",
    "",
    "Source hierarchy (prefer highest available):",
    "- 1. Official documentation, model cards, release notes, changelogs",
    "- 2. GitHub repos, issues, pull requests, releases",
    "- 3. Reputable tech publications and community discussions",
    "- 4. Social media / forums (treat as directional, not authoritative)",
    "",
    "Search recovery:",
    "- Try at least two materially different searches when first results are weak.",
    "- If a search returns no results, reformulate without brand/model-specific terms.",
    "- Fetch or open sources before citing them.",
    "",
    "Citation rules:",
    "- Every source link must come from fetched/opened evidence, not search-result snippets.",
    "- Include source date or access date for current/recent claims.",
    "- Search result snippets are hints, not citations.",
    "- If a source could not be fetched, say 'search results indicate' rather than citing the URL.",
    "- Separate verified findings from inferences.",
    "",
    WEB_RESEARCH_RESILIENCE_PLAYBOOK,
  ].join("\n"),
};

const COMPOSITION_SKILL: SkillPack = {
  id: "disp8ch-composition",
  name: "disp8ch AI Composition",
  description: "Lane-scoped skill pack for composition/writing tasks",
  injectOnlyWhenNeeded: true,
  systemPrompt: [
    "disp8ch AI Composition Skill:",
    "",
    "Rules:",
    "- Do NOT use tools for composition tasks (no web search, no file inspection).",
    "- Preserve the requested format, line count, or bullet count exactly.",
    "- Use conversation history for transformations — transform the prior answer, do not re-search.",
    "- Stay concise. A 'draft a 6-line product update' means exactly 6 lines, no preamble.",
    "- Do not add workflow boilerplate, repo inspection, or app-design sections.",
    "- Answer only the composition task asked, not a superset of it.",
  ].join("\n"),
};

const SKILL_PACKS: Record<SkillPackId, SkillPack> = {
  "disp8ch-workflow-design": WORKFLOW_DESIGN_SKILL,
  "disp8ch-repo-plan": REPO_PLAN_SKILL,
  "disp8ch-web-research": WEB_RESEARCH_SKILL,
  "disp8ch-composition": COMPOSITION_SKILL,
};

export function getSkillPack(id: SkillPackId): SkillPack | undefined {
  return SKILL_PACKS[id];
}

export function getSkillPackForTaskKind(kind: BroadTaskKind): SkillPack | undefined {
  switch (kind) {
    case "app_workflow_design": return SKILL_PACKS["disp8ch-workflow-design"];
    case "repo_plan": return SKILL_PACKS["disp8ch-repo-plan"];
    case "web_research": return SKILL_PACKS["disp8ch-web-research"];
    case "composition":
    case "transformation": return SKILL_PACKS["disp8ch-composition"];
    default: return undefined;
  }
}

export function buildSkillPackPrompt(kind: BroadTaskKind): string {
  const pack = getSkillPackForTaskKind(kind);
  return pack ? pack.systemPrompt : "";
}

export function getSkillPackSize(id: SkillPackId): number {
  return SKILL_PACKS[id]?.systemPrompt.length ?? 0;
}

export function listSkillPacks(): SkillPack[] {
  return Object.values(SKILL_PACKS);
}
