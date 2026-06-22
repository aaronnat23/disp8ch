import { hasLeakedToolMarkup } from "@/lib/channels/tool-markup-guard";
import { isRawCliHelpOrToolDump } from "@/lib/channels/tool-output-sanitizer";

export type DeepAnswerIssue =
  | "raw_tool_output"
  | "tool_markup_leak"
  | "missing_exact_count"
  | "missing_required_sections"
  | "too_shallow"
  | "missing_prompt_topic";

export type DeepAnswerContractResult = {
  ok: boolean;
  issues: DeepAnswerIssue[];
  repairInstruction: string;
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractExactFindingCount(message: string): number | null {
  const numeric = message.match(/\b(?:exactly|give\s+me|list)\s+(\d{1,2})\s+(?:concrete\s+)?(?:findings|issues|gaps|risks|places|items)\b/i);
  if (numeric?.[1]) return Number(numeric[1]);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const word = message.match(/\b(?:exactly|give\s+me|list)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:concrete\s+)?(?:findings|issues|gaps|risks|places|items)\b/i)?.[1]?.toLowerCase();
  return word ? words[word] ?? null : null;
}

function countNumberedItems(answer: string): number {
  return answer.split(/\r?\n/).filter((line) => /^\s*(?:\d+\.|[-*]\s+\*\*?(?:Finding|Issue|Gap|Risk)\b)/i.test(line)).length;
}

function requiredSections(message: string): string[] {
  const sections: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\bfiles?\b/i, "files"],
    [/\brisks?\b/i, "risks"],
    [/\btests?\b/i, "tests"],
    [/\bacceptance\s+criteria\b/i, "acceptance criteria"],
    [/\btrigger\b/i, "trigger"],
    [/\bnodes?\b/i, "nodes"],
    [/\bdata\s+flow\b/i, "data flow"],
    [/\berror\s+handling\b/i, "error handling"],
  ];
  for (const [pattern, section] of checks) {
    if (pattern.test(message)) sections.push(section);
  }
  if (/\bimplementation\s+plan|upgrade\s+plan|fix\s+plan\b/i.test(message)) {
    sections.push("files", "risks", "tests", "acceptance criteria");
  }
  return unique(sections);
}

function sectionPattern(section: string): RegExp {
  const aliases: Record<string, string> = {
    files: "files?",
    risks: "risks?",
    tests: "tests?",
    "acceptance criteria": "acceptance\\s+criteria",
    nodes: "nodes?",
  };
  return new RegExp(`\\b${aliases[section] ?? section.replace(/\s+/g, "\\s+")}\\b`, "i");
}

function promptTopics(message: string): string[] {
  const topics: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\bmarkup\b/i, "markup"],
    [/\btool\s+calls?\b/i, "tool"],
    [/\bno-progress|timeout|latency\b/i, "latency"],
    [/\bmemory\b/i, "memory"],
    [/\bworkflow\b/i, "workflow"],
    [/\brouting|router|lane\b/i, "routing"],
    [/\bground(?:ed|ing)\b/i, "ground"],
  ];
  for (const [pattern, topic] of checks) {
    if (pattern.test(message)) topics.push(topic);
  }
  return topics;
}

export function evaluateDeepAnswerContract(input: {
  answer: string;
  userMessage: string;
  minWords?: number;
}): DeepAnswerContractResult {
  const answer = String(input.answer || "").trim();
  const message = String(input.userMessage || "");
  const issues: DeepAnswerIssue[] = [];

  if (hasLeakedToolMarkup(answer)) issues.push("tool_markup_leak");
  if (isRawCliHelpOrToolDump(answer)) issues.push("raw_tool_output");

  const exactCount = extractExactFindingCount(message);
  if (exactCount != null && countNumberedItems(answer) !== exactCount) {
    issues.push("missing_exact_count");
  }

  const missingSections = requiredSections(message).filter((section) => !sectionPattern(section).test(answer));
  if (missingSections.length > 0) issues.push("missing_required_sections");

  const minWords = input.minWords ?? 180;
  if (answer.split(/\s+/).filter(Boolean).length < minWords && /\b(?:deep|thorough|inspect|review|plan|compare|why|how|improve|implementation)\b/i.test(message)) {
    issues.push("too_shallow");
  }

  const missingTopics = promptTopics(message).filter((topic) => !new RegExp(`\\b${topic}`, "i").test(answer));
  if (missingTopics.length > 0 && /\b(?:inspect|review|analy[sz]e|compare|why|how|gap)\b/i.test(message)) {
    issues.push("missing_prompt_topic");
  }

  const uniqueIssues = unique(issues);
  return {
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    repairInstruction: [
      "Deep answer contract failed.",
      `Issues: ${uniqueIssues.join(", ") || "none"}.`,
      exactCount != null ? `Return exactly ${exactCount} numbered findings/items if the user requested that count.` : "",
      missingSections.length > 0 ? `Add these requested sections: ${missingSections.join(", ")}.` : "",
      "Do not expose raw CLI help, stack traces, JSON tool calls, or internal tool markup.",
      "Answer the actual prompt topics and use concrete app/repo evidence before final recommendations.",
    ].filter(Boolean).join("\n"),
  };
}
