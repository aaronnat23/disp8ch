import type { EvidenceItem } from "@/lib/channels/evidence-ledger";

export type AnswerQualityIssue =
  | "too_short"
  | "generic_app_design"
  | "unverified_url_citation"
  | "unverified_file_path"
  | "unverified_component_name"
  | "insufficient_repo_reads"
  | "mixed_app_node_tool_vocab"
  | "missing_requested_app_nodes"
  | "missing_user_topic"
  | "unsupported_behavior_claim"
  | "missing_required_sections"
  | "tool_syntax_leak";

function uniqueIssues(issues: AnswerQualityIssue[]): AnswerQualityIssue[] {
  return Array.from(new Set(issues));
}

function evidenceLocators(items: EvidenceItem[]): string[] {
  return items.map((item) => item.locator).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProposedMention(answer: string, value: string): boolean {
  const escaped = escapeRegExp(value);
  return new RegExp(`(?:proposed|new|create|add|candidate|would\\s+add|implementation\\s+target)[^\\n]{0,120}${escaped}`, "i").test(answer) ||
    new RegExp(`${escaped}[^\\n]{0,120}(?:proposed|new|candidate|to\\s+create|to\\s+add)`, "i").test(answer);
}

function hasRepoBehaviorClaims(answer: string): boolean {
  return /\b(?:does|handles|renders|calls|loads|stores|writes|reads|routes|validates|parses|executes|imports|depends|bottleneck|latency|slow|regression|bug|because|implemented|responsible\s+for|verified|confirmed)\b/i.test(answer);
}

function needsRepoSections(userMessage: string): boolean {
  return /\b(?:implementation\s+plan|fix\s+plan|improve|risks?|tests?|acceptance\s+criteria|files?\s+to\s+touch|data\s+flow)\b/i.test(userMessage);
}

function hasRepoSections(answer: string): boolean {
  return /\bFiles?\b[\s\S]*\bRisks?\b[\s\S]*\bTests?\b/i.test(answer) ||
    /\bObserved\b[\s\S]*\bRisks?\b[\s\S]*\bTests?\b/i.test(answer);
}

function requestedWorkflowNodeTypes(userMessage: string): string[] {
  const requested: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\bcron|every\s+\d+\s+minutes?|schedule(?:d|r)?\b/i, "cron-trigger"],
    [/\brun-code|run\s+code|code\s+node\b/i, "run-code"],
    [/\bhttp|post(?:s|ing)?\b/i, "http-request"],
    [/\bboards?|board\s+task|task\b/i, "board-task"],
    [/\bsend-webchat|webchat\b/i, "send-webchat"],
  ];
  for (const [pattern, nodeType] of checks) {
    if (pattern.test(userMessage)) requested.push(nodeType);
  }
  return Array.from(new Set(requested));
}

