const INTERNAL_HEADER_PATTERNS = [
  /^\s*Current web evidence\b.*$/gim,
  /^\s*Verified evidence pack\b.*$/gim,
  /^\s*Evidence ledger from actual tool results\b.*$/gim,
  /^\s*Preflight metrics\b.*$/gim,
  /^\s*Workflow design evidence \(verified app state\):.*$/gim,
  /^\s*Repo inspection evidence\b.*$/gim,
  /^\s*Citation rules:.*$/gim,
];

const RAW_TOOL_LINE = /^\s*\[(?:web_search|web_extract|web_crawl|fetch_url|read_file|search_files|list_files|browser_[a-z_]+|browser_action|workflow_templates|schedules_list|webhooks_list|memory_search|memory_get|document_get|documents_search|Tool [^\]]+|[^\]]+\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|py|yml|yaml|toml|css|html|sql))\]\s?.*$/i;
const INTERNAL_REASONING_PREAMBLE = /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:the\s+user\s+(?:wants|is\s+asking|asked)|the\s+preflight\s+evidence\b|i\s+(?:need|should|have|will|can)\b|let\s+me\s+(?:review|check|inspect|look)|looking\s+at\s+my\s+context\b|wait,\s+i\s+need\b)/i;

function neutralizeRawToolMarkupLiterals(text: string): string {
  return text
    .replace(/<\/?\s*tool_calls?\s*>/gi, "tool-call wrapper")
    .replace(/<\/?\s*function_calls?\s*>/gi, "function-call wrapper")
    .replace(/<\/?\s*tool_call\s*>/gi, "tool-call wrapper")
    .replace(/<\/?\s*function_call\s*>/gi, "function-call wrapper")
    .replace(/"tool_calls"\s*:/gi, "tool-call metadata:")
    .replace(/"function_call"\s*:/gi, "function-call metadata:")
    .replace(/<\|\|DSML\|\|tool_calls>/gi, "tool-call wrapper");
}

export type FinalAnswerSanitizerResult = {
  answer: string;
  changed: boolean;
  leaked: boolean;
  issues: string[];
  repairInstruction: string;
};

export function hasInternalEvidenceLeak(answer: string): boolean {
  if (!answer.trim()) return false;
  if (RAW_TOOL_LINE.test(answer.split(/\r?\n/)[0] || "")) return true;
  // Note: a bracketed filename is only an internal-evidence leak when it is a bare
  // dumped locator — NOT a markdown link `[file.ts](url)` and NOT inline `code`, both of
  // which are legitimate file citations in a grounded repo audit. The `(?!\()` lookahead and
  // the surrounding-backtick guard prevent destroying valid file-citing answers.
  const namedLeak = /(?:Current web evidence|Verified evidence pack|Evidence ledger from actual tool results|Preflight metrics|Citation rules:|Workflow design evidence \(verified app state\))/i.test(answer);
  if (namedLeak) return true;
  const bareLocatorLine = answer.split(/\r?\n/).some((line) => {
    if (/\]\(https?:\/\//i.test(line)) return false;
    const locator = String.raw`\[[^\]]+\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|py|yml|yaml|toml|css|html|sql)\](?!\()`;
    return new RegExp(String.raw`^\s*(?<!\`)${locator}\s*$`, "i").test(line) ||
      new RegExp(String.raw`^\s*(?<!\`)${locator}\s+(?:summary|excerpt|locator|id=|kind=)\b`, "i").test(line);
  });
  return bareLocatorLine;
}

export function sanitizeFinalAnswer(answer: string): FinalAnswerSanitizerResult {
  let next = String(answer || "");
  const before = next;
  const issues: string[] = [];
  if (hasInternalEvidenceLeak(next)) issues.push("internal_evidence_leak");

  for (const pattern of INTERNAL_HEADER_PATTERNS) {
    next = next.replace(pattern, "");
  }
  const lines = next.split(/\r?\n/);
  const cleaned: string[] = [];
  let droppingToolBlock = false;
  let droppingReasoningPreamble = true;
  for (const line of lines) {
    if (RAW_TOOL_LINE.test(line)) {
      droppingToolBlock = true;
      continue;
    }
    if (droppingToolBlock && (/^\s{2,}\S/.test(line) || /^\s*(?:summary|excerpt|locator|id=|kind=)\b/i.test(line))) {
      continue;
    }
    droppingToolBlock = false;
    if (droppingReasoningPreamble) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (INTERNAL_REASONING_PREAMBLE.test(trimmed)) {
        issues.push("internal_reasoning_preamble");
        continue;
      }
      droppingReasoningPreamble = false;
    }
    cleaned.push(line);
  }
  next = cleaned.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const neutralized = neutralizeRawToolMarkupLiterals(next);
  if (neutralized !== next) {
    issues.push("raw_tool_markup_literal_neutralized");
    next = neutralized;
  }

  const leaked = hasInternalEvidenceLeak(next);
  if (leaked && !issues.includes("internal_evidence_leak")) issues.push("internal_evidence_leak");
  return {
    answer: next,
    changed: next !== before,
    leaked,
    issues,
    repairInstruction: [
      "The draft answer leaked internal evidence/tool output markup.",
      "Rewrite the final answer for the user only. Do not include raw tool labels, evidence-pack headers, preflight metrics, or internal repair metadata.",
      "Keep legitimate source links and file paths, but cite them in normal prose.",
    ].join("\n"),
  };
}
