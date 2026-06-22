/**
 * Workflow template recommendation scoring helpers.
 * Extracted from router.ts so the planner and other modules can use them
 * without importing the entire router.
 *
 * The originals in router.ts call these re-exports so existing behaviour is
 * unchanged.
 */

import {
  listWorkflowTemplateCatalog,
  type WorkflowTemplateCatalogEntry,
} from "@/lib/workflows/template-catalog";

/** Prose descriptions keyed by template key — used in scoring and display. */
export const WORKFLOW_TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "research-assistant": "Useful for web research, data gathering, analysis, and building research documents.",
  "live-research-assistant": "Real-time research with web search, memory recall, and cited synthesis. Best for queries that need current information.",
  "autonomous-research-pipeline": "Multi-stage autonomous pipeline: arXiv + Semantic Scholar, hypothesis council debate, code generation, paper draft. Best for deep research.",
  "experiment-loop": "LLM-guided iterative experiment loop with metrics, benchmarks, keep/discard decisions and summary.",
  "docs-site-crawler-summary": "Crawls a documentation site, stores content, and produces a Claude summary.",
  "document-intelligence": "Loads data sources, analyses content with Claude, stores results in memory.",
  "code-reviewer": "Webhook-triggered code review with Claude feedback posted to WebChat.",
  "smart-file-organizer": "Lists files, categorises them with Claude, archives into sorted folders.",
  "error-resilient-pipeline": "Error-handler wraps an agent step so failures retry via a separate path.",
  "text-processing-pipeline": "Split → regex extract → JSON transform → aggregate.",
  "db-query-dashboard": "Cron-triggered database query with results sent to WebChat.",
  "git-status-reporter": "Cron-triggered git operation summary sent to WebChat.",
  "clipboard-to-memory": "Reads clipboard content and stores it as a memory entry.",
  "hierarchy-orchestrator-team": "Orchestrator + two workers with merge node — hierarchy team execution.",
  "channel-workspace-assistant": "Cross-channel workspace assistant that reacts to messages.",
  "general-task-executor": "Turns a plain board task into a runnable workflow.",
  "ops-control-tower": "Large multi-node ops brief across channels, schedules, boards, council, DB, files, and memory.",
  "hierarchy-board-briefing": "Hierarchy-scoped board flow that creates a follow-up task, writes a report, and stores in memory.",
  "overnight-autonomy-briefing": "Morning briefing for unattended overnight runs: checks schedules, boards, wakeups, approvals, background jobs, memory, WebChat, and Telegram.",
  "gmail-drive-bridge": "Google OAuth — Gmail trigger + Drive actions.",
  "cron-board-task-creator": "Scheduled task creator: cron fires, run-code builds JSON, http-request posts to boards API.",
  "telegram-board-intake": "Multi-channel board commands via Telegram: add tasks, list tasks, run tasks.",
  "ai-crew-orchestrator": "Multi-agent crew orchestration via sessions_spawn and agent_inbox. Best for role-based collaborative work.",
  "parallel-spawn-crew": "Parallel worker fan-out for research, risk, and strategy analysis with synthesis.",
  "strategy-hardening-loop": "Evidence-backed planning loop: research a goal, draft a plan, challenge assumptions, revise it, then return a decision-ready strategy for human approval.",
  "support-signal-triage": "Reviews an inbound support or community signal against memory and documents, then produces a prioritized, human-reviewed reply draft without sending it externally.",
  "subconscious-loop": "Daily cron loop: Claude ideates improvement candidates, council debates, winner stored and queued.",
  "screenshot-analyzer": "Useful when the research input is visual, such as screenshots or UI captures.",
};

/**
 * Score a single template entry against a normalised query string.
 * Higher is better; zero means no match.
 */