export function evaluateAnswerQuality(input: {
  answer: string;
  userMessage: string;
  lane: string;
  mode: "fast" | "balanced" | "thorough";
  evidence: EvidenceItem[];
}): { ok: boolean; issues: AnswerQualityIssue[]; repairInstruction: string } {
  const issues: AnswerQualityIssue[] = [];
  const answer = input.answer.trim();

  if (input.mode === "thorough" && answer.split(/\s+/).filter(Boolean).length < 180) {
    issues.push("too_short");
  }

  if (input.lane === "app_design" || input.lane === "app_mutation_proposal") {
    const hasConcreteAppTerms =
      /\b(workflow_templates|workflow_create|schedule_task|schedules_list|webhooks_list|board_tasks|governance_queue|channel_status|Council|Hierarchy|Boards|Automations|Scheduler|Workflows|cron-trigger|webhook-trigger|run-code|http-request|board-task|send-webchat)\b/.test(answer);
    if (!hasConcreteAppTerms) issues.push("generic_app_design");

    const requestedNodes = requestedWorkflowNodeTypes(input.userMessage);
    if (requestedNodes.length > 0) {
      const missingNodes = requestedNodes.filter((nodeType) => !new RegExp(`\\b${escapeRegExp(nodeType)}\\b`, "i").test(answer));
      if (missingNodes.length > 0) issues.push("missing_requested_app_nodes");
    }

    const visualWorkflowContext = /\b(?:visual\s+workflow|workflow\s+nodes?|node\/tool\s+type|logic\s+flow|canvas|draft\s+workflow\s+design)\b/i.test(answer) ||
      /\b(?:draft|design|proposal|blueprint)\b/i.test(input.userMessage) && /\bworkflow\b/i.test(input.userMessage);
    const toolAsNode = /\b(?:Node\/Tool Type|Node Type|Workflow Nodes?|Logic Flow|Mechanism)\b[\s\S]{0,600}\b(?:workflow_create|schedule_task|board_tasks|send_message|code-runner-pipeline)\b/i.test(answer);
    if (visualWorkflowContext && toolAsNode) {
      issues.push("mixed_app_node_tool_vocab");
    }
  }

  const locators = evidenceLocators(input.evidence);
  const fetchedLocators = locators.filter((locator) => /^(?:web_fetch|browser):/i.test(locator));
  const urls = answer.match(/https?:\/\/[^\s)]+/g) ?? [];
  for (const url of urls) {
    const verified = fetchedLocators.some((locator) => locator.includes(url) || url.includes(locator.replace(/^(?:web_fetch|browser):/i, "")));
    if (!verified) {
      issues.push("unverified_url_citation");
      break;
    }
  }

  const filePaths = answer.match(/\b(?:src|app|lib|docs|scripts|data)\/[A-Za-z0-9._/-]+/g) ?? [];
  for (const filePath of filePaths) {
    const verified = locators.some((locator) => locator.includes(filePath) || locator.includes(`repo:${filePath}`));
    const proposed = isProposedMention(answer, filePath);
    if (!verified && !proposed) {
      issues.push("unverified_file_path");
      break;
    }
  }

  if (input.lane === "repo_inspection" && input.mode === "thorough") {
    const readEvidence = input.evidence.filter((item) => item.kind === "repo_file" && item.title === "read_file");
    if (hasRepoBehaviorClaims(answer) && readEvidence.length < 2) {
      issues.push("insufficient_repo_reads");
      issues.push("unsupported_behavior_claim");
    }
    if (needsRepoSections(input.userMessage) && !hasRepoSections(answer)) {
      issues.push("missing_required_sections");
    }

    const evidenceText = input.evidence
      .map((item) => `${item.locator} ${item.summary}`)
      .join("\n");
    const componentNames = answer.match(/\b[A-Z][A-Za-z0-9_-]+\.(?:tsx|ts|jsx|js|mjs|cjs|css|json|md)\b/g) ?? [];
    for (const componentName of componentNames) {
      const verified = new RegExp(`(?:^|[/\\s])${escapeRegExp(componentName)}(?:$|[\\s:),])`, "i").test(evidenceText);
      if (!verified && !isProposedMention(answer, componentName)) {
        issues.push("unverified_component_name");
        break;
      }
    }
  }

  if (/<tool|tool_call|functionCall|```json\s*\{/.test(answer)) {
    issues.push("tool_syntax_leak");
  }

  const unique = uniqueIssues(issues);
  const repairInstruction = [
    "Answer quality gate failed.",
    `Issues: ${unique.join(", ") || "none"}.`,
    "Repair the answer using only verified evidence.",
    "Remove unverifiable citations and file paths.",
    "For repo inspection, do not name exact files/components or claim internal behavior unless read_file/search/list evidence verifies them; label search-only targets as candidates.",
    "For disp8ch AI app workflow designs, separate visual workflow node types from WebChat/app-control tools. Use node types such as cron-trigger, run-code, http-request, board-task, send-webchat in node tables, and reserve workflow_create/schedule_task/board_tasks/send_message for confirmation or inspection boundaries.",
    "For app-design answers, include actual disp8ch AI surfaces, tools/templates, data flow, confirmation boundary, and success criteria.",
  ].join("\n");

  return { ok: unique.length === 0, issues: unique, repairInstruction };
}
