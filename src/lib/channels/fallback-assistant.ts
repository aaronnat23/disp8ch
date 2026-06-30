import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";
import { getModelConfig } from "@/lib/agents/model-router";
import { callModel, streamModel } from "@/lib/agents/multi-provider";
import {
  getOrCreateChannelSessionStartupSnapshot,
  type ChannelSessionStartupSnapshotRecord,
} from "@/lib/channels/session-startup-snapshots";
import type { RouteToWorkflowResult } from "@/lib/channels/router";
import { logger } from "@/lib/utils/logger";
import {
  loadRecentWebChatContext,
  buildContextualUserMessage,
  type WebChatContextMessage,
} from "@/lib/channels/webchat-context";
import { hasLeakedToolMarkup, hasLeakedToolMarkupDeep, buildMarkupFallbackResponse } from "@/lib/channels/tool-markup-guard";
import { isLikelyBroadResearchPrompt, isSessionOnlyDirectAnswerPrompt, needsRepoGrounding } from "@/lib/channels/broad-research-prompt";
import {
  buildModelLedContextPack,
  classifyContextLane,
  type ModelLedLane,
} from "@/lib/channels/model-led-context";
import { getAllowedToolsForLane } from "@/lib/channels/lane-tool-policy";
import { sanitizeFinalAnswer } from "@/lib/channels/final-answer-sanitizer";
import { createToolBudgetPolicy } from "@/lib/channels/tool-budget";
import { determineThoroughnessPolicy, buildThoroughnessInstruction } from "@/lib/channels/thoroughness-policy";
import { buildEvidencePlan, formatEvidencePlanInstruction } from "@/lib/channels/evidence-plan";
import { ToolTracer, type AccuracyMode } from "@/lib/agents/tool-trace";
import { createEvidenceFromToolResult, type EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { buildWebchatSystemPromptParts, type WebchatPromptParts } from "@/lib/channels/webchat-system-prompt";
import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";
import { formatRequestedOutputShapeInstruction } from "@/lib/channels/output-shape-contract";

const log = logger.child("channels:fallback-assistant");

export const NO_WORKFLOW_FALLBACK_TEXT = "No active workflow found to handle this message.";
const EMPTY_MODEL_REPLY_FALLBACK = "I'm here and ready to help with your workspace. What would you like to do?";

// Content-based completeness gate: detects preamble-only responses when
// tools were available but the model produced no substantive output.
// Keying off "zero tool calls despite tools available" is robust;
// keying off specific phrasings like "let me check" is not.
function isPreambleOnlyResponse(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).length;
  // Very short: almost certainly nothing useful
  if (words < 8) return true;
  // Short with no substantive content (no list, table, code block,
  // file path, number, or conclusion marker)
  if (words < 40) {
    const hasSubstance =
      /^[-*]\s|\b\d+(?:\.\d+)?%?\b/.test(t) ||       // bullet list or numbers
      /```|`[^`]+`/.test(t) ||                          // code block/inline
      /[A-Z]:[/\\]|[a-z]+\.[a-z]{2,4}(?:\s|$)/i.test(t) || // file paths/extensions
      /^#{1,3}\s|\*\*.*\*\*/.test(t) ||               // markdown heading/bold
      /^In |^The |^This |^Based on |^According to/.test(t) || // conclusion sentence
      /^\d+\.\s/.test(t);                              // numbered list
    if (!hasSubstance) return true;
  }
  return false;
}

function isEmptyFallbackReply(text: string, rawMessage: string): boolean {
  const answer = text.trim();
  if (!rawMessage.trim()) return false;
  return /^I['’]m here and ready to help with your workspace\. What would you like to do\?$/i.test(answer);
}

function resolveAnswerMaxTokens(input: {
  modelMaxTokens?: number | null;
  lane: ModelLedLane;
  mode: AccuracyMode;
  usedTools: boolean;
  compactDirect?: boolean;
}): number {
  if (input.compactDirect) {
    const compactCap = input.mode === "thorough"
      ? 3000
      : input.mode === "balanced"
        ? 2200
        : 1200;
    return Math.min(input.modelMaxTokens ?? compactCap, compactCap);
  }
  const cap = input.mode === "thorough"
    ? 8000
    : input.mode === "balanced"
      ? 4500
      : 1400;
  const laneCap = input.lane === "broad_research" || input.lane === "repo_inspection" || input.lane === "app_design"
    ? cap
    : Math.min(cap, input.usedTools ? 4500 : 3200);
  return Math.min(input.modelMaxTokens ?? laneCap, laneCap);
}

type FallbackAssistantInfo = {
  provider: string;
  modelId: string;
};

type SessionSnapshotInfo = {
  active: true;
  agentId: string;
  sourceFiles: string[];
};

type FallbackDiagnostics = {
  lane?: ModelLedLane;
  requiredToolUse?: boolean;
  firstToolPassError?: string;
  modelCallError?: string;
  mandatoryToolGateFailed?: boolean;
  actualToolsUsed?: number;
  toolRespChars?: number;
  recoveryTriggered?: boolean;
  recoveryError?: string;
  returnedEmptyFallback?: boolean;
  modelToolEvidenceCount?: number;
  promptMetrics?: {
    stableChars: number;
    contextChars: number;
    volatileChars: number;
    totalChars: number;
  };
};

export type ResolvedChannelResponse = {
  responseText: string | null;
  routeSource: string;
  fallbackAssistant?: FallbackAssistantInfo;
  sessionSnapshot?: SessionSnapshotInfo;
  fallbackDiagnostics?: FallbackDiagnostics;
  toolEvidenceLedger?: EvidenceLedgerEntry[];
};

function toSessionSnapshotInfo(
  snapshot: ChannelSessionStartupSnapshotRecord | null,
): SessionSnapshotInfo | undefined {
  if (!snapshot) return undefined;
  return {
    active: true,
    agentId: snapshot.agentId,
    sourceFiles: snapshot.sourceFiles,
  };
}

function shouldRunFallbackAssistant(routed: RouteToWorkflowResult): boolean {
  return routed.source === "none" && (!routed.response || routed.response.trim() === NO_WORKFLOW_FALLBACK_TEXT);
}

function extractExplicitWorkflowName(rawMessage: string): string | null {
  const runMatch = rawMessage.match(/^\s*run workflow:\s*(.+?)\s*::/i);
  if (runMatch?.[1]) return runMatch[1].trim();
  const useMatch = rawMessage.match(/^\s*use\s+(.+?)\s+to\b/i);
  if (useMatch?.[1]) return useMatch[1].trim();
  return null;
}

function buildRepoContext(): string {
  try {
    if (typeof window !== "undefined") return "";
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(process.cwd(), { withFileTypes: true }).slice(0, 30);
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
    return `This is a Next.js 14 app. Root files: ${files.slice(0, 8).join(", ")}. Directories: ${dirs.slice(0, 8).join(", ")}.`;
  } catch { return ""; }
}

async function collectLanePreflightEvidence(params: {
  lane: ModelLedLane;
  message: string;
  sessionId: string;
  agentId: string;
  onEmit?: (event: string, data: unknown) => void;
}): Promise<string> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const normalized = params.message.toLowerCase();

  if (params.lane === "repo_inspection") {
    calls.push({ name: "list_files", args: { path: "src/components/chat", recursive: "false" } });
    calls.push({ name: "search_files", args: { pattern: "virtual|scroll|stream|markdown|message", path: "src", maxResults: 20 } });
    if (/\b(chat|webchat|latency|virtual|stream|markdown)\b/.test(normalized)) {
      calls.push({ name: "read_file", args: { path: "src/components/chat/session-workbench.tsx" } });
      calls.push({ name: "read_file", args: { path: "src/components/chat/streaming-markdown.tsx" } });
      calls.push({ name: "read_file", args: { path: "src/app/(operator)/chat/client-page.tsx" } });
    }
  } else if (params.lane === "app_design" || params.lane === "app_mutation_proposal") {
    calls.push({ name: "workflow_templates", args: {} });
    calls.push({ name: "schedules_list", args: {} });
    if (/\bwebhook\b/i.test(params.message)) {
      calls.push({ name: "webhooks_list", args: {} });
    }
    if (/\bvisual\s+workflow|workflow\s+design|run-code|send-webchat|cron|http\b/i.test(params.message)) {
      calls.push({ name: "read_file", args: { path: "CORE_ARCHITECTURE_EXPLANATION.md" } });
    }
  } else {
    return "";
  }

  try {
    const { executeTool } = await import("@/lib/engine/tools");
    const results: string[] = [];
    for (const call of calls) {
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: call.name, args: call.args });
      params.onEmit?.("webchat:status", {
        sessionId: params.sessionId,
        phase: "tool_call",
        label: `Using ${call.name}...`,
        detail: Object.entries(call.args).slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(", ") || null,
        createdAt: new Date().toISOString(),
      });
      const output = await executeTool(call.name, call.args, {
        agentId: params.agentId,
        channelSessionId: params.sessionId,
        readOnly: true,
      });
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: call.name, resultPreview: output.slice(0, 200) });
      params.onEmit?.("webchat:status", {
        sessionId: params.sessionId,
        phase: "tool_done",
        label: `Completed ${call.name}`,
        detail: null,
        createdAt: new Date().toISOString(),
      });
      results.push(`[${call.name} ${JSON.stringify(call.args)}]\n${output.slice(0, 2400)}`);
    }
    return results.length > 0
      ? `Preflight evidence from actual read-only tool calls:\n\n${results.join("\n\n")}`
      : "";
  } catch (error) {
    log.warn("lane preflight evidence failed", { lane: params.lane, error: String(error) });
    return "";
  }
}