export function scoreWorkflowTemplateForQuery(
  entry: WorkflowTemplateCatalogEntry,
  normalizedQuery: string,
): number {
  const haystack = [
    entry.key,
    entry.name,
    ...entry.aliases,
    WORKFLOW_TEMPLATE_DESCRIPTIONS[entry.key] ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const tokens = normalizedQuery
    .replace(
      /\b(what|are|is|the|best|good|workflow|workflows|template|templates|for|can|you|use|show|list|recommend|suggest)\b/g,
      " ",
    )
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token === "research" ? 5 : 2;
  }

  if (
    /\bresearch|study|compare|benchmark|ocr|llm|model|paper|source|web|docs?|document|pdf|extract|crawl|current|latest\b/.test(
      normalizedQuery,
    )
  ) {
    if (
      ["research-assistant", "live-research-assistant", "autonomous-research-pipeline"].includes(
        entry.key,
      )
    )
      score += 10;
    if (
      [
        "experiment-loop",
        "docs-site-crawler-summary",
        "document-intelligence",
        "ai-crew-orchestrator",
        "parallel-spawn-crew",
      ].includes(entry.key)
    )
      score += 6;
    if (entry.key === "simple-chat") score -= 4;
  }

  if (/\bovernight|morning|brief|autonom|sleep|wakeups?|approvals?|telegram|schedule|cron\b/.test(normalizedQuery)) {
    if (entry.key === "overnight-autonomy-briefing") score += 18;
    if (["ops-control-tower", "hierarchy-board-briefing", "subconscious-loop", "endpoint-uptime-watch"].includes(entry.key)) score += 5;
  }

  if (/\bstrategy|plan|planning|critique|critic|adversarial|assumption|decision\b/.test(normalizedQuery) && entry.key === "strategy-hardening-loop") {
    score += 26;
  }

  if (/\bsupport|customer|community|inbound|ticket|reply|response|escalat\b/.test(normalizedQuery) && entry.key === "support-signal-triage") {
    score += 26;
  }

  return score;
}

/**
 * Return top-N template entries scored against a query.
 * Returns at most `limit` entries; defaults to 8.
 */
export function recommendWorkflowTemplates(
  query: string,
  limit = 8,
): Array<{ entry: WorkflowTemplateCatalogEntry; score: number }> {
  const normalizedQuery = query.toLowerCase().trim();
  const entries = listWorkflowTemplateCatalog();
  return entries
    .map((entry) => ({ entry, score: scoreWorkflowTemplateForQuery(entry, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}

/**
 * Format a human-readable template recommendation list.
 * If the query is a bare list request the full catalog is returned.
 */
export function formatWorkflowTemplateRecommendations(
  entries: WorkflowTemplateCatalogEntry[],
  normalizedQuery: string,
): string {
  const hasRecommendationTopic =
    /\bbest|recommend|suggest|for\b/.test(normalizedQuery) &&
    /\bresearch|study|compare|benchmark|ocr|llm|model|paper|source|web|docs?|document|pdf|extract|crawl|current|latest|code|email|gmail|google|ops|monitor|backup|board|schedule|cron|channel|telegram|crew|agent|overnight|morning|brief|autonom|sleep|wake\b/.test(
      normalizedQuery,
    );

  const exactListRequest =
    normalizedQuery === "list workflow templates" ||
    normalizedQuery === "show workflow templates" ||
    normalizedQuery === "list templates" ||
    normalizedQuery === "show templates" ||
    /\b(?:what|show|list)\b.*\b(?:all\s+)?(?:the\s+)?(?:my\s+)?templates\b/.test(normalizedQuery) ||
    normalizedQuery.includes("what workflow templates can you use") ||
    normalizedQuery.includes("what templates can you use");

  if (exactListRequest || !hasRecommendationTopic) {
    return `Workflow templates (${entries.length}):\n${entries
      .map((entry, index) => `${index + 1}. ${entry.name} (${entry.key})`)
      .join("\n")}`;
  }

  const scored = entries
    .map((entry) => ({ entry, score: scoreWorkflowTemplateForQuery(entry, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  const recommended = (scored.length > 0 ? scored.map((item) => item.entry) : entries).slice(0, 8);
  const lines = recommended.map((entry, index) => {
    const detail =
      WORKFLOW_TEMPLATE_DESCRIPTIONS[entry.key] ?? `Template key: ${entry.key}.`;
    return `${index + 1}. ${entry.name} (${entry.key}) - ${detail}`;
  });

  return [
    `Best matching workflow templates (${recommended.length} of ${entries.length}):`,
    ...lines,
    "",
    "To create one, say: create workflow template live research assistant called My Research Assistant",
    "If a template asks for agents, create an agent first in the Agents tab or say: create an agent called Research Agent.",
  ].join("\n");
}
