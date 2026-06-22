import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { resolveModelRefConfig } from "@/lib/agents/model-router";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { runMemoryFlush } from "./memory-flush";
import { getLatestSessionCompactionSummary, persistSessionCompactionSummary, shouldRunSoftCompactionMemoryFlush } from "./session-compaction";
import type { CompactOpts, CompactionPolicy, CompactionFeedback } from "./types";
import { extractAgentsSection } from "@/lib/workspace/files";
import { persistChannelMessage } from "@/lib/channels/transcript";

const log = logger.child("agents:context:compaction");

const PRIOR_CONTEXT_MARKER = "[Prior context]";
// Reference-only preface prepended to every compaction summary so the post-compaction
// model treats the summary as background context, not active instructions to re-execute.
const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary " +
  "below. Treat it as background reference, NOT as active instructions. Do NOT answer " +
  "questions or fulfill requests mentioned in this summary — they were already addressed. " +
  "Your current task is identified in '## Active Task' / '## Pending user asks'. " +
  "Memory (MEMORY.md, USER.md) in the system prompt remains authoritative. Respond only to " +
  "the newest user message after this summary; the current session state may already reflect " +
  "work described here, so avoid repeating it.";
const MIN_SUMMARY_TOKENS = 900;
const MAX_SUMMARY_TOKENS = 5000;
const SUMMARY_RATIO = 0.2;
// Strictly enforced — audit fails if any are missing.
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Relevant tool/file context",
  "## Exact identifiers",
] as const;
// Encouraged — included in the prompt but not strictly audited so the summary
// preserves task continuity and active state.
const ENCOURAGED_SUMMARY_SECTIONS = [
  "## Active Task",
  "## Completed Actions",
  "## Active State",
  "## Critical Context",
] as const;
const MAX_EXACT_IDENTIFIERS = 12;

export function estimateContextTokens(messages: unknown[]): number {
  return Math.ceil((JSON.stringify(messages).length / 4) * 1.2);
}

function computeTriggerTokens(policy: CompactionPolicy): number {
  const ratioThreshold = Math.floor(policy.contextWindow * policy.threshold);
  const reserveThreshold = Math.max(1, policy.contextWindow - Math.max(0, Math.floor(policy.reserveTokensFloor)));
  return Math.max(1, Math.min(policy.contextWindow, Math.min(ratioThreshold, reserveThreshold)));
}

function computeKeptTokenBudget(policy: CompactionPolicy): number {
  const configured = Math.max(2000, Math.floor(policy.keepRecentTokens));
  return Math.min(configured, Math.max(2000, Math.floor(policy.contextWindow * 0.6)));
}

function computeSummaryBudget(tokens: number): number {
  const budget = Math.floor(tokens * SUMMARY_RATIO);
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(MAX_SUMMARY_TOKENS, budget));
}

function computeCompactionFeedback(params: {
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
}): CompactionFeedback {
  return {
    messagesBefore: params.messagesBefore,
    messagesAfter: params.messagesAfter,
    tokensBefore: params.tokensBefore,
    tokensAfter: params.tokensAfter,
    savedTokens: params.tokensBefore - params.tokensAfter,
    compressionRatio: params.tokensBefore > 0
      ? `${Math.round((params.tokensAfter / params.tokensBefore) * 100)}%`
      : "N/A",
  };
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(200, Math.floor(maxChars * 0.65));
  const tail = Math.max(80, maxChars - head - 16);
  return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-tail)}`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function serializeForSummaryAnthropic(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      lines.push(`${msg.role.toUpperCase()}: ${truncateMiddle(msg.content, 3000)}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const textBlocks: string[] = [];
    for (const block of msg.content) {
      const current = block as {
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
        content?: unknown;
        tool_use_id?: string;
      };
      if (current.type === "text") {
        textBlocks.push(current.text ?? "");
      } else if (current.type === "tool_use") {
        textBlocks.push(`[tool_use ${current.name || "tool"} ${truncateMiddle(JSON.stringify(current.input ?? {}), 600)}]`);
      } else if (current.type === "tool_result") {
        textBlocks.push(`[tool_result ${current.tool_use_id || ""} ${truncateMiddle(stringifyContent(current.content), 1500)}]`);
      }
    }
    if (textBlocks.length > 0) {
      lines.push(`${msg.role.toUpperCase()}: ${textBlocks.join("\n")}`);
    }
  }
  return lines.join("\n\n").slice(0, 100000);
}