function getDeterministicGeneralFallback(rawMessage: string): string | null {
  const value = String(rawMessage || "").trim();
  if (!value) return null;
  if (/remember\s+this\b/i.test(value) && /\bfor\s+the\s+next\s+message\b/i.test(value) && /reply\s+only:\s*saved\b/i.test(value)) {
    return "saved";
  }
  if (/remember\s+this\b/i.test(value) && /\breply\s+only\s*[:"]?\s*["'`]?saved["'`]?\b/i.test(value)) {
    return "saved";
  }
  if (/\b(?:diet|meal|nutrition|calorie|macros?)\b/i.test(value) && /\b(?:health\s*check|risky|risk|unhealthy|review)\b/i.test(value)) {
    return [
      "I can help review the diet plan, but I need the actual plan first.",
      "",
      "Send the meals, portions, timing, goals, restrictions, and any medical constraints. I will look for obvious risk areas such as very low calories, missing protein or fiber, extreme restrictions, hydration gaps, supplement issues, and whether the plan fits the stated goal.",
      "",
      "This is general guidance, not medical advice. For medical conditions, medication interactions, pregnancy, eating disorder history, or major weight changes, use a qualified clinician or dietitian.",
    ].join("\n");
  }
  return null;
}

function requestedBulletCount(rawMessage: string): number | null {
  const explicit = String(rawMessage || "").match(/\b(?:use|give|include|with)?\s*(\d{1,2})\s*(?:concise\s+)?bullets?\b/i);
  if (!explicit) return null;
  const count = Number(explicit[1]);
  return Number.isFinite(count) ? Math.max(1, Math.min(10, count)) : null;
}

function formatBulletList(items: string[], count: number): string {
  return items.slice(0, count).map((item) => `- ${item}`).join("\n");
}

function cleanComparisonSubject(value: string): string {
  return value
    .replace(/\bin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:bullets?|sentences?|items?|points?)\b/gi, " ")
    .replace(/\bwith\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:bullets?|sentences?|items?|points?)\b/gi, " ")
    .replace(/\b(?:a|an|the|concise|short|brief|comparison|compare|of|between)\b/gi, " ")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractComparisonSubjects(rawMessage: string): [string, string] | null {
  const text = String(rawMessage || "").trim();
  const patterns = [
    /\bcompare\s+(.+?)\s+(?:and|vs\.?|versus|with)\s+(.+?)(?:\s+based\b|\s+using\b|\s+in\s+\d|\s+with\s+\d|[?.!]|$)/i,
    /\bcomparison\s+of\s+(.+?)\s+(?:and|vs\.?|versus|with)\s+(.+?)(?:\s+based\b|\s+using\b|\s+in\s+\d|\s+with\s+\d|[?.!]|$)/i,
    /\bdifference\s+between\s+(.+?)\s+and\s+(.+?)(?:\s+based\b|\s+using\b|\s+in\s+\d|\s+with\s+\d|[?.!]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const left = cleanComparisonSubject(match?.[1] || "");
    const right = cleanComparisonSubject(match?.[2] || "");
    if (left && right) return [left, right];
  }
  return null;
}

function subjectTokens(subject: string): string[] {
  return Array.from(new Set(
    subject
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !/^(?:agent|app|the|and|with|based|only|what|you|know|from|this|session)$/.test(token)),
  ));
}

function clipFact(line: string, max = 230): string {
  const cleaned = line
    .replace(/^[-*]\s*/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

function relevantContextFacts(contextText: string, subject: string, max = 3): string[] {
  const tokens = subjectTokens(subject);
  if (tokens.length === 0) return [];
  const scored: Array<{ line: string; score: number }> = [];
  let inSubjectSection = false;
  let subjectSectionRemaining = 0;
  for (const rawLine of contextText.split(/\r?\n/)) {
    const line = clipFact(rawLine);
    const lower = line.toLowerCase();
    const directScore = tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
    if (directScore > 0 && /\bcontext:$/i.test(line)) {
      inSubjectSection = true;
      subjectSectionRemaining = 5;
    }
    if (line.length <= 35) continue;
    if (directScore > 0) {
      scored.push({ line, score: directScore + (/\bcontext:$/i.test(line) ? 0.5 : 0) });
      continue;
    }
    if (inSubjectSection && subjectSectionRemaining > 0 && /^[-*]\s*/.test(rawLine.trim())) {
      scored.push({ line, score: 0.75 });
      subjectSectionRemaining -= 1;
      if (subjectSectionRemaining <= 0) inSubjectSection = false;
      continue;
    }
    if (!rawLine.trim() || !/^[-*]\s*/.test(rawLine.trim())) {
      inSubjectSection = false;
      subjectSectionRemaining = 0;
    }
  }
  const ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.line.length - a.line.length);
  return Array.from(new Set(ranked.map((item) => item.line))).slice(0, max);
}

function firstUsefulFact(facts: string[], subject: string): string {
  return (facts[0] || `the session context has limited direct detail about ${subject}`).replace(/[.!?]+$/g, "");
}

function factFragment(fact: string | undefined, fallbackSubject: string): string {
  return (fact || firstUsefulFact([], fallbackSubject)).replace(/[.!?]+$/g, "");
}

function buildSessionOnlyComparisonRecoveryAnswer(params: {
  rawMessage: string;
  recentContextMessages?: WebChatContextMessage[];
  stableContext?: string;
  modelError?: string;
}): string | null {
  const contract = determineTaskIntentContract(params.rawMessage);
  if (contract.operation !== "compare" || contract.toolPolicy !== "forbidden") return null;

  const bulletCount = requestedBulletCount(params.rawMessage) ?? 5;
  const contextText = [
    params.stableContext || "",
    ...(params.recentContextMessages ?? []).map((message) => message.content),
  ].join("\n");
  const wantsUncertainty = /\buncertaint(?:y|ies)\b|\bcaveat\b|\bunknown\b/i.test(params.rawMessage);
  const subjects = extractComparisonSubjects(params.rawMessage);
  if (subjects) {
    const [left, right] = subjects;
    const leftFacts = relevantContextFacts(contextText, left);
    const rightFacts = relevantContextFacts(contextText, right);
    const bullets = [
      `**Session coverage**: ${right} has the stronger direct context here: ${firstUsefulFact(rightFacts, right)}. ${left} is covered by: ${firstUsefulFact(leftFacts, left)}.`,
      `**Control model**: ${factFragment(rightFacts.find((fact) => /\bdeterministic|contract|gate|ledger|preflight|controller\b/i.test(fact)) || rightFacts[0], right)}. ${factFragment(leftFacts.find((fact) => /\bloop|agent|synthesis|tool\b/i.test(fact)) || leftFacts[0], left)}.`,
      `**Tool and evidence posture**: ${factFragment(rightFacts.find((fact) => /\btool|evidence|policy|budget|ground/i.test(fact)) || rightFacts[0], right)}. For ${left}, the session context is thinner, so claims should stay closer to the available comparison framing.`,
      `**Product surface**: ${factFragment(rightFacts.find((fact) => /\bWebChat|workflow|boards|hierarchy|council|memory|channels\b/i.test(fact)) || rightFacts[0], right)}. ${left} may have additional product details, but they were not verified in this no-tool turn.`,
      `**Uncertainty**: No tools or fresh public sources were allowed for this comparison, and the selected provider call failed before synthesis. This answer uses only stable session context; current docs, exact internals, and benchmark parity need separate verified inspection.`,
    ];
    return formatBulletList(
      wantsUncertainty || bulletCount >= bullets.length ? bullets : bullets.filter((item) => !/^\*\*Uncertainty\*\*/i.test(item)),
      bulletCount,
    );
  }

  const contextLines = contextText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line.length > 30 && !/<\/?\w+>/i.test(line))
    .slice(0, Math.max(2, bulletCount - 1));

  if (contextLines.length === 0) return null;

  const bullets = contextLines.map((line) => `**Session context**: ${line}`);
  if (wantsUncertainty || bullets.length < bulletCount) {
    bullets.push(
      `**Uncertainty**: The selected model could not be called (${params.modelError || "provider unavailable"}), so this is a recovery answer from available session context rather than a fresh model synthesis.`,
    );
  }
  return formatBulletList(bullets, bulletCount);
}

export function buildModelUnavailableRecoveryAnswer(params: {
  rawMessage: string;
  lane: ModelLedLane;
  preflightEvidence?: string;
  recentContextMessages?: WebChatContextMessage[];
  stableContext?: string;
  modelError?: string;
}): string {
  const comparison = buildSessionOnlyComparisonRecoveryAnswer(params);
  if (comparison) return comparison;
  return buildSubstantiveRecoveryAnswer({
    rawMessage: params.rawMessage,
    lane: params.lane,
    preflightEvidence: params.preflightEvidence,
  });
}

function buildSubstantiveRecoveryAnswer(params: {
  rawMessage: string;
  lane: ModelLedLane;
  preflightEvidence?: string;
}): string {
  const evidenceNote = params.preflightEvidence?.trim()
    ? "I have read-only preflight evidence for this turn and should ground the answer in it before adding any model inference."
    : "If no preflight evidence is available yet, the session should gather the smallest useful read-only evidence set before answering.";
  if (params.lane === "broad_research") {
    return [
      "For broad non-deterministic prompts, this WebChat session should choose depth from the evidence needed to answer safely.",
      "",
      "1. Fast mode is appropriate for simple writing, transformations, exact recall, and prompts where no outside facts or repo behavior are needed.",
      "2. Balanced mode is appropriate when the answer needs some grounding, such as checking a few files, reading app state, or fetching a small set of sources.",
      "3. Thorough mode is appropriate for current web research, repo-wide inspection, benchmark comparisons, workflow designs, and any prompt where a shallow answer would be misleading.",
      "",
      evidenceNote,
      "The important rule is that broad research should not stop at snippets or generic synthesis. It should search, fetch/open sources, reject weak leads, cite only verified sources, and clearly label limited evidence when source support is thin.",
    ].join("\n");
  }
  if (params.lane === "repo_inspection" || /fast|balanced|thorough|tool usage|accuracy mode|session/i.test(params.rawMessage)) {
    return [
      "This WebChat session should decide between fast, balanced, and thorough tool usage from the cost of being wrong.",
      "",
      "1. Use fast mode when the user asks for direct composition, formatting, exact recall, or a low-risk explanation that does not depend on current repo/web evidence.",
      "2. Use balanced mode when the answer needs a small amount of grounding: list/search candidates, read the most relevant files, then synthesize without expanding into a full audit.",
      "3. Use thorough mode when the prompt is broad, non-deterministic, current, repo-wide, benchmark-related, or asks for fixes/architecture decisions. In that mode the session should plan evidence, use read-only tools first, compress evidence, and reserve time for final synthesis.",
      "",
      evidenceNote,
      "If a mandatory tool pass fails or the model returns an empty/generic answer, the session should recover with a substantive read-only answer from the evidence plan and diagnostics instead of returning a generic retry message.",
    ].join("\n");
  }
  return [
    "I could not get a usable model response, but this prompt is non-empty and should not end with a generic fallback.",
    "",
    "The safe recovery behavior is to answer from available read-only context, state what evidence was or was not available, and identify the next evidence needed instead of pretending the task was completed.",
    evidenceNote,
  ].join("\n");
}

function makeToolEvidenceCapture() {
  const pendingArgs = new Map<string, Record<string, unknown>[]>();
  const ledger: EvidenceLedgerEntry[] = [];
  return {
    ledger,
    recordCall(name: string, args: Record<string, unknown>) {
      const key = String(name || "");
      const queue = pendingArgs.get(key) ?? [];
      queue.push(args && typeof args === "object" ? args : {});
      pendingArgs.set(key, queue);
    },
    recordResult(name: string, success: boolean, output: string) {
      const key = String(name || "");
      const queue = pendingArgs.get(key) ?? [];
      const args = queue.shift() ?? {};
      if (queue.length > 0) pendingArgs.set(key, queue);
      else pendingArgs.delete(key);
      const rendered = success ? String(output || "") : `[Tool failed: ${key}] ${String(output || "")}`;
      ledger.push(...createEvidenceFromToolResult({ tool: key, args, output: rendered, metadata: { modelLed: true } }));
    },
  };
}

const GROUNDING_CONTRACT = `
Answer the user's actual request literally.
Do not convert informational requests into app mutations.
If the user says "do not edit", "do not implement", "do not execute", or "ask before", stay read-only.
If the user asks for a plan, produce a plan; do not ask for an entity unless the plan cannot be written without it.
Only propose app changes when the user explicitly asks to create/update/delete/save/run/schedule something in disp8ch AI.
For unknown tools, say they are unavailable and list available tool categories.
Be concise and direct. Answer the question asked, not a different question.
`.trim();

const READ_ONLY_TOOLS_INSTRUCTION = `
Tool policy for this turn: READ-ONLY.
  You may only use: list_files, read_file, search_files, code_review, web_search, web_extract, web_crawl, fetch_url, browser_action, browser_navigate, browser_snapshot, browser_scroll, browser_back, browser_get_text, browser_get_links, browser_get_images, browser_vision, browser_cdp, browser_dialog, browser_wait, browser_screenshot, browser_console, computer_observe, computer_list_apps, computer_zoom, computer_wait, memory_search, memory_get, documents_list, documents_search, document_get, pc_specs.
Use web_extract/web_crawl for structured source reading and browser tools only for read-only browsing when search/extract tools are insufficient.
You may NOT use: write_file, bash_exec, run_python, sessions_spawn, send_message, memory_store, schedule_task, or any mutation tool.
After receiving tool results, synthesize a normal user-facing answer. Do NOT output raw tool-call syntax.
`.trim();

function laneRequiresToolUse(lane: ModelLedLane, contractMessage?: string): boolean {
  if (contractMessage) {
    const contract = determineTaskIntentContract(contractMessage);
    return contract.toolPolicy === "required";
  }
  return lane === "repo_inspection" || lane === "app_design" || lane === "app_mutation_proposal" || lane === "broad_research";
}

function buildRequiredToolUseInstruction(lane: ModelLedLane): string {
  switch (lane) {
    case "repo_inspection":
      return "Mandatory tool-use gate: before answering repo/codebase questions, call repo tools. Search/list to identify candidates, then read files before claiming behavior, bottlenecks, risks, or implementation targets.";
    case "app_design":
    case "app_mutation_proposal":
      return "Mandatory tool-use gate: before proposing a disp8ch AI workflow/app design, inspect available app surfaces/templates/tools or relevant docs/files. Use app-state tools for app surfaces and repo tools only for implementation details.";
    case "broad_research":
      return "Mandatory tool-use gate: before answering broad/current research prompts, search and fetch/read sources. Search snippets alone are not enough for citations.";
    default:
      return "";
  }
}

export function resolveExplicitWorkflowNoMatchText(params: {
  rawMessage: string;
  routed: RouteToWorkflowResult;
}): string | null {
  const explicitWorkflowName = extractExplicitWorkflowName(params.rawMessage);
  if (
    explicitWorkflowName &&
    params.routed.source === "none" &&
    (!params.routed.response || params.routed.response.trim() === NO_WORKFLOW_FALLBACK_TEXT)
  ) {
    // Don't block tool invocations — let them reach the fallback assistant
    const lower = explicitWorkflowName.toLowerCase().replace(/^the\s+/, "").replace(/\s+tools?$/i, "").trim();
    const normalized = lower
      .replace(/[-_]+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/^(?:available\s+)?tools?$/.test(lower) || lower === "available") {
      return null;
    }
    if (/^(?:web_search|web_extract|web_crawl|fetch_url|browser_action|browser_navigate|browser_snapshot|browser_click|browser_type|browser_scroll|browser_back|browser_press|browser_get_text|browser_get_links|browser_get_images|browser_vision|browser_cdp|browser_dialog|browser_wait|browser_screenshot|browser_console|computer_observe|computer_list_apps|computer_launch_app|computer_focus_app|computer_click|computer_type|computer_set_value|computer_hotkey|computer_scroll|computer_drag|computer_zoom|computer_wait|computer_stop|read_file|write_file|list_files|bash_exec|run_python|http_request|memory_search|memory_store|session_recall|session_todo|clarify|moa|run_python_script|take_screenshot|documents_search|document_get|search_files|run_shell|board_task)$/.test(lower)) {
      return null;
    }
    if (
      /\btools?\b/.test(normalized) &&
      /\b(?:browser|browsing|navigation|web|search|fetch|extract|file|memory|terminal|shell|mcp|image)\b/.test(normalized)
    ) {
      return null;
    }
    return `No active workflow matched "${explicitWorkflowName}". Create or activate that workflow first, or ask normally if you want a regular assistant reply.`;
  }
  return null;
}

export async function resolveChannelResponseWithFallback(params: {
  routed: RouteToWorkflowResult;
  rawMessage: string;
  sessionId: string;
  agentId: string;
  /** Optional emit hook so the fallback path can stream tokens to the WebChat UI. */
  onEmit?: (event: string, data: unknown) => void;
  /** When true, injects recent WebChat conversation history into the model prompt. */
  includeRecentHistory?: boolean;
  /** When true, restricts the tool caller to read-only tools. */
  readOnly?: boolean;
  /** When true, bypasses intent-based tool selection and always attaches read-only tools. */
  forceTools?: boolean;
  /** Intent kind from webchat-intent classification for capability-based toolset selection. */
  intentKind?: string;
  /** Verified evidence collected by a route-owned controller before model synthesis. */
  preflightEvidence?: string;
  /** Optional structured metrics for the route-owned preflight pass. */
  preflightMetrics?: Record<string, unknown>;
}): Promise<ResolvedChannelResponse> {
  let responseText = params.routed.response;
  let routeSource: string = params.routed.source;
  const explicitWorkflowNoMatchText = resolveExplicitWorkflowNoMatchText({
    rawMessage: params.rawMessage,
    routed: params.routed,
  });
  if (explicitWorkflowNoMatchText) {
    return {
      responseText: explicitWorkflowNoMatchText,
      routeSource,
    };
  }

  if (shouldRunFallbackAssistant(params.routed)) {
    const deterministicFallback = getDeterministicGeneralFallback(params.rawMessage);
    if (deterministicFallback) {
      params.onEmit?.("stream:token", { token: deterministicFallback });
      return {
        responseText: deterministicFallback,
        routeSource: "fallback-assistant",
      };
    }
    try {
      const agent = getAgentById(params.agentId) ?? getDefaultAgent();
      const broadResearch = isLikelyBroadResearchPrompt(params.rawMessage);
      const repoGrounded = needsRepoGrounding(params.rawMessage);
      const model = getModelConfig({ agentId: agent.id, sessionId: params.sessionId });
      const lane = classifyContextLane({
        message: params.rawMessage,
        intentKind: params.intentKind,
        readOnly: params.readOnly !== false,
      });
      const compactDirect = lane === "direct" && isSessionOnlyDirectAnswerPrompt(params.rawMessage);
      const contract = determineTaskIntentContract(params.rawMessage);
      const useCompactMode = compactDirect || contract.toolPolicy === "forbidden";
      const snapshot = useCompactMode
        ? null
        : getOrCreateChannelSessionStartupSnapshot({
          sessionId: params.sessionId,
          agentId: agent.id,
          workspacePath: agent.workspacePath,
          maxChars: 12000,
        });
      const sessionSnapshot = toSessionSnapshotInfo(snapshot);
      const thoroughness = determineThoroughnessPolicy({
        message: params.rawMessage,
        lane,
        provider: model.provider,
        modelId: model.modelId,
      });
      const modelLedContext = buildModelLedContextPack({
        lane,
        message: params.rawMessage,
        sessionId: params.sessionId,
        agentId: agent.id,
        workspacePath: agent.workspacePath,
        startupSnapshot: snapshot?.startupContext || "",
        modelId: model.modelId,
        provider: model.provider,
        accuracyMode: thoroughness.accuracyMode,
      });
      const toolset = new Set(getAllowedToolsForLane({ lane, phase: "model", forceTools: params.forceTools }));
      // Always include memory tools for guidance and recall regardless of lane
      toolset.add("memory_search");
      toolset.add("memory_get");
      toolset.add("session_recall");
      // ── Respect contract: toolPolicy=forbidden means no model-callable tools ──
      if (contract.toolPolicy === "forbidden") {
        toolset.clear();
      }
      const toolBudget = createToolBudgetPolicy(lane);
      const evidencePlan = buildEvidencePlan({ message: params.rawMessage, mode: thoroughness.accuracyMode, lane });
      const thoroughnessInstruction = buildThoroughnessInstruction(thoroughness);
      const evidencePlanInstruction = formatEvidencePlanInstruction(evidencePlan);
      const outputShapeInstruction = formatRequestedOutputShapeInstruction(params.rawMessage);
      const requiresToolUse = laneRequiresToolUse(lane, params.rawMessage);

      const promptParts = buildWebchatSystemPromptParts({
        lane,
        message: params.rawMessage,
        sessionId: params.sessionId,
        agentId: agent.id,
        provider: model.provider,
        modelId: model.modelId,
        workspacePath: agent.workspacePath,
        startupSnapshot: snapshot?.startupContext || "",
        readOnly: params.readOnly !== false,
        forceTools: params.forceTools,
        availableTools: toolset,
      });

      const fallbackDiagnostics: FallbackDiagnostics = {
        lane,
        requiredToolUse: requiresToolUse,
        promptMetrics: promptParts.metrics,
      };
      const toolEvidence = makeToolEvidenceCapture();
      const tracer = new ToolTracer(params.sessionId, agent.id, model.provider, model.modelId);
      tracer.recordAccuracyMode(thoroughness.accuracyMode, thoroughness.reason, lane);
      if (evidencePlan.needs.length > 0) {
        tracer.recordEvidencePlan(
          evidencePlan.needs.map((n) => n.kind),
          evidencePlan.needs.filter((n) => n.priority === "required").length,
          evidencePlan.stopCriteria,
        );
      }

      const systemPrompt = [
        promptParts.stable,
        GROUNDING_CONTRACT,
        ...(params.readOnly ? [READ_ONLY_TOOLS_INSTRUCTION] : []),
        promptParts.context,
        promptParts.volatile,
        modelLedContext,
        thoroughnessInstruction,
        evidencePlanInstruction,
        outputShapeInstruction,
        requiresToolUse ? buildRequiredToolUseInstruction(lane) : "",
        agent.systemPrompt || model.agentSystemPrompt || "You are a helpful AI assistant for disp8ch.",
        "Answer directly and practically. If the user asks about disp8ch itself, answer from the available workspace context when relevant.",
      ]
        .filter(Boolean)
        .join("\n\n");

      const recentContextMessages = params.includeRecentHistory
        ? loadRecentWebChatContext({
            sessionId: params.sessionId,
            limitMessages: 12,
            maxChars: 8000,
            currentMessage: params.rawMessage,
          })
        : [];
      let userMessage = params.includeRecentHistory && recentContextMessages.length > 0
        ? buildContextualUserMessage({
            recent: recentContextMessages,
            currentMessage: params.rawMessage,
            instructions: [
              "This is a follow-up in an ongoing conversation. Use the recent conversation history for continuity.",
              "Do not repeat information the user already provided in this conversation.",
            ],
          })
        : params.rawMessage;

      const repoContext = buildRepoContext();
      if (repoContext && (repoGrounded || broadResearch || /plan|implement|build|create.*plan|draft|design/i.test(params.rawMessage))) {
        userMessage = `Repo context: ${repoContext}\n\n${userMessage}`;
      }
      const preflightEvidence = params.preflightEvidence ?? await collectLanePreflightEvidence({
        lane,
        message: params.rawMessage,
        sessionId: params.sessionId,
        agentId: agent.id,
        onEmit: params.onEmit,
      });
      if (preflightEvidence) {
        const metrics = params.preflightMetrics
          ? `\n\nPreflight metrics: ${JSON.stringify(params.preflightMetrics).slice(0, 1000)}`
          : "";
        userMessage = `${preflightEvidence}${metrics}\n\nUse this preflight evidence as verified grounding. You may call more tools if needed.\n\n${userMessage}`;
      }
      const hasVerifiedPreflight = Boolean(preflightEvidence?.trim());

      let usedTools = false;
      if (toolset.size > 0 && !hasVerifiedPreflight) {
        try {
          const { callWithTools } = await import("@/lib/agents/tool-caller");
          const toolsMod = await import("@/lib/engine/tools");
          const catalog = (toolsMod as { TOOL_CATALOG?: Record<string, unknown> }).TOOL_CATALOG || {};
          const toolNames = Object.keys(catalog).filter((name) => toolset.has(name));
          const toolResult = await callWithTools({
            provider: model.provider,
            modelId: model.modelId,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            maxTokens: resolveAnswerMaxTokens({
              modelMaxTokens: model.maxTokens,
              lane,
              mode: thoroughness.accuracyMode,
              usedTools: true,
              compactDirect,
            }),
            temperature: model.temperature,
            systemPrompt,
            userMessage,
            tools: toolNames.map(name => ({ name, description: catalog[name] ? String((catalog[name] as Record<string,unknown>).description || name) : name, parameters: catalog[name] ? ((catalog[name] as Record<string,unknown>).parameters as Record<string, unknown>) || { type: "object", properties: {}, required: [] } : { type: "object" as const, properties: {}, required: [] } })) as unknown as Parameters<typeof callWithTools>[0]["tools"],
            agentId: agent.id,
            channelSessionId: params.sessionId,
            readOnly: params.readOnly === true ? true : undefined,
            requireToolUse: requiresToolUse,
            modelLedLane: lane,
            toolBudget,
            maxToolCalls: thoroughness.initialToolBudget,
            accuracyMode: thoroughness.accuracyMode,
            maxExpandedToolBudget: thoroughness.maxExpandedToolBudget,
            synthReserveMs: thoroughness.synthReserveMs,
            turnDeadlineMs: (params as { turnDeadlineMs?: number }).turnDeadlineMs ?? thoroughness.turnDeadlineMs,
            perToolTimeoutMs: thoroughness.perToolTimeoutMs,
            tracer,
            onToken: (token) => params.onEmit?.("stream:token", { token }),
            onToolCall: (name, args) => {
              toolEvidence.recordCall(name, args);
              if (params.onEmit) {
                const detail = Object.entries(args || {}).slice(0, 2).map(([k,v]) => `${k}: ${String(v).slice(0, 60)}`).join(", ");
                params.onEmit("webchat:tool", {
                  sessionId: params.sessionId,
                  phase: "start",
                  name,
                  args,
                });
                params.onEmit("webchat:status", {
                  sessionId: params.sessionId,
                  phase: "tool_call",
                  label: `Using ${name}...`,
                  detail: detail || null,
                  createdAt: new Date().toISOString(),
                });
              }
            },
            onToolResult: (name, _success, output) => {
              toolEvidence.recordResult(name, _success, output);
              if (params.onEmit) {
                params.onEmit("webchat:tool", {
                  sessionId: params.sessionId,
                  phase: "done",
                  name,
                  resultPreview: output.slice(0, 200),
                });
                params.onEmit("webchat:status", {
                  sessionId: params.sessionId,
                  phase: "tool_done",
                  label: `Completed ${name}`,
                  detail: null,
                  createdAt: new Date().toISOString(),
                });
              }
            },
          });
          const toolResp = (toolResult as { response?: string }).response?.trim();
          const actualToolsUsed = Array.isArray((toolResult as { toolsUsed?: unknown }).toolsUsed)
            ? ((toolResult as { toolsUsed?: string[] }).toolsUsed ?? []).length
            : 0;
          fallbackDiagnostics.actualToolsUsed = actualToolsUsed;
          fallbackDiagnostics.toolRespChars = toolResp?.length ?? 0;
          if (toolResp && (!requiresToolUse || actualToolsUsed > 0)) {
            responseText = toolResp;
            routeSource = "fallback-assistant-tools";
            usedTools = true;
          } else if (requiresToolUse) {
            fallbackDiagnostics.mandatoryToolGateFailed = true;
            log.warn("mandatory-tool-gate: model returned without tool evidence", {
              sessionId: params.sessionId,
              lane,
              responseChars: toolResp?.length ?? 0,
            });
          }
        } catch (error) {
          fallbackDiagnostics.firstToolPassError = error instanceof Error ? error.message : String(error);
          fallbackDiagnostics.mandatoryToolGateFailed = requiresToolUse;
          log.warn("mandatory-tool-gate: first tool pass failed", {
            sessionId: params.sessionId,
            lane,
            error: fallbackDiagnostics.firstToolPassError,
          });
        }
      }

      if (!usedTools && requiresToolUse && toolset.size > 0 && !hasVerifiedPreflight) {
        fallbackDiagnostics.recoveryTriggered = true;
        try {
          const { callWithTools } = await import("@/lib/agents/tool-caller");
          const toolsMod = await import("@/lib/engine/tools");
          const catalog = (toolsMod as { TOOL_CATALOG?: Record<string, unknown> }).TOOL_CATALOG || {};
          const toolNames = Object.keys(catalog).filter((name) => toolset.has(name));
          const retryResult = await callWithTools({
            provider: model.provider,
            modelId: model.modelId,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            maxTokens: resolveAnswerMaxTokens({
              modelMaxTokens: model.maxTokens,
              lane,
              mode: thoroughness.accuracyMode,
              usedTools: true,
              compactDirect,
            }),
            temperature: model.temperature,
            systemPrompt: [
              systemPrompt,
              "Recovery pass: the previous mandatory tool pass did not produce usable evidence.",
              "Call the minimum read-only tools needed, then answer the user's exact prompt directly.",
              "Do not output a greeting, preamble, or generic ready-to-help message.",
            ].join("\n"),
            userMessage,
            tools: toolNames.map(name => ({ name, description: catalog[name] ? String((catalog[name] as Record<string,unknown>).description || name) : name, parameters: catalog[name] ? ((catalog[name] as Record<string,unknown>).parameters as Record<string, unknown>) || { type: "object", properties: {}, required: [] } : { type: "object" as const, properties: {}, required: [] } })) as unknown as Parameters<typeof callWithTools>[0]["tools"],
            agentId: agent.id,
            channelSessionId: params.sessionId,
            readOnly: params.readOnly === true ? true : undefined,
            requireToolUse: true,
            modelLedLane: lane,
            toolBudget,
            maxToolCalls: Math.min(16, Math.max(4, thoroughness.initialToolBudget)),
            accuracyMode: thoroughness.accuracyMode,
            maxExpandedToolBudget: Math.min(24, Math.max(8, thoroughness.maxExpandedToolBudget)),
            synthReserveMs: thoroughness.synthReserveMs,
            turnDeadlineMs: (params as { turnDeadlineMs?: number }).turnDeadlineMs ?? thoroughness.turnDeadlineMs,
            perToolTimeoutMs: thoroughness.perToolTimeoutMs,
            tracer,
            onToken: (token) => params.onEmit?.("stream:token", { token }),
            onToolCall: (name, args) => {
              toolEvidence.recordCall(name, args);
              params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name, args });
            },
            onToolResult: (name, _s, output) => {
              toolEvidence.recordResult(name, _s, output);
              params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name, resultPreview: output.slice(0, 200) });
            },
          });
          const retryResp = (retryResult as { response?: string }).response?.trim();
          const retryToolsUsed = Array.isArray((retryResult as { toolsUsed?: unknown }).toolsUsed)
            ? ((retryResult as { toolsUsed?: string[] }).toolsUsed ?? []).length
            : 0;
          fallbackDiagnostics.actualToolsUsed = retryToolsUsed;
          fallbackDiagnostics.toolRespChars = retryResp?.length ?? 0;
          if (retryResp && retryToolsUsed > 0 && !isEmptyFallbackReply(retryResp, params.rawMessage)) {
            responseText = retryResp;
            routeSource = "fallback-assistant-tools";
            usedTools = true;
          }
        } catch (error) {
          fallbackDiagnostics.recoveryError = error instanceof Error ? error.message : String(error);
          log.warn("mandatory-tool-gate: recovery tool pass failed", {
            sessionId: params.sessionId,
            lane,
            error: fallbackDiagnostics.recoveryError,
          });
        }
      }

      if (!usedTools) {
        // Stream tokens to the WebChat UI so the user sees the response as it
        // arrives. Falls back to non-streaming callModel only if no emit hook
        // is wired (e.g. non-WebChat callers).
        const emit = params.onEmit;
        if (emit) {
          emit("stream:status", {
            phase: "model_call",
            label: `Calling ${model.provider}:${model.modelId}…`,
          });
        }
        let fallbackResult: Awaited<ReturnType<typeof callModel>> | null = null;
        try {
          fallbackResult = emit
            ? await streamModel(
                {
                  provider: model.provider,
                  modelId: model.modelId,
                  apiKey: model.apiKey,
                  baseUrl: model.baseUrl,
                  systemPrompt,
                  userMessage,
                  maxTokens: resolveAnswerMaxTokens({
                    modelMaxTokens: model.maxTokens,
                    lane,
                    mode: thoroughness.accuracyMode,
                    usedTools: false,
                    compactDirect,
                  }),
                  temperature: model.temperature,
                  fastMode: model.fastMode,
                },
                (token) => emit("stream:token", { token }),
              )
            : await callModel({
                provider: model.provider,
                modelId: model.modelId,
                apiKey: model.apiKey,
                baseUrl: model.baseUrl,
                systemPrompt,
                userMessage,
                maxTokens: resolveAnswerMaxTokens({
                  modelMaxTokens: model.maxTokens,
                  lane,
                  mode: thoroughness.accuracyMode,
                  usedTools: false,
                  compactDirect,
                }),
                temperature: model.temperature,
                fastMode: model.fastMode,
              });
          responseText = fallbackResult.response?.trim() || EMPTY_MODEL_REPLY_FALLBACK;
          routeSource = "fallback-assistant";
        } catch (error) {
          fallbackDiagnostics.modelCallError = error instanceof Error ? error.message : String(error);
          log.warn("Fallback assistant model call failed; using recovery answer", {
            sessionId: params.sessionId,
            provider: model.provider,
            modelId: model.modelId,
            error: fallbackDiagnostics.modelCallError,
          });
          responseText = buildModelUnavailableRecoveryAnswer({
            rawMessage: params.rawMessage,
            lane,
            preflightEvidence,
            recentContextMessages,
            stableContext: promptParts.full,
            modelError: fallbackDiagnostics.modelCallError,
          });
          routeSource = "fallback-assistant-model-unavailable-recovered";
          if (emit && responseText) {
            emit("stream:token", { token: responseText });
          }
        }
      fallbackDiagnostics.returnedEmptyFallback = isEmptyFallbackReply(responseText, params.rawMessage);

      // Content-based completeness gate: if tools were available but the model
      // produced only a preamble ("Let me check…") with no substantive output,
      // re-run once with the instruction to actually call the tools.
      if (responseText && toolset.size > 0 && (isPreambleOnlyResponse(responseText) || isEmptyFallbackReply(responseText, params.rawMessage))) {
        fallbackDiagnostics.recoveryTriggered = true;
        log.warn("completeness-gate: preamble-only response with tools available, retrying", { sessionId: params.sessionId, wordCount: responseText.split(/\s+/).length });
        try {
          const { callWithTools } = await import("@/lib/agents/tool-caller");
          const toolsMod = await import("@/lib/engine/tools");
          const catalog = (toolsMod as { TOOL_CATALOG?: Record<string, unknown> }).TOOL_CATALOG || {};
          const toolNames = Object.keys(catalog).filter((name) => toolset.has(name));
          const retryResult = await callWithTools({
            provider: model.provider,
            modelId: model.modelId,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            maxTokens: resolveAnswerMaxTokens({
              modelMaxTokens: model.maxTokens,
              lane,
              mode: thoroughness.accuracyMode,
              usedTools: true,
              compactDirect,
            }),
            temperature: model.temperature,
            systemPrompt: [
              systemPrompt,
              "You ignored the available tools on the previous pass and produced no substantive answer.",
              "You MUST call at least one tool to answer the user's request. Do not describe what you would do — actually do it.",
            ].join("\n"),
            userMessage,
            tools: toolNames.map(name => ({ name, description: catalog[name] ? String((catalog[name] as Record<string,unknown>).description || name) : name, parameters: catalog[name] ? ((catalog[name] as Record<string,unknown>).parameters as Record<string, unknown>) || { type: "object", properties: {}, required: [] } : { type: "object" as const, properties: {}, required: [] } })) as unknown as Parameters<typeof callWithTools>[0]["tools"],
            agentId: agent.id,
            channelSessionId: params.sessionId,
            readOnly: params.readOnly === true ? true : undefined,
            requireToolUse: true,
            modelLedLane: lane,
            toolBudget,
            maxToolCalls: thoroughness.initialToolBudget,
            accuracyMode: thoroughness.accuracyMode,
            maxExpandedToolBudget: thoroughness.maxExpandedToolBudget,
            synthReserveMs: thoroughness.synthReserveMs,
            turnDeadlineMs: (params as { turnDeadlineMs?: number }).turnDeadlineMs ?? thoroughness.turnDeadlineMs,
            perToolTimeoutMs: thoroughness.perToolTimeoutMs,
            tracer,
            onToken: (token) => params.onEmit?.("stream:token", { token }),
            onToolCall: (name, args) => {
              toolEvidence.recordCall(name, args);
              params.onEmit && params.onEmit("webchat:tool", { sessionId: params.sessionId, phase: "start", name, args });
            },
            onToolResult: (name, _s, output) => {
              toolEvidence.recordResult(name, _s, output);
              params.onEmit && params.onEmit("webchat:tool", { sessionId: params.sessionId, phase: "done", name, resultPreview: output.slice(0, 200) });
            },
          });
          const retryResp = (retryResult as { response?: string }).response?.trim();
          if (retryResp && !isEmptyFallbackReply(retryResp, params.rawMessage)) {
            responseText = retryResp;
            routeSource = "fallback-assistant-tools";
            usedTools = true;
            fallbackDiagnostics.returnedEmptyFallback = false;
          }
        } catch (error) {
          fallbackDiagnostics.recoveryError = error instanceof Error ? error.message : String(error);
          log.warn("Completeness gate retry failed — returning original response", { sessionId: params.sessionId });
        }
      }

      if (isEmptyFallbackReply(responseText, params.rawMessage)) {
        responseText = buildSubstantiveRecoveryAnswer({
          rawMessage: params.rawMessage,
          lane,
          preflightEvidence,
        });
        routeSource = "fallback-assistant-empty-recovered";
        fallbackDiagnostics.returnedEmptyFallback = true;
      }

      const sanitizedFallback = sanitizeFinalAnswer(responseText);
      if (sanitizedFallback.changed) responseText = sanitizedFallback.answer;
      if (responseText && (hasLeakedToolMarkup(responseText) || sanitizedFallback.leaked)) {
        log.warn("tool-markup-guard: detected leaked markup in fallback-assistant response", { sessionId: params.sessionId, preview: responseText.slice(0, 200), issues: sanitizedFallback.issues });
        responseText = sanitizedFallback.leaked ? sanitizedFallback.answer || buildMarkupFallbackResponse(params.rawMessage) : buildMarkupFallbackResponse(params.rawMessage);
        routeSource = "tool-markup-guard";
      }
      return {
        responseText,
        routeSource,
        fallbackAssistant: {
          provider: fallbackResult?.provider || model.provider,
          modelId: fallbackResult?.modelId || model.modelId,
        },
        fallbackDiagnostics: {
          ...fallbackDiagnostics,
          ...(toolEvidence.ledger.length > 0 ? { modelToolEvidenceCount: toolEvidence.ledger.length } : {}),
        },
        ...(toolEvidence.ledger.length > 0 ? { toolEvidenceLedger: toolEvidence.ledger } : {}),
        ...(sessionSnapshot ? { sessionSnapshot } : {}),
      };
      }
      const sanitizedToolResponse = sanitizeFinalAnswer(responseText ?? "");
      if (sanitizedToolResponse.changed) responseText = sanitizedToolResponse.answer;
      if (responseText && (hasLeakedToolMarkup(responseText) || sanitizedToolResponse.leaked)) {
        log.warn("tool-markup-guard: detected leaked markup in fallback-assistant tool response", { sessionId: params.sessionId, preview: responseText.slice(0, 200), issues: sanitizedToolResponse.issues });
        responseText = sanitizedToolResponse.leaked ? sanitizedToolResponse.answer || buildMarkupFallbackResponse(params.rawMessage) : buildMarkupFallbackResponse(params.rawMessage);
        routeSource = "tool-markup-guard";
      }
      return {
        responseText,
        routeSource,
        fallbackAssistant: { provider: model.provider, modelId: model.modelId },
        fallbackDiagnostics: {
          ...fallbackDiagnostics,
          ...(toolEvidence.ledger.length > 0 ? { modelToolEvidenceCount: toolEvidence.ledger.length } : {}),
        },
        ...(toolEvidence.ledger.length > 0 ? { toolEvidenceLedger: toolEvidence.ledger } : {}),
        ...(sessionSnapshot ? { sessionSnapshot } : {}),
      };
    } catch (error) {
      log.warn("Fallback assistant run failed", {
        sessionId: params.sessionId,
        error: String(error),
      });
    }
  }

  if (params.routed.source === "workflow") {
    const agent = getAgentById(params.agentId) ?? getDefaultAgent();
    const workflowSnapshot = getOrCreateChannelSessionStartupSnapshot({
      sessionId: params.sessionId,
      agentId: agent.id,
      workspacePath: agent.workspacePath,
      maxChars: 12000,
    });
    const workflowSessionSnapshot = toSessionSnapshotInfo(workflowSnapshot);
    if (workflowSessionSnapshot) {
      return {
        responseText,
        routeSource,
        sessionSnapshot: workflowSessionSnapshot,

      };
    }
  }

  return {
    responseText,
    routeSource,
  };
}
