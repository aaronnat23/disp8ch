/**
 * Code task lane — conversational code review + change capability.
 *
 * Read-only by default: "review/explain/find the bug" uses read_file/search_files.
 * Mutation with confirmation: "fix/implement/change" produces a plan + diff preview
 * as a pending confirmation, applies via edit_file only after "confirm".
 */

const EXPLICIT_PATH = /\b(?:src|app|scripts|docs|lib|components)\/[^\s,;:)]+/i;
const EXPLICIT_DIFF_SCOPE = /\b(?:diff|patch|pull\s+request|PR|staged|commit|branch|changeset|changed\s+files)\b/i;
const EXPLICIT_SYMBOL_SCOPE = /\b(?:[Ff]unction\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\(\))?|[Cc]lass\s+[A-Z][A-Za-z0-9_$.-]*|[Cc]omponent\s+[A-Z][A-Za-z0-9_$.-]*|[Hh]ook\s+use[A-Z0-9_][A-Za-z0-9_$]*|[Mm]odule\s+[A-Za-z0-9_$.-]+|[Rr]oute\s+(?:\/|app\/|src\/)[^\s,;:)]+|[Hh]andler\s+[A-Za-z0-9_$.-]*(?:Handler|handler))\b/;
const BROAD_WORKSPACE_INSPECTION = /\b(?:repo|repository|workspace|codebase|app)\b[\s\S]{0,80}\b(?:places|where|how|why|implementation|latency|routing|tool\s+calls?|grounding|gaps?)\b/i;
const QUESTION_FRAMING = /\b(how|what|why|can|could|would|should|explain|tell\s+me|show\s+me|is\s+it|are\s+there)\b/i;
const CODE_CHANGE_PATTERNS = [
  /\b(fix|implement|refactor|edit|change|update|patch|modify|rewrite)\b.*\b(code|file|function|class|component|module|readme|typo|bug|src\/|app\/)\b/i,
];

export function isCodeReviewRequest(message: string): boolean {
  const text = String(message || "");
  if (!/\b(review|audit|explain|find\s+the\s+bug|what\s+does)\b/i.test(text)) return false;
  if (BROAD_WORKSPACE_INSPECTION.test(text) && !EXPLICIT_PATH.test(text) && !EXPLICIT_DIFF_SCOPE.test(text)) {
    return false;
  }
  return EXPLICIT_PATH.test(text) || EXPLICIT_DIFF_SCOPE.test(text) || EXPLICIT_SYMBOL_SCOPE.test(text);
}

export function isCodeChangeRequest(message: string): boolean {
  if (QUESTION_FRAMING.test(message) && /\?$/.test(message.trim())) return false;
  return CODE_CHANGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function buildCodeReviewSystemPrompt(): string {
  return `You are performing a code review. Follow this contract:

1. Identify issues with exact file:line references when possible.
2. For each finding, provide: severity (critical/high/medium/low), the problematic code snippet, a suggested fix.
3. Verify findings against real code — do not speculate.
4. Prefer small, safe fixes over large refactors.
5. Never apply changes automatically. This is advisory only.
6. If asked about performance, focus on measurable bottlenecks.
7. Structure the response as:
   - Summary (1-2 sentences)
   - Findings (numbered, with file:line, severity, explanation, fix)
   - Recommendations (actionable next steps)

Use the read_file and search_files tools to inspect the actual code before answering.`;
}

export function buildCodeChangeSystemPrompt(): string {
  return `You are proposing a code change. Follow this contract:

1. Read the relevant files first using read_file and search_files.
2. Produce a clear diff or describe the changes precisely (old → new).
3. Break large changes into atomic steps.
4. Include what to test after applying.
5. Do NOT apply changes — this is a proposal only.
6. For risky changes, suggest creating a checkpoint first.

The user will review and say "confirm" to apply.`;
}