function serializeForSummaryOpenAI(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const current = msg as {
      role: string;
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      tool_call_id?: string;
    };
    if (current.role === "system") continue;
    if (current.role === "tool") {
      lines.push(`[TOOL RESULT ${current.tool_call_id || ""}] ${truncateMiddle(stringifyContent(current.content), 1500)}`);
      continue;
    }
    let line = `${current.role.toUpperCase()}: ${truncateMiddle(stringifyContent(current.content), 3000)}`;
    if (current.tool_calls?.length) {
      const toolLines = current.tool_calls.map((call) => {
        const args = truncateMiddle(String(call.function?.arguments || ""), 600);
        return `  ${call.function?.name || "tool"}(${args})`;
      });
      line += `\n[Tool calls]\n${toolLines.join("\n")}`;
    }
    lines.push(line);
  }
  return lines.join("\n\n").slice(0, 100000);
}

function extractPriorContextSnippets(serialized: string): string[] {
  const out: string[] = [];
  for (const chunk of serialized.split(PRIOR_CONTEXT_MARKER)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("USER:") && !trimmed.startsWith("ASSISTANT:")) continue;
    out.push(trimmed.slice(0, 1200));
    if (out.length >= 2) break;
  }
  return out;
}

function extractLatestUserAsk(serialized: string): string | null {
  const matches = [...serialized.matchAll(/USER:\s*([\s\S]*?)(?=\n(?:ASSISTANT|USER|\[|$))/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const text = matches[index]?.[1]?.trim();
    if (text) return truncateMiddle(text, 800);
  }
  return null;
}

function extractOpaqueIdentifiers(serialized: string): string[] {
  const patterns = [
    /https?:\/\/[^\s)\]>"']+/g,
    /\b[A-Z]{2,10}-\d{1,6}\b/g,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    /\b[a-z0-9.-]+:\d{2,5}\b/gi,
    /(?:[A-Za-z]:\\[^\s"']+|\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)/g,
    /\b[A-Za-z0-9_:-]*[A-Za-z][A-Za-z0-9_:-]*\d[A-Za-z0-9_:-]*\b/g,
  ];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of serialized.matchAll(pattern)) {
      const value = String(match[0] || "").trim();
      if (!value || value.length < 4) continue;
      if (/^\d+$/.test(value) && value.length < 6) continue;
      const key = /^[0-9a-f]+$/i.test(value) ? value.toUpperCase() : value;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(value);
      if (found.length >= MAX_EXACT_IDENTIFIERS) return found;
    }
  }
  return found;
}

function buildSummaryInput(params: {
  serialized: string;
  previousSummary?: string | null;
  latestAsk?: string | null;
  identifiers: string[];
  policy: CompactionPolicy;
}): string {
  const prior = extractPriorContextSnippets(params.serialized);
  // Iterative-update path: when a previous summary exists, ask the model to extend it
  // rather than rebuilding from scratch. This preserves earlier decisions across
  // multiple compactions in the same session.
  const isUpdate = Boolean(params.previousSummary && params.previousSummary.trim());
  const sections: string[] = [
    isUpdate
      ? "Update the existing compaction summary by integrating the new turns below. PRESERVE existing information that is still relevant; ADD new completed actions (continue numbering); move items from ## Open TODOs to ## Completed Actions when done; move answered questions out of ## Pending user asks; update ## Active State to reflect the current state; CRITICAL: update ## Active Task to the user's most recent unfulfilled request."
      : "Create a compact continuation handoff for future model turns.",
    "Use these markdown headings (required) in order:",
    ...REQUIRED_SUMMARY_SECTIONS,
    "",
    "Also include these encouraged headings when relevant:",
    ...ENCOURAGED_SUMMARY_SECTIONS,
    "",
    "Rules:",
    "- ## Active Task is the SINGLE most important field. Copy the user's most recent unfulfilled request verbatim (the exact words). If there is no outstanding task, write \"None.\"",
    "- ## Completed Actions: numbered, format each as: `N. ACTION target — outcome [tool: name]`. Example: `1. READ src/lib/foo.ts:45 — found bug [tool: read_file]`. Be specific with paths, commands, line numbers, results.",
    "- ## Active State: current cwd, branch, modified/created files, test status (X/Y passing), any running processes.",
    "- ## Critical Context: specific values, error messages, configuration that would be lost without explicit preservation.",
    "- Preserve decisions, active work, blockers, user constraints, and tool/file outcomes that still matter.",
    "- Keep concrete values, file paths, commands, error messages, and exact identifiers when continuity depends on them.",
    params.policy.identifierPolicy === "strict"
      ? "- In ## Exact identifiers, preserve literal values exactly as written."
      : params.policy.identifierPolicy === "custom" && params.policy.identifierInstructions
        ? `- In ## Exact identifiers, follow this policy: ${params.policy.identifierInstructions}`
        : "- In ## Exact identifiers, include only values that matter for continuity.",
    "- Keep the latest user ask visible in ## Pending user asks.",
    "- NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings in the summary. Replace any that appear with [REDACTED]. Note that the user had credentials present, but do not preserve their values.",
    "- Write the summary in the same language the user was using; do not translate.",
    "- Write only the summary body with those headings — no greeting, preamble, or prefix.",
  ];

  if (params.previousSummary) {
    sections.push("", "Previous compacted summary to merge forward:", params.previousSummary.trim());
  }
  if (prior.length > 0) {
    sections.push("", "Earlier compacted snippets already present in history:", ...prior.map((entry, index) => `Snippet ${index + 1}:\n${entry}`));
  }
  if (params.latestAsk) {
    sections.push("", "Latest user ask to preserve:", params.latestAsk);
  }
  sections.push(
    "",
    "Exact identifiers to preserve if relevant:",
    params.identifiers.length > 0 ? params.identifiers.join(", ") : "(none)",
    "",
    "Transcript to summarize:",
    params.serialized.slice(0, 100000),
  );
  return sections.join("\n\n");
}

function normalizedSummaryLines(summary: string): Set<string> {
  return new Set(
    summary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function countAskOverlap(summary: string, ask: string | null): number {
  if (!ask) return 1;
  const askTerms = ask
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
  if (askTerms.length === 0) return 1;
  const normalized = summary.toLowerCase();
  const overlap = askTerms.filter((term) => normalized.includes(term));
  return overlap.length;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (/^[0-9a-f]+$/i.test(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

function auditSummaryQuality(params: {
  summary: string;
  latestAsk: string | null;
  identifiers: string[];
  policy: CompactionPolicy;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = normalizedSummaryLines(params.summary);
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }
  if (params.policy.identifierPolicy === "strict") {
    const missingIdentifiers = params.identifiers.filter((identifier) => !summaryIncludesIdentifier(params.summary, identifier));
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  if (countAskOverlap(params.summary, params.latestAsk) <= 0) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}

function findOpenAIBoundaryForward(messages: OpenAI.ChatCompletionMessageParam[], index: number): number {
  let next = Math.max(1, index);
  while (next < messages.length) {
    const current = messages[next] as { role?: string };
    if (current.role !== "tool") break;
    next += 1;
  }
  return next;
}

function findAnthropicBoundaryForward(messages: Anthropic.MessageParam[], index: number): number {
  let next = Math.max(0, index);
  while (next < messages.length) {
    const current = messages[next];
    if (current.role !== "user" || !Array.isArray(current.content)) break;
    const hasOnlyToolResults = current.content.every((block) => {
      const typed = block as { type?: string };
      return typed.type === "tool_result";
    });
    if (!hasOnlyToolResults) break;
    next += 1;
  }
  return next;
}

function findSafeSplitIndexAnthropic(messages: Anthropic.MessageParam[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const hasToolUse = Array.isArray(message.content) && message.content.some((block) => (block as { type?: string }).type === "tool_use");
    if (!hasToolUse) {
      return findAnthropicBoundaryForward(messages, index + 1);
    }
  }
  return -1;
}

function findSafeSplitIndexOpenAI(messages: OpenAI.ChatCompletionMessageParam[]): number {
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index] as { role?: string; tool_calls?: unknown[] };
    if (message.role !== "assistant") continue;
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return findOpenAIBoundaryForward(messages, index + 1);
    }
  }
  return -1;
}

function findCompactionStartIndex<T>(messages: T[], targetKeptTokens: number): number {
  for (let index = Math.max(0, messages.length - 1); index >= 0; index -= 1) {
    const keptTokens = estimateContextTokens(messages.slice(index));
    if (keptTokens <= targetKeptTokens) {
      return index;
    }
  }
  return Math.max(0, messages.length - 2);
}

function sanitizeOpenAIToolPairs(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const survivingCallIds = new Set<string>();
  for (const message of messages) {
    const current = message as { role?: string; tool_calls?: Array<{ id?: string }> };
    if (current.role !== "assistant") continue;
    for (const call of current.tool_calls ?? []) {
      if (call?.id) survivingCallIds.add(call.id);
    }
  }

  const resultCallIds = new Set<string>();
  for (const message of messages) {
    const current = message as { role?: string; tool_call_id?: string };
    if (current.role === "tool" && current.tool_call_id) {
      resultCallIds.add(current.tool_call_id);
    }
  }

  const filtered = messages.filter((message) => {
    const current = message as { role?: string; tool_call_id?: string };
    if (current.role !== "tool") return true;
    return current.tool_call_id ? survivingCallIds.has(current.tool_call_id) : true;
  });

  const missing = [...survivingCallIds].filter((id) => !resultCallIds.has(id));
  if (missing.length === 0) return filtered;

  const patched: OpenAI.ChatCompletionMessageParam[] = [];
  for (const message of filtered) {
    patched.push(message);
    const current = message as { role?: string; tool_calls?: Array<{ id?: string }> };
    if (current.role !== "assistant") continue;
    for (const call of current.tool_calls ?? []) {
      if (!call?.id || !missing.includes(call.id)) continue;
      patched.push({
        role: "tool",
        tool_call_id: call.id,
        content: "[Result from earlier compacted conversation — see prior context summary above]",
      });
    }
  }
  return patched;
}

function sanitizeAnthropicToolPairs(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const survivingCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const current = block as { type?: string; id?: string };
      if (current.type === "tool_use" && current.id) survivingCallIds.add(current.id);
    }
  }

  const filtered = messages.filter((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return true;
    const results = message.content.filter((block) => (block as { type?: string }).type === "tool_result") as Array<{
      type?: string;
      tool_use_id?: string;
    }>;
    if (results.length === 0) return true;
    return results.some((result) => result.tool_use_id && survivingCallIds.has(result.tool_use_id));
  });

  const seenResults = new Set<string>();
  for (const message of filtered) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const current = block as { type?: string; tool_use_id?: string };
      if (current.type === "tool_result" && current.tool_use_id) {
        seenResults.add(current.tool_use_id);
      }
    }
  }

  const missing = [...survivingCallIds].filter((id) => !seenResults.has(id));
  if (missing.length === 0) return filtered;

  return [
    ...filtered,
    {
      role: "user",
      content: missing.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[Result from earlier compacted conversation — see prior context summary above]",
      })),
    },
  ];
}

