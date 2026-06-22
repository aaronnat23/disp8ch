import type { RepoInspectionEvidence } from "@/lib/channels/repo-inspection-controller";

export type EvidenceContractIssue =
  | "missing_file_read"
  | "missing_search"
  | "insufficient_read_depth"
  | "unsupported_behavior_claim"
  | "missing_line_citation"
  | "missing_required_sections"
  | "missing_requested_step_count"
  | "no_visible_tool_trace";

export type EvidenceContractResult = {
  ok: boolean;
  issues: EvidenceContractIssue[];
  requiredExtraSearches: string[];
  requiredExtraReads: string[];
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function hasRepoBehaviorClaims(answer: string): boolean {
  return /\b(?:does|handles|renders|calls|loads|stores|writes|reads|routes|validates|parses|executes|imports|depends|bottleneck|latency|slow|regression|bug|because|implemented|responsible\s+for|verified|confirmed)\b/i.test(answer);
}

function needsSections(message: string): boolean {
  return /\b(?:implementation\s+plan|risks?|tests?|acceptance\s+criteria|files?\s+to\s+touch|data\s+flow|fix\s+plan|improve|steps?)\b/i.test(message);
}

function hasRequiredSections(answer: string, message: string): boolean {
  const hasFiles = /\b(?:Files?|Files?\s+to\s+touch|Implementation\s+targets?|Targets?|Touched\s+areas?|Code\s+paths?)\b/i.test(answer);
  const hasRisks = /\b(?:Risks?|Caveats?|Failure\s+modes?|Tradeoffs?|Watchouts?)\b/i.test(answer);
  const hasTests = /\b(?:Tests?|Testing|Verification|Validation|How\s+to\s+test|Test\s+plan|Testing\s+strategy|Regression\s+tests?)\b/i.test(answer);
  const hasAcceptance = /\bAcceptance\s+criteria\b/i.test(answer);
  const hasSteps = /\b(?:Steps?|Next\s+steps?|Plan)\b/i.test(answer) || /^\s*1\.\s+\S/m.test(answer);
  const needsFiles = /\bfiles?\b/i.test(message);
  const needsRisks = /\brisks?\b/i.test(message);
  const needsTests = /\b(?:tests?|regression\s+tests?|verification|validation)\b/i.test(message);
  const needsAcceptance = /\bacceptance\s+criteria\b/i.test(message);
  const needsSteps = /\bsteps?\b/i.test(message);
  return (!needsFiles || hasFiles) &&
    (!needsRisks || hasRisks) &&
    (!needsTests || hasTests) &&
    (!needsAcceptance || hasAcceptance) &&
    (!needsSteps || hasSteps) ||
    /\bObserved\b[\s\S]*\b(?:Risks?|Caveats?)\b[\s\S]*\b(?:Tests?|Verification)\b/i.test(answer);
}

function requestedStepCount(message: string): number | null {
  const explicit = message.match(/\b(?:next\s+)?(\d{1,2})\s+(?:safe\s+)?steps?\b/i);
  if (explicit) {
    const count = Number(explicit[1]);
    return Number.isFinite(count) && count > 0 && count <= 20 ? count : null;
  }
  return null;
}

function numberedStepCount(answer: string): number {
  return Array.from(answer.matchAll(/^\s*\d+\.\s+\S/gm)).length;
}

function likelyExtraReads(message: string): string[] {
  const reads: string[] = [];
  if (/\b(toast|toaster|notification|sonner|radix|provider|layout|theme|ui component|component pattern)\b/i.test(message)) {
    reads.push(
      "package.json",
      "src/app/layout.tsx",
      "src/components/layout/providers.tsx",
      "src/components/ui/button.tsx",
      "src/components/ui/dialog.tsx",
      "src/components/ui/dropdown-menu.tsx",
      "src/lib/utils.ts",
      "src/app/globals.css",
    );
  }
  if (/\b(chat|webchat|message|latency|stream|markdown|virtual|scroll|render|ui)\b/i.test(message)) {
    reads.push(
      "src/app/(operator)/chat/client-page.tsx",
      "src/components/chat/session-workbench.tsx",
      "src/components/chat/streaming-markdown.tsx",
      "src/components/chat/message-execution-cards.tsx",
    );
  }
  if (/\b(agent|tool|router|lane|fallback|model-led|gemini|inspection|quality|evidence)\b/i.test(message)) {
    reads.push(
      "src/app/api/channels/route.ts",
      "src/lib/channels/fallback-assistant.ts",
      "src/lib/agents/tool-caller.ts",
      "src/lib/channels/answer-quality-gate.ts",
    );
  }
  if (/\b(workflow|node|cron|schedule|run-code|http|webhook|board|send-webchat)\b/i.test(message)) {
    reads.push(
      "CORE_ARCHITECTURE_EXPLANATION.md",
      "src/lib/channels/app-action-planner.ts",
      "src/lib/engine/tools.ts",
    );
  }
  return unique(reads);
}

function likelyExtraSearches(message: string): string[] {
  const searches = ["repo_inspection|read_file|search_files|quality|evidence"];
  if (/\b(toast|toaster|notification|sonner|radix|provider|layout|theme|ui component|component pattern)\b/i.test(message)) {
    searches.push("toast|toaster|sonner|useToast|notification", "Providers|ThemeProvider|layout|Toaster|class-variance-authority|cn\\(");
  }
  if (/\b(chat|webchat|message|latency|stream|markdown|virtual|scroll|render|ui)\b/i.test(message)) {
    searches.push("virtual|scroll|stream|markdown|latency|render");
  }
  if (/\b(workflow|node|cron|schedule|run-code|http|webhook|board|send-webchat)\b/i.test(message)) {
    searches.push("cron-trigger|run-code|http-request|send-webchat|workflow_templates");
  }
  return unique(searches);
}

function extractMentionedFilePaths(answer: string): string[] {
  return Array.from(new Set(answer.match(/\b(?:src|app|lib|docs|scripts|data)\/[A-Za-z0-9._/() -]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json|md)\b|(?:^|[\s`])package\.json\b/g) ?? []))
    .map((path) => path.trim().replace(/^`|`$/g, ""));
}

function isProposedPathMention(answer: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:proposed|new|create|add|candidate|to\\s+create|to\\s+add|would\\s+add|files?\\s+to\\s+touch)[^\\n]{0,180}${escaped}`, "i").test(answer) ||
    new RegExp(`${escaped}[^\\n]{0,180}(?:proposed|new|candidate|to\\s+create|to\\s+add|if\\s+needed|if\\s+no\\s+local|or\\s+existing)`, "i").test(answer);
}

function pathContextHasBehaviorClaim(answer: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`[^.\\n;]{0,180}${escaped}[^.\\n;]{0,220}`, "i").exec(answer);
  const context = match?.[0] ?? "";
  if (!context) return false;
  if (/\b(?:proposed|new|create|add|candidate|to\s+create|to\s+add|would\s+add|if\s+needed|or\s+existing|files?\s+to\s+touch)\b/i.test(context)) {
    return false;
  }
  return /\b(?:does|handles|renders|calls|loads|stores|writes|reads|routes|validates|parses|executes|imports|depends|responsible\s+for|verified|confirmed|defines|implements|manages|enforces)\b/i.test(context);
}

function extractLineCitations(answer: string): Array<{ path: string; lineStart: number; lineEnd: number }> {
  const citations: Array<{ path: string; lineStart: number; lineEnd: number }> = [];
  const pattern = /\b((?:src|app|lib|docs|scripts|data)\/[A-Za-z0-9._/() -]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json|md)|package\.json):(?:L|line\s*)?(\d+)(?:[-–](?:L)?(\d+))?/gi;
  for (const match of answer.matchAll(pattern)) {
    const lineStart = Number(match[2]);
    const lineEnd = Number(match[3] || match[2]);
    if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) continue;
    citations.push({
      path: match[1].replace(/\\/g, "/"),
      lineStart: Math.min(lineStart, lineEnd),
      lineEnd: Math.max(lineStart, lineEnd),
    });
  }
  return citations;
}

function matchesPath(a: string, b: string): boolean {
  const left = a.replace(/\\/g, "/");
  const right = b.replace(/\\/g, "/");
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function hasVerifiedLineCitation(answer: string, evidence: RepoInspectionEvidence): boolean {
  const citations = extractLineCitations(answer);
  if (citations.length === 0) return false;
  const readItems = evidence.items.filter((item) => item.kind === "file_read" && item.path && item.lineStart);
  return citations.some((citation) =>
    readItems.some((item) => {
      if (!item.path || !item.lineStart) return false;
      const lineEnd = item.lineEnd ?? item.lineStart;
      return matchesPath(citation.path, item.path) &&
        citation.lineStart >= item.lineStart &&
        citation.lineEnd <= lineEnd;
    }),
  );
}

function answerNeedsLineCitation(answer: string, evidence: RepoInspectionEvidence): boolean {
  const readItemsWithLines = evidence.items.filter((item) => item.kind === "file_read" && item.path && item.lineStart);
  if (readItemsWithLines.length === 0) return false;
  return readItemsWithLines.some((item) => item.path && pathContextHasBehaviorClaim(answer, item.path));
}

export function evaluateRepoEvidenceContract(input: {
  answer: string;
  userMessage: string;
  evidence: RepoInspectionEvidence;
  visibleToolEvents?: boolean;
  mode?: "fast" | "balanced" | "thorough";
}): EvidenceContractResult {
  const issues: EvidenceContractIssue[] = [];
  const answer = input.answer.trim();
  const mode = input.mode ?? "thorough";
  const readCount = input.evidence.filesRead.length;
  const searchCount = input.evidence.metrics.searchCalls;
  const minReads = mode === "thorough" ? 4 : mode === "balanced" ? 2 : 1;

  if (searchCount < 1) issues.push("missing_search");
  if (readCount < 1) issues.push("missing_file_read");
  if (readCount < minReads) issues.push("insufficient_read_depth");
  if (input.visibleToolEvents === false) issues.push("no_visible_tool_trace");

  if (hasRepoBehaviorClaims(answer) && readCount < minReads) {
    issues.push("unsupported_behavior_claim");
  }

  const readPaths = new Set(input.evidence.filesRead.map((path) => path.replace(/\\/g, "/")));
  for (const mentionedPath of extractMentionedFilePaths(answer)) {
    const normalized = mentionedPath.replace(/\\/g, "/");
    if (isProposedPathMention(answer, normalized)) continue;
    if (!pathContextHasBehaviorClaim(answer, normalized)) continue;
    const read = readPaths.has(normalized) || Array.from(readPaths).some((path) => matchesPath(path, normalized));
    if (!read) {
      issues.push("unsupported_behavior_claim");
      break;
    }
  }

  if (mode === "thorough" && answerNeedsLineCitation(answer, input.evidence) && !hasVerifiedLineCitation(answer, input.evidence)) {
    issues.push("missing_line_citation");
  }

  if (needsSections(input.userMessage) && !hasRequiredSections(answer, input.userMessage)) {
    issues.push("missing_required_sections");
  }

  const requestedSteps = requestedStepCount(input.userMessage);
  if (requestedSteps !== null && numberedStepCount(answer) !== requestedSteps) {
    issues.push("missing_requested_step_count");
  }

  const requiredExtraReads = likelyExtraReads(input.userMessage)
    .filter((path) => !input.evidence.filesRead.includes(path))
    .slice(0, Math.max(0, minReads - readCount) + 2);

  const requiredExtraSearches = likelyExtraSearches(input.userMessage)
    .filter((search) => !input.evidence.searchesRun.includes(search))
    .slice(0, 2);

  const uniqueIssues = unique(issues);
  return {
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    requiredExtraReads,
    requiredExtraSearches,
  };
}

export function formatEvidenceContractRepairInstruction(result: EvidenceContractResult): string {
  if (result.ok) return "";
  return [
    "The previous repo-inspection answer was too shallow or under-grounded.",
    `Evidence contract issues: ${result.issues.join(", ")}.`,
    result.requiredExtraReads.length > 0 ? `Extra files requested: ${result.requiredExtraReads.join(", ")}.` : "",
    result.requiredExtraSearches.length > 0 ? `Extra searches requested: ${result.requiredExtraSearches.join(", ")}.` : "",
    "Rewrite the answer using only verified evidence. Search/list evidence identifies candidates; file_read evidence is required for behavior claims.",
    result.issues.includes("missing_requested_step_count") ? "Preserve the user's requested count exactly; if they asked for 5 steps, return exactly 5 numbered steps." : "",
    "For file behavior claims, include at least one verified line citation in the form `src/path/file.ts:12-48` when line ranges are present in the evidence.",
    "If evidence is still missing, label the point as an assumption or candidate instead of a verified fact.",
  ].filter(Boolean).join("\n");
}