function resolveCompactionModel(): { provider: string; modelId: string } | null {
  try {
    const db = getSqlite();
    if (!db) return null;

    const configRow = db.prepare("SELECT value FROM app_config WHERE key = 'summary_model_ref'").get() as { value: string } | undefined;
    if (configRow?.value) {
      const colonIdx = configRow.value.indexOf(":");
      if (colonIdx > 0) {
        const provider = configRow.value.slice(0, colonIdx);
        const modelId = configRow.value.slice(colonIdx + 1);
        if (provider && modelId) return { provider, modelId };
      }
    }

    const fastModel = db.prepare(
      "SELECT provider, model_id FROM models WHERE is_active = 1 AND fast_mode = 1 ORDER BY priority ASC LIMIT 1"
    ).get() as { provider: string; model_id: string } | undefined;

    if (fastModel) return { provider: fastModel.provider, modelId: fastModel.model_id };

    const anyModel = db.prepare(
      "SELECT provider, model_id FROM models WHERE is_active = 1 ORDER BY priority ASC LIMIT 1"
    ).get() as { provider: string; model_id: string } | undefined;

    if (anyModel) return { provider: anyModel.provider, modelId: anyModel.model_id };
    return null;
  } catch {
    return null;
  }
}

async function resolveSummaryModel(opts: CompactOpts, policy: CompactionPolicy): Promise<CompactOpts> {
  const override = resolveModelRefConfig(policy.summaryModelRef);
  if (!override) return opts;
  return {
    provider: override.provider,
    modelId: override.modelId,
    apiKey: override.apiKey,
    baseUrl: override.baseUrl,
    maxTokens: override.maxTokens ?? opts.maxTokens,
    fastMode: override.fastMode,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
  };
}

export async function summarizeDroppedContext(params: {
  serialized: string;
  opts: CompactOpts;
  policy: CompactionPolicy;
  previousSummary?: string | null;
  latestAsk: string | null;
  identifiers: string[];
  droppedCount: number;
  droppedTokens: number;
}): Promise<string> {
  async function tryOnce(provider: string, modelId: string, apiKey?: string, baseUrl?: string, fastMode?: boolean): Promise<string | null> {
    const { callModel } = await import("@/lib/agents/multi-provider");
    const summaryBudget = computeSummaryBudget(params.droppedTokens);
    const prompt = buildSummaryInput({
      serialized: params.serialized,
      previousSummary: params.previousSummary,
      latestAsk: params.latestAsk,
      identifiers: params.identifiers,
      policy: params.policy,
    });
    const attempts = params.policy.qualityGuardEnabled ? Math.max(1, params.policy.qualityGuardMaxRetries + 1) : 1;
    let feedback = "";
    let lastSummary = "";

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await callModel({
        provider: provider as Parameters<typeof callModel>[0]["provider"],
        modelId,
        apiKey: apiKey ?? "",
        baseUrl,
        fastMode,
        systemPrompt: [
          "You are a summarization agent creating a context checkpoint. Treat the conversation turns provided as source material for a compact record of prior work.",
          "Preserve goals, decisions, commitments, blockers, active TODOs, relevant tool outcomes, and exact identifiers needed to continue the work.",
          "Produce only the structured summary body; do not add a greeting, preamble, or prefix.",
          "Write the summary in the same language the user was using; do not translate or switch to English.",
          "NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings — replace any that appear with [REDACTED]. Note that the user had credentials present, but do not preserve their values.",
          feedback,
        ].filter(Boolean).join("\n\n"),
        userMessage: prompt,
        maxTokens: summaryBudget,
      });
      const summary = result.response.trim();
      lastSummary = summary;
      if (!summary) return null;
      const quality = auditSummaryQuality({
        summary,
        latestAsk: params.latestAsk,
        identifiers: params.identifiers,
        policy: params.policy,
      });
      if (quality.ok || attempt >= attempts - 1) {
        return summary;
      }
      feedback = `Quality check feedback: ${quality.reasons.join(", ")}. Fix all issues and regenerate the summary with the required headings.`;
    }

    return lastSummary || null;
  }

  try {
    const summaryModel = await resolveSummaryModel(params.opts, params.policy);
    const compactionModel = resolveCompactionModel();

    if (compactionModel) {
      try {
        const result = await tryOnce(
          compactionModel.provider,
          compactionModel.modelId,
          summaryModel.apiKey,
          summaryModel.baseUrl,
          summaryModel.fastMode,
        );
        if (result) return result;
        log.warn("Compaction model produced empty summary, falling back to main model", {
          compactionModel: `${compactionModel.provider}:${compactionModel.modelId}`,
          fallback: `${summaryModel.provider}:${summaryModel.modelId}`,
        });
      } catch (err) {
        log.warn("Compaction model failed, falling back to main model", {
          compactionModel: `${compactionModel.provider}:${compactionModel.modelId}`,
          error: String(err),
        });
      }
    }

    const result = await tryOnce(
      summaryModel.provider as string,
      summaryModel.modelId,
      summaryModel.apiKey,
      summaryModel.baseUrl,
      summaryModel.fastMode,
    );
    return result ?? `[${params.droppedCount} earlier messages were compacted.]`;
  } catch {
    return `[${params.droppedCount} earlier messages summarization failed — dropped to free context]`;
  }
}

async function maybeRunPreCompactionFlush(
  serializedRecentMessages: string,
  tokensBefore: number,
  policy: CompactionPolicy,
  opts: CompactOpts,
): Promise<void> {
  if (!policy.memoryFlushEnabled || !opts.sessionId) return;
  const triggerTokens = computeTriggerTokens(policy);
  if (!shouldRunSoftCompactionMemoryFlush({
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    tokensBefore,
    triggerTokens,
    softThresholdTokens: policy.memoryFlushSoftThresholdTokens,
  })) {
    return;
  }
  await runMemoryFlush(serializedRecentMessages, opts, tokensBefore, triggerTokens);
}

export async function compactAnthropicMessages(
  messages: Anthropic.MessageParam[],
  policy: CompactionPolicy,
  opts: CompactOpts,
): Promise<{ messages: Anthropic.MessageParam[]; compacted: boolean; compactionFeedback?: CompactionFeedback }> {
  if (policy.mode === "off") return { messages, compacted: false };

  const tokensBefore = estimateContextTokens(messages);
  const triggerTokens = computeTriggerTokens(policy);
  if (tokensBefore < triggerTokens) {
    return { messages, compacted: false };
  }

  await maybeRunPreCompactionFlush(serializeForSummaryAnthropic(messages.slice(-30)), tokensBefore, policy, opts);

  const splitIdx = findSafeSplitIndexAnthropic(messages);
  if (splitIdx <= 0) return { messages, compacted: false };

  let actualSplit = findCompactionStartIndex(messages, computeKeptTokenBudget(policy));
  actualSplit = Math.max(splitIdx, actualSplit);
  actualSplit = findAnthropicBoundaryForward(messages, actualSplit);
  if (actualSplit >= messages.length) {
    actualSplit = splitIdx;
  }

  const dropped = messages.slice(0, actualSplit);
  const kept = messages.slice(actualSplit);
  const serializedDropped = serializeForSummaryAnthropic(dropped);
  const previousSummary = getLatestSessionCompactionSummary(opts.sessionId, opts.agentId);
  const latestAsk = extractLatestUserAsk(serializedDropped);
  const identifiers = extractOpaqueIdentifiers(serializedDropped);

  const summary =
    policy.mode === "summarize"
      ? await summarizeDroppedContext({
          serialized: serializedDropped,
          opts,
          policy,
          previousSummary,
          latestAsk,
          identifiers,
          droppedCount: dropped.length,
          droppedTokens: estimateContextTokens(dropped),
        })
      : `[${dropped.length} earlier messages dropped to free context]`;

  const priorContextPair: Anthropic.MessageParam[] = [
    { role: "user", content: `[Prior context]\n${SUMMARY_PREFIX}\n\n${summary}` },
    { role: "assistant", content: [{ type: "text", text: "Understood — treating the summary as reference only." }] },
  ];

  // Post-compaction: reinject ## Session Startup from AGENTS.md so the agent
  // re-reads required files and knows today's date after context is cleared.
  const startupSection = extractAgentsSection("Session Startup", { substituteDate: true });
  const postCompactionPair: Anthropic.MessageParam[] = startupSection
    ? [
        { role: "user", content: `[Post-compaction: run your Session Startup sequence]\n${startupSection}` },
        { role: "assistant", content: [{ type: "text", text: "Resuming session startup." }] },
      ]
    : [];

  const compactedMessages = sanitizeAnthropicToolPairs([
    ...priorContextPair,
    ...postCompactionPair,
    ...kept,
  ]);

  const tokensAfter = estimateContextTokens(compactedMessages);
  const feedback = computeCompactionFeedback({
    messagesBefore: messages.length,
    messagesAfter: compactedMessages.length,
    tokensBefore,
    tokensAfter,
  });

  if (opts.sessionId) {
    persistSessionCompactionSummary({
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      summary,
      tokensBefore,
      tokensAfter,
      droppedMessages: dropped.length,
      keptMessages: kept.length,
    });
  }

  if (opts.sessionId) {
    const compactionMsg = `Context compacted: ${feedback.messagesBefore} messages -> ~${feedback.tokensAfter} tokens (${feedback.compressionRatio} of original ${feedback.tokensBefore})`;
    persistChannelMessage({
      sessionId: opts.sessionId,
      role: "system",
      content: compactionMsg,
      metadata: { eventType: "compaction", ...feedback },
      agentId: opts.agentId,
    });
  }

  log.info("Context compacted (Anthropic)", {
    dropped: dropped.length,
    kept: kept.length,
    tokensBefore,
    tokensAfter,
    mode: policy.mode,
  });

  return {
    compacted: true,
    messages: compactedMessages,
    compactionFeedback: feedback,
  };
}

export async function compactOpenAIMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  policy: CompactionPolicy,
  opts: CompactOpts,
): Promise<{ messages: OpenAI.ChatCompletionMessageParam[]; compacted: boolean; compactionFeedback?: CompactionFeedback }> {
  if (policy.mode === "off") return { messages, compacted: false };

  const tokensBefore = estimateContextTokens(messages);
  const triggerTokens = computeTriggerTokens(policy);
  if (tokensBefore < triggerTokens) {
    return { messages, compacted: false };
  }

  await maybeRunPreCompactionFlush(serializeForSummaryOpenAI(messages.slice(-30)), tokensBefore, policy, opts);

  const splitIdx = findSafeSplitIndexOpenAI(messages);
  if (splitIdx <= 1) return { messages, compacted: false };

  let actualSplit = findCompactionStartIndex(messages, computeKeptTokenBudget(policy));
  actualSplit = Math.max(splitIdx, actualSplit);
  actualSplit = findOpenAIBoundaryForward(messages, actualSplit);
  if (actualSplit >= messages.length) {
    actualSplit = splitIdx;
  }

  const systemMsg = messages[0];
  const dropped = messages.slice(1, actualSplit);
  const kept = messages.slice(actualSplit);
  const serializedDropped = serializeForSummaryOpenAI(dropped);
  const previousSummary = getLatestSessionCompactionSummary(opts.sessionId, opts.agentId);
  const latestAsk = extractLatestUserAsk(serializedDropped);
  const identifiers = extractOpaqueIdentifiers(serializedDropped);

  const summary =
    policy.mode === "summarize"
      ? await summarizeDroppedContext({
          serialized: serializedDropped,
          opts,
          policy,
          previousSummary,
          latestAsk,
          identifiers,
          droppedCount: dropped.length,
          droppedTokens: estimateContextTokens(dropped),
        })
      : `[${dropped.length} earlier messages dropped to free context]`;

  const startupSectionOAI = extractAgentsSection("Session Startup", { substituteDate: true });
  const postCompactionPairOAI: OpenAI.ChatCompletionMessageParam[] = startupSectionOAI
    ? [
        { role: "user", content: `[Post-compaction: run your Session Startup sequence]\n${startupSectionOAI}` },
        { role: "assistant", content: "Resuming session startup." },
      ]
    : [];

  const compactedMessages = sanitizeOpenAIToolPairs([
    systemMsg,
    { role: "user", content: `[Prior context]\n${SUMMARY_PREFIX}\n\n${summary}` },
    { role: "assistant", content: "Understood — treating the summary as reference only." },
    ...postCompactionPairOAI,
    ...kept,
  ]);

  const tokensAfter = estimateContextTokens(compactedMessages);
  const feedback = computeCompactionFeedback({
    messagesBefore: messages.length,
    messagesAfter: compactedMessages.length,
    tokensBefore,
    tokensAfter,
  });

  if (opts.sessionId) {
    persistSessionCompactionSummary({
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      summary,
      tokensBefore,
      tokensAfter,
      droppedMessages: dropped.length,
      keptMessages: kept.length,
    });
  }

  if (opts.sessionId) {
    const compactionMsg = `Context compacted: ${feedback.messagesBefore} messages -> ~${feedback.tokensAfter} tokens (${feedback.compressionRatio} of original ${feedback.tokensBefore})`;
    persistChannelMessage({
      sessionId: opts.sessionId,
      role: "system",
      content: compactionMsg,
      metadata: { eventType: "compaction", ...feedback },
      agentId: opts.agentId,
    });
  }

  log.info("Context compacted (OpenAI)", {
    dropped: dropped.length,
    kept: kept.length,
    tokensBefore,
    tokensAfter: estimateContextTokens(compactedMessages),
    mode: policy.mode,
  });

  return {
    compacted: true,
    messages: compactedMessages,
  };
}

export async function compactSessionContext(sessionId: string): Promise<{
  success: boolean;
  messagesBefore?: number;
  compacted?: boolean;
  summaryLength?: number;
  error?: string;
}> {
  try {
    const db = getSqlite();
    const messages = db
      .prepare("SELECT content, role FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as Array<{ content: string; role: string }>;

    if (messages.length < 10) {
      return { success: true, messagesBefore: messages.length, compacted: false };
    }

    const { loadContextPolicy } = await import("@/lib/agents/context/policy");
    const policy = (await loadContextPolicy()).compaction;

    if (policy.mode === "off") {
      return { success: true, messagesBefore: messages.length, compacted: false };
    }

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const serialized = serializeForSummaryAnthropic(anthropicMessages);
    const previousSummary = getLatestSessionCompactionSummary(sessionId);
    const latestAsk = extractLatestUserAsk(serialized);
    const identifiers = extractOpaqueIdentifiers(serialized);

    const summary = await summarizeDroppedContext({
      serialized,
      opts: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        apiKey: "",
        maxTokens: 4096,
        sessionId,
      },
      policy,
      previousSummary,
      latestAsk,
      identifiers,
      droppedCount: messages.length,
      droppedTokens: estimateContextTokens(anthropicMessages),
    });

    persistSessionCompactionSummary({
      sessionId,
      summary,
      tokensBefore: estimateContextTokens(anthropicMessages),
      tokensAfter: Math.ceil((summary.length / 4) * 1.2),
      droppedMessages: messages.length,
      keptMessages: 0,
    });

    return {
      success: true,
      messagesBefore: messages.length,
      compacted: true,
      summaryLength: summary.length,
    };
  } catch (err) {
    log.error("compactSessionContext failed", { sessionId, error: String(err) });
    return { success: false, error: String(err) };
  }
}
