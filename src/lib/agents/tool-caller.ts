/**
 * Multi-provider LLM tool-use loop.
 *
 * Handles the full "call tools → get results → continue" cycle for:
 *   Anthropic  — native tool_use blocks
 *   Google     — functionCall / functionResponse parts
 *   OpenAI + all OpenAI-compatible providers (Groq, Together, OpenRouter, Ollama,
 *               DeepSeek, Mistral, ZhipuAI/GLM, Moonshot/Kimi, xAI/Grok)
 *                — function calling via chat.completions
 *
 * Features:
 *   - Loop detection: warns if same tool called 3× with identical args
 *   - Unlimited mode: maxToolCalls=0 disables the cap (internally capped at 999)
 *   - Provider failover: on 429/rate-limit, automatically tries the next model
 *   - Output truncation: handled by executeTool() in tools.ts
 *   - Context compaction: summarize or drop old messages when nearing context limit
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import crypto from "node:crypto";
import { logger } from "@/lib/utils/logger";
import { callModel } from "@/lib/agents/multi-provider";
import type { ModelProvider } from "@/types/model";
import type { ApprovalPolicy } from "@/types/execution";
import type { ToolDefinition, ToolExecutionPolicy } from "@/lib/engine/tools";
import { disposeToolRuntimeSession, enforceAggregateToolResultBudget, executeToolWithConfirmation, SessionYieldSignal } from "@/lib/engine/tools";
import { resolveProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { resolveAnthropicFastServiceTier, resolveOpenAIFastServiceTier } from "@/lib/agents/fast-mode";
import { resolveOpenAIRequestTimeoutMs } from "@/lib/agents/provider-timeouts";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import { getProviderRequiredHeaders, providerUsesOAuth } from "@/lib/agents/provider-auth-registry";
import { resolveProviderOAuthCredential } from "@/lib/agents/provider-oauth";
import { buildAnthropicClient } from "@/lib/agents/anthropic-oauth";
import { normalizeProviderScopedModelId, resolveProviderApiMode } from "@/lib/agents/provider-routing";
import { checkModelToolSupport } from "@/lib/agents/model-capabilities";
import { resolveModelAlias } from "@/lib/agents/model-aliases";
import { getContextEngine } from "@/lib/agents/context/engine";
import { isBatchSafeForParallel, type BatchToolCall } from "@/lib/agents/tool-parallel-safety";
import type { CompactOpts } from "@/lib/agents/context/types";
import { prepareAnthropicPromptCaching } from "@/lib/agents/anthropic-prompt-caching";
import { resolveSmartRoute } from "@/lib/agents/smart-routing";
import {
  classifyExactRecallQuery,
  buildIdentifierQueryVariant,
  extractIdentifierValue,
  inferPreferredMemoryLane,
  isIdentifierOnlyReplyQuery,
  normalizeExactRecallText,
  queryNeedsIdentifierComparison,
  queryTargetsExactIdentifier,
  resolveExactIdentifierCandidate,
} from "@/lib/memory/exact-recall";
import { resolveMemoryAgentId } from "@/lib/memory/agent-scope";
import { loadRecentIdentifierQueryContext, resolveDirectExactRecall } from "@/lib/memory/direct-exact-recall";
import { getMemorySearchManager } from "@/lib/memory/manager";
import { buildSearchVisibility, type MemoryAccessMode } from "@/lib/memory/workflow-scope";
import { getSqlite } from "@/lib/db";
import type { ModelLedLane } from "@/lib/channels/model-led-context";
import {
  type ToolBudgetPolicy,
  ToolBudgetTracker,
  createToolBudgetPolicy,
  formatToolBudgetStop,
} from "@/lib/channels/tool-budget";
import {
  type EvidenceItem,
  createEvidenceItem,
  formatEvidenceLedger,
} from "@/lib/channels/evidence-ledger";
import { ToolTracer } from "@/lib/agents/tool-trace";
import { ToolFailureController } from "@/lib/agents/tool-failure-controller";
import { compressEvidence, buildFinalSynthesisPrompt } from "@/lib/channels/evidence-compressor";
import { evaluateAnswerQuality } from "@/lib/channels/answer-quality-gate";

const log = logger.child("agents:tool-caller");

const TOOL_TIMEOUT_MS = 25_000; // per-tool execution cap
const DEFAULT_TURN_DEADLINE_MS = 120_000; // max LLM + tool round-trip time

function buildDeadlineFallbackAnswer(opts: {
  accumulatedMessages: Array<{ role: string; content?: string | unknown }>;
  evidence?: EvidenceItem[];
  reason?: string;
}): string {
  const lines = [
    `${opts.reason || "The turn deadline was reached before final synthesis completed."} Here is the best supported answer from collected evidence.`,
    "",
  ];
  const evidence = opts.evidence?.filter((item) => item.summary.trim()).slice(-10) ?? [];
  if (evidence.length > 0) {
    lines.push("Observed evidence:");
    for (const item of evidence) {
      const locator = item.locator ? ` (${item.locator})` : "";
      lines.push(`- ${item.title}${locator}: ${item.summary.replace(/\s+/g, " ").slice(0, 500)}`);
    }
    lines.push("");
  }

  const toolMessages = opts.accumulatedMessages
    .filter((message) => message.role === "tool")
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content.trim();
      if (content && typeof content === "object") return JSON.stringify(content).trim();
      return "";
    })
    .filter(Boolean)
    .slice(-5);
  if (toolMessages.length > 0) {
    lines.push("Most recent tool results:");
    for (const [index, result] of toolMessages.entries()) {
      lines.push(`${index + 1}. ${result.replace(/\s+/g, " ").slice(0, 900)}`);
    }
    lines.push("");
  }

  if (evidence.length === 0 && toolMessages.length === 0) {
    lines.push("No usable tool result was available before the deadline. Retry with a narrower prompt or a longer local-model timeout.");
  } else {
    lines.push("What remains unverified: details not shown above are incomplete because the local model deadline stopped the final synthesis pass.");
  }
  return lines.join("\n").trim();
}

// When the turn deadline is reached, make one final model call without tools
// over the already-accumulated tool results to produce a real partial answer.
// If the local model is too slow to synthesize, fall back to an evidence-based
// deterministic summary rather than a bracketed status string.
async function synthesizeDeadlineAnswer(opts: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  maxTokens: number;
  temperature?: number;
  fastMode?: boolean;
  agentId?: string;
  channelSessionId?: string;
  accumulatedMessages: Array<{ role: string; content?: string | unknown }>;
  evidence?: EvidenceItem[];
  reason?: string;
}): Promise<string> {
  try {
    const history = opts.accumulatedMessages
      .map((m) => {
        const c = m.content;
        if (typeof c === "string") return `${m.role}: ${c.slice(0, 2000)}`;
        if (Array.isArray(c)) return `${m.role}: ${JSON.stringify(c).slice(0, 2000)}`;
        if (c && typeof c === "object") return `${m.role}: ${JSON.stringify(c).slice(0, 2000)}`;
        return null;
      })
      .filter(Boolean)
      .join("\n\n");
    const evidence = opts.evidence?.length ? `\n\n${formatEvidenceLedger(opts.evidence)}` : "";
    const reason = opts.reason || "Your time budget is reached.";
    const synthesisSystem = `${opts.systemPrompt}

${reason} Below is the conversation with all tool results collected so far.${evidence}
Write the best possible answer using only the tool results above. State plainly what you could not finish.
Be concise and direct — do not describe what you would have done, just answer from what you have.`;
    const result = await callModel({
      provider: opts.provider as ModelProvider,
      modelId: opts.modelId,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      systemPrompt: synthesisSystem,
      userMessage: `Collected results:\n\n${history}\n\nTask: synthesize a final answer from the above.`,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      fastMode: opts.fastMode,
    });
    if (result.response?.trim()) return result.response.trim();
  } catch (err) {
    log.warn("Deadline synthesis call failed, falling back to collected evidence", { error: String(err) });
  }
  return buildDeadlineFallbackAnswer({
    accumulatedMessages: opts.accumulatedMessages,
    evidence: opts.evidence,
    reason: opts.reason,
  });
}

async function synthesizeFinalAnswer(opts: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  originalMessage: string;
  draftAnswer: string;
  evidence: EvidenceItem[];
  maxTokens: number;
  temperature?: number;
  fastMode?: boolean;
  mode: "balanced" | "thorough";
  repairInstruction?: string;
}): Promise<string> {
  const compressedEvidence = compressEvidence(opts.evidence, opts.mode === "thorough" ? 16_000 : 9_000);
  const userMessage = [
    buildFinalSynthesisPrompt({
      originalMessage: opts.originalMessage,
      compressedEvidence,
      mode: opts.mode,
    }),
    opts.repairInstruction ? `\n${opts.repairInstruction}` : "",
    "",
    "Draft answer from the tool loop:",
    opts.draftAnswer,
    "",
    "Rewrite the final answer to be more precise, better grounded, and complete. Preserve correct details from the draft, but remove unsupported claims.",
  ].filter(Boolean).join("\n");

  try {
    const result = await callModel({
      provider: opts.provider as ModelProvider,
      modelId: opts.modelId,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      systemPrompt: opts.systemPrompt,
      userMessage,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      fastMode: opts.fastMode,
    });
    return result.response?.trim() || opts.draftAnswer;
  } catch (error) {
    log.warn("Final evidence synthesis failed, returning draft answer", { error: String(error) });
    return opts.draftAnswer;
  }
}

async function finalizeToolLoopAnswer(opts: ToolCallOptions, draftAnswer: string, evidence: EvidenceItem[]): Promise<string> {
  const answer = draftAnswer.trim() || "[No response]";
  const mode = opts.accuracyMode ?? "balanced";
  if (mode === "fast" || evidence.length === 0) return answer;

  const quality = evaluateAnswerQuality({
    answer,
    userMessage: opts.userMessage,
    lane: opts.modelLedLane ?? "read_only_workspace",
    mode,
    evidence,
  });

  if (mode !== "thorough" && quality.ok) return answer;
  if (mode === "balanced" && quality.ok) return answer;

  const synthesized = await synthesizeFinalAnswer({
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    systemPrompt: opts.systemPrompt,
    originalMessage: opts.userMessage,
    draftAnswer: answer,
    evidence,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    fastMode: opts.fastMode,
    mode: mode === "thorough" ? "thorough" : "balanced",
    repairInstruction: quality.ok ? undefined : quality.repairInstruction,
  });

  return synthesized.trim() || answer;
}

const READ_ONLY_TOOLS = new Set([
  "web_search", "web_extract", "web_crawl", "fetch_url",
  "read_file", "list_files", "search_files",
  "code_review",
  "memory_search", "memory_get",
  "memory_gpt",
  "documents_list", "documents_search", "document_get",
  "pc_specs", "take_screenshot",
  "get_clipboard",
  "channel_status",
  "workflow_templates", "workflow_list", "workflow_get", "workflow_execution_status",
  "schedules_list",
  "webhooks_list",
  "backup_list", "backup_status", "backup_verify",
  "checkpoint_list", "checkpoint_diff",
  "tool_docs_search",
  "browser_navigate", "browser_snapshot", "browser_get_text", "browser_get_links", "browser_get_images",
  "browser_vision", "browser_cdp", "browser_dialog", "browser_wait", "browser_screenshot", "browser_console",
]);

function isReadOnlyToolAction(name: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name === "board_tasks") return ["list", "get"].includes(String(args.action || ""));
  if (name === "governance_queue") {
    return [
      "list-task-approvals",
      "list-approval-comments",
      "list-wakeups",
      "agent-runtime",
    ].includes(String(args.action || ""));
  }
  return false;
}

function getOpenAIChatExtraParams(provider: string, modelId: string): Record<string, unknown> {
  if (provider === "deepseek" && /^deepseek-v4-/i.test(modelId)) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

function isRateLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("too many requests")
  );
}

// ── Background skill review ───────────────────────────────────────────────────
// Every SKILL_NUDGE_INTERVAL turns per session, fire a background LLM review
// of the full conversation. If the LLM decides a reusable skill was used, it
// writes a SKILL.md to data/workspace/skills/ using the same review pipeline
// as the visible self-learning proposal flow.

const SKILL_NUDGE_INTERVAL = 15;

interface SessionNudgeState {
  turnCount: number;
}

// Pin to globalThis so the map survives Next.js hot-module re-evaluation in dev mode.
// In production the module is loaded once and this is a no-op.
type NudgeGlobal = typeof globalThis & { __disp8chNudgeStates?: Map<string, SessionNudgeState> };
const _nudgeGlobal = globalThis as NudgeGlobal;
if (!_nudgeGlobal.__disp8chNudgeStates) _nudgeGlobal.__disp8chNudgeStates = new Map();
const sessionNudgeStates = _nudgeGlobal.__disp8chNudgeStates;

function getOrCreateNudgeState(sessionId: string): SessionNudgeState {
  let state = sessionNudgeStates.get(sessionId);
  if (!state) {
    state = { turnCount: 0 };
    sessionNudgeStates.set(sessionId, state);
  }
  return state;
}

function normalizeRecallText(value: unknown): string {
  return normalizeExactRecallText(value);
}

function queryAsksForExactIdentifier(query: string): boolean {
  return queryTargetsExactIdentifier(query);
}

function extractRecallIdentifier(value: unknown): string | null {
  return extractIdentifierValue(String(value || ""));
}

function buildRecallIdentifierVariant(query: string): string | null {
  return buildIdentifierQueryVariant(query);
}

function buildFallbackExactIdentifierQueries(query: string): string[] {
  const values = new Set<string>();
  const text = String(query || "");
  const stamp = text.match(/\b\d{8,}\b/g)?.[0];
  const mentionsOrangeCircuit = /\borange\s+circuit\b/i.test(text);
  const mentionsCollision = /\bcollision\s+test\b/i.test(text);
  const mentionsReleaseGate = /\brelease\s+gate\b/i.test(text);

  if (mentionsCollision && stamp && mentionsOrangeCircuit) values.add(`collision test ${stamp} orange circuit token`);
  if (mentionsCollision && stamp && mentionsReleaseGate) values.add(`collision test ${stamp} release gate token`);
  if (mentionsCollision && stamp) values.add(`collision test ${stamp} token`);
  if (mentionsCollision && mentionsOrangeCircuit) values.add("collision test orange circuit token");
  if (mentionsCollision && mentionsReleaseGate) values.add("collision test release gate token");
  if (mentionsOrangeCircuit) values.add("orange circuit token");
  if (mentionsReleaseGate) values.add("regression release gate token");

  return [...values];
}

type ExactIdentifierResolution = {
  identifier: string;
  snippet: string;
  sourcePath: string;
  response?: string;
};

async function resolveExactIdentifierFromMemory(opts: ToolCallOptions): Promise<ExactIdentifierResolution | null> {
  const memoryAccess = opts.memoryAccess ?? "agent";
  if (memoryAccess === "none") return null;
  const sessionId = String(opts.channelSessionId || "").trim();
  const agentId = String(opts.agentId || "default").trim() || "default";
  const query = String(opts.userMessage || "").trim();
  const queryClass = classifyExactRecallQuery(query);
  if (!sessionId || queryClass === "semantic_memory") return null;
  const memoryAgentId = resolveMemoryAgentId(agentId);
  const direct = memoryAccess === "agent" ? resolveDirectExactRecall({
    agentId: memoryAgentId,
    query,
    sessionId,
  }) : null;
  if (direct) {
    return {
      identifier: direct.identifier,
      snippet: direct.snippet,
      sourcePath: direct.sourcePath,
      response: direct.response,
    };
  }

  if (!queryAsksForExactIdentifier(query) || queryNeedsIdentifierComparison(query)) return null;
  const preferredLane = inferPreferredMemoryLane(query);
  const manager = getMemorySearchManager(memoryAgentId);
  const sessionContext = memoryAccess === "agent" ? loadRecentIdentifierQueryContext(sessionId) : "";
  const visibility = buildSearchVisibility(memoryAccess, opts.workflowId);
  const variantQuery = buildRecallIdentifierVariant(query);
  const fallbackQueries = buildFallbackExactIdentifierQueries(query);
  const searchOnce = async () => {
    const queries = [
      query,
      ...(variantQuery && variantQuery !== normalizeRecallText(query) ? [variantQuery] : []),
      ...fallbackQueries,
    ];
    const results = [];
    for (const candidateQuery of queries) {
      results.push(
        await manager.search({
          query: candidateQuery,
          limit: candidateQuery === query ? 60 : 30,
          minScore: 0,
          mode: "search",
          sessionKey: sessionId,
          lane: preferredLane,
          visibility,
        }),
      );
    }
    const deduped = results
      .flatMap((entry) => entry.data)
      .filter((entry) => extractRecallIdentifier(entry.content))
      .filter((entry, index, all) =>
        all.findIndex((candidate) => candidate.path === entry.path && candidate.content === entry.content) === index,
      );
    return resolveExactIdentifierCandidate(query, deduped, sessionContext);
  };

  let resolution = await searchOnce();
  if (!resolution && preferredLane === "ephemeral_test") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    resolution = await searchOnce();
  }
  if (!resolution) return null;

  return {
    identifier: resolution.identifier,
    snippet: String(resolution.winner.content || "").replace(/\s+/g, " ").trim(),
    sourcePath: resolution.winner.path || resolution.winner.id || "memory",
  };
}

async function injectActiveMemoryContext(opts: ToolCallOptions): Promise<ToolCallOptions> {
  const memoryAccess = opts.memoryAccess ?? "agent";
  if (memoryAccess === "none") return opts;
  const sessionId = String(opts.channelSessionId || "").trim();
  const agentId = String(opts.agentId || "default").trim() || "default";
  const query = String(opts.userMessage || "").trim();
  if (!sessionId || !query || query.length < 12) return opts;
  const exactIdentifierQuery = queryAsksForExactIdentifier(query);
  const memoryAgentId = resolveMemoryAgentId(agentId);

  try {
    const manager = getMemorySearchManager(memoryAgentId);
    const sessionContext = exactIdentifierQuery && memoryAccess === "agent" ? loadRecentIdentifierQueryContext(sessionId) : "";
    const preferredLane = inferPreferredMemoryLane(query);
    const visibility = buildSearchVisibility(memoryAccess, opts.workflowId);
    const primary = await manager.search({
      query,
      limit: exactIdentifierQuery ? 60 : 20,
      minScore: exactIdentifierQuery ? 0 : 0.08,
      mode: "search",
      sessionKey: sessionId,
      lane: preferredLane,
      visibility,
    });
    const variantQuery = exactIdentifierQuery ? buildRecallIdentifierVariant(query) : null;
    const variant =
      exactIdentifierQuery && variantQuery && variantQuery !== normalizeRecallText(query)
        ? await manager.search({
            query: variantQuery,
            limit: 40,
            minScore: 0,
            mode: "search",
            sessionKey: sessionId,
            lane: preferredLane,
            visibility,
          })
        : null;
    const merged = [...primary.data, ...(variant?.data ?? [])].filter(Boolean);
    if (!merged.length) return opts;
    const deduped = merged.filter((entry, index, all) =>
      all.findIndex((candidate) => candidate.path === entry.path && candidate.content === entry.content) === index,
    );
    const exactResolution = exactIdentifierQuery
      ? resolveExactIdentifierCandidate(query, deduped, sessionContext)
      : null;
    const ranked = exactResolution
      ? [exactResolution.winner, ...deduped.filter((entry) => entry !== exactResolution.winner)]
      : deduped;
    const exactIdentifier = exactResolution?.identifier ?? null;
    const snippetLimit = exactIdentifierQuery ? 1 : 3;
    const snippets = ranked
      .slice(0, snippetLimit)
      .map((entry, index) => {
        const label = entry.path || entry.id || `memory-${index + 1}`;
        const text = String(entry.content || "").replace(/\s+/g, " ").trim();
        return `- ${label}: ${text.slice(0, 220)}`;
      })
      .join("\n");
    if (!snippets.trim()) return opts;

    const recentRecallInstruction = (() => {
      if (!exactIdentifierQuery) return "";
      const lines = [
        "If the user is asking for the exact/current/newest token or identifier, answer with the single best matching value first.",
        "Do not list older candidates unless the user explicitly asks for comparison.",
        "When the relevant memory context below already contains the requested identifier, answer from it directly instead of calling tools again.",
      ];
      if (exactIdentifier) {
        lines.push(`Best current identifier from memory: ${exactIdentifier}`);
      }
      return `${lines.join("\n")}\n\n`;
    })();

    const memoryContext = snippets
      ? `\n\n<memory-context>\n${snippets}\n</memory-context>`
      : "";

    return {
      ...opts,
      systemPrompt: `${opts.systemPrompt}\n\n${recentRecallInstruction}${memoryContext ? `Memory context (wrapped in <memory-context> tags) contains relevant remembered information. Use it to inform your response but do not repeat it verbatim or treat it as conversation.\n\n${memoryContext}` : "Relevant memory context:\nNone."}`,
    };
  } catch (error) {
    log.warn("Active memory injection failed", {
      sessionId,
      agentId,
      error: String(error),
    });
    return opts;
  }
}

export interface ToolCallOptions {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  fastMode?: boolean;
  tools: ToolDefinition[];
  /** 0 = unlimited (internally capped at 999). Default: 25 */
  maxToolCalls?: number;
  /** Tool execution security + approval policy */
  toolPolicy?: ToolExecutionPolicy;
  /** Emitted for each tool invocation so the execution log shows progress */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Emitted after each tool execution completes (success or error) */
  onToolResult?: (name: string, success: boolean, output: string) => void;
  /**
   * Emitted for each text delta from the model as the streamed response arrives.
   * The tool-loop uses OpenAI streaming, so the final-round response text streams
   * here in real time. Earlier rounds that resolve to tool_calls do not emit text.
   */
  onToken?: (token: string) => void;
  /** Internal runtime session id for cross-tool state (browser refs/session). */
  toolRuntimeSessionId?: string;
  /** Agent ID for per-agent memory isolation. */
  agentId?: string;
  /** Authoritative workflow scope propagated by the executor. */
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  memoryAccess?: MemoryAccessMode;
  workflowApprovalPolicy?: ApprovalPolicy | null;
  workflowAttended?: boolean;
  /** Chat/session id used by sessions_yield. */
  channelSessionId?: string;
  /** Chat-selected tool mode, enforced again at execution time. */
  toolMode?: "default" | "restricted" | "full";
  /** Selected workspace root used to scope filesystem tools. */
  workspacePath?: string | null;
  /** Evidence selection mode for tool execution. */
  evidenceMode?: "current_state";
  /** Whether this is a user-facing turn eligible for smart fast-model routing. */
  enableSmartRouting?: boolean;
  /** When true, restricts tool execution to read-only tools only. */
  readOnly?: boolean;
  /** When true, ask capable providers to call at least one tool before finalizing. */
  requireToolUse?: boolean;
  /** Per-tool wall-clock timeout in milliseconds. Default: 25000. */
  perToolTimeoutMs?: number;
  /** Maximum wall-clock time for the entire tool-use loop (ms). Default: 120000. */
  turnDeadlineMs?: number;
  /** Model-led context lane used for tool budget and trace policy. */
  modelLedLane?: ModelLedLane;
  /** Lane-specific tool budget policy. */
  toolBudget?: ToolBudgetPolicy;
  /** Accuracy mode (fast/balanced/thorough) for tool budget expansion policy. */
  accuracyMode?: "fast" | "balanced" | "thorough";
  /** Maximum expanded tool budget when accuracy mode allows expansion. */
  maxExpandedToolBudget?: number;
  /** Wall-clock time to reserve for final synthesis before spending more time on tools. */
  synthReserveMs?: number;
  /** Tracer instance for telemetry. */
  tracer?: ToolTracer;
}

export interface ToolCallResult {
  response: string;
  toolsUsed: string[];
  tokensUsed: number;
  tokensIn: number;
  tokensOut: number;
  yielded?: boolean;
  provider?: string;
  modelId?: string;
  routeLabel?: string | null;
  tracer?: ToolTracer;
}

// ── Loop detection ────────────────────────────────────────────────────────────

/** Tracks repeated identical tool calls to detect runaway loops */
class LoopDetector {
  private counts = new Map<string, number>();
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  /** Returns a warning string if loop detected, undefined otherwise */
  check(name: string, args: Record<string, unknown>): string | undefined {
    const key = `${name}:${JSON.stringify(args)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count === this.threshold) {
      return `[Warning: "${name}" called ${count} times with identical arguments — possible loop detected. Consider stopping or using different parameters.]`;
    }
    return undefined;
  }
}

export class ToolFailureAdvisor {
  private counts = new Map<string, number>();

  record(name: string, args: Record<string, unknown>, error: unknown): string {
    const key = `${name}:${JSON.stringify(args)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return formatToolFailureForModel(name, args, error, count);
  }
}

export function formatToolFailureForModel(
  name: string,
  args: Record<string, unknown>,
  error: unknown,
  repeatCount = 1,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const argsPreview = JSON.stringify(args).slice(0, 1200);
  const repeatGuidance =
    repeatCount >= 2
      ? "This exact tool call has failed more than once. Do not call it again with the same arguments. Switch tools, change parameters, reduce scope, or explain the blocker."
      : "Do not blindly retry the exact same call. Try a different tool, different parameters, a smaller step, or explain the blocker if no alternate path is available.";
  return [
    `[Tool failed: ${name}]`,
    `Arguments: ${argsPreview}`,
    `Error: ${message}`,
    `Recovery policy: ${repeatGuidance}`,
  ].join("\n");
}

export async function executeToolForModel(
  name: string,
  args: Record<string, unknown>,
  opts: Pick<ToolCallOptions, "provider" | "modelId" | "apiKey" | "baseUrl" | "toolPolicy" | "toolRuntimeSessionId" | "agentId" | "channelSessionId" | "toolMode" | "workspacePath" | "evidenceMode" | "onToolResult" | "readOnly" | "workflowId" | "executionId" | "nodeId" | "memoryAccess" | "workflowApprovalPolicy" | "workflowAttended">,
  failureAdvisor: ToolFailureAdvisor = new ToolFailureAdvisor(),
): Promise<string> {
  if (opts.readOnly && !isReadOnlyToolAction(name, args)) {
    const msg = `Error executing tool "${name}": Tool "${name}" is not available in read-only mode. Ask the user for confirmation or switch modes.`;
    opts.onToolResult?.(name, false, msg);
    return msg;
  }
  try {
    const result = await executeToolWithConfirmation(
      name,
      args,
      opts.toolPolicy,
      {
        toolRuntimeSessionId: opts.toolRuntimeSessionId,
        agentId: opts.agentId,
        channelSessionId: opts.channelSessionId,
        toolMode: opts.toolMode,
        workspacePath: opts.workspacePath,
        evidenceMode: opts.evidenceMode,
        workflowId: opts.workflowId,
        executionId: opts.executionId,
        nodeId: opts.nodeId,
        memoryAccess: opts.memoryAccess,
        workflowApprovalPolicy: opts.workflowApprovalPolicy,
        workflowAttended: opts.workflowAttended,
        modelProvider: opts.provider,
        modelId: opts.modelId,
        modelApiKey: opts.apiKey,
        modelBaseUrl: opts.baseUrl,
      },
    );
    const isError = /^(?:Unknown tool|Tool failed|Error executing tool|Failed to execute tool)\b/i.test(result.trim());
    opts.onToolResult?.(name, !isError, isError ? result.trim() : result);
    if (isError) {
      return failureAdvisor.record(name, args, new Error(result.trim()));
    }
    return result;
  } catch (error) {
    if (error instanceof SessionYieldSignal) {
      // Session-yield must propagate — it is control flow, not a tool failure.
      throw error;
    }
    opts.onToolResult?.(name, false, error instanceof Error ? error.message : String(error));
    return failureAdvisor.record(name, args, error);
  }
}

async function executeToolWithTimeout(
  name: string,
  args: Record<string, unknown>,
  opts: Pick<ToolCallOptions, "provider" | "modelId" | "apiKey" | "baseUrl" | "toolPolicy" | "toolRuntimeSessionId" | "agentId" | "channelSessionId" | "toolMode" | "workspacePath" | "evidenceMode" | "onToolResult" | "readOnly" | "perToolTimeoutMs" | "workflowId" | "executionId" | "nodeId" | "memoryAccess" | "workflowApprovalPolicy" | "workflowAttended">,
  failureAdvisor: ToolFailureAdvisor,
): Promise<string> {
  const timeoutMs = opts.perToolTimeoutMs ?? TOOL_TIMEOUT_MS;
  try {
    return await Promise.race<string>([
      executeToolForModel(name, args, opts, failureAdvisor),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs / 1000}s`)), timeoutMs),
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("timed out")) {
      return failureAdvisor.record(name, args, error);
    }
    throw error;
  }
}

function resolveLimit(maxToolCalls: number | undefined): number {
  if (maxToolCalls === 0) return 999; // unlimited mode
  return maxToolCalls ?? 25;
}

function buildYieldResult(
  signal: SessionYieldSignal,
  state: { toolsUsed: string[]; tokensUsed: number; tokensIn: number; tokensOut: number },
): ToolCallResult {
  return {
    response: signal.responseMessage,
    toolsUsed: state.toolsUsed,
    tokensUsed: state.tokensUsed,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    yielded: true,
  };
}

function defaultSynthReserveMs(mode: ToolCallOptions["accuracyMode"]): number {
  return mode === "thorough" ? 30_000 : mode === "fast" ? 8_000 : 15_000;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropicWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const baseURL = resolveProviderBaseUrl(opts.provider, opts.baseUrl);
  const modelId = normalizeProviderScopedModelId(opts.provider, opts.modelId);
  const client = await buildAnthropicClient({ apiKey: opts.apiKey, baseURL });
  const toolsUsed: string[] = [];
  let tokensUsed = 0;
  let tokensIn   = 0;
  let tokensOut  = 0;
  const limit = resolveLimit(opts.maxToolCalls);
  const loopDetector = new LoopDetector();
  const failureAdvisor = new ToolFailureAdvisor();
  const failureController = new ToolFailureController();
  const deadline = Date.now() + (opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
  const synthReserveMs = opts.synthReserveMs ?? defaultSynthReserveMs(opts.accuracyMode);
  const toolBudget = new ToolBudgetTracker(
    opts.toolBudget ?? createToolBudgetPolicy(opts.modelLedLane ?? "read_only_workspace"),
    opts.maxExpandedToolBudget,
  );
  const evidence: EvidenceItem[] = [];
  const tracer = opts.tracer ?? new ToolTracer(opts.channelSessionId, opts.agentId, opts.provider, opts.modelId);

  const serviceTier = resolveAnthropicFastServiceTier({
    provider: opts.provider,
    baseUrl: baseURL,
    fastMode: opts.fastMode,
  });
  const anthropicTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool["input_schema"],
  }));

  type Msg = Anthropic.MessageParam;
  let messages: Msg[] = [{ role: "user", content: opts.userMessage }];
  const compactOpts: CompactOpts = {
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    maxTokens: opts.maxTokens,
    agentId: opts.agentId,
    sessionId: opts.channelSessionId,
  };
  const contextEngine = getContextEngine();

  for (let i = 0; i < limit; i++) {
    if (Date.now() > deadline) {
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: messages as Array<{ role: string; content?: string }>,
        evidence,
      });
      tracer.recordDeadlineFallback();
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }
    if (toolsUsed.length > 0 && Date.now() > deadline - synthReserveMs) {
      tracer.recordSynthesisStart(evidence.length, Math.max(0, deadline - Date.now()), "synthesis reserve reached");
      const synthStart = Date.now();
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: messages as Array<{ role: string; content?: string }>,
        evidence, reason: "Stopped tool use to preserve final synthesis time.",
      });
      tracer.recordSynthesisComplete(Date.now() - synthStart, synthesis.length, evidence.length > 0);
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }
    const prepared = await contextEngine.prepareAnthropic(messages, compactOpts);
    messages = prepared.messages;
    const cachedPrompt = prepareAnthropicPromptCaching({
      systemPrompt: opts.systemPrompt,
      messages,
    });
    const stream = await client.messages.create({
      model: modelId,
      max_tokens: opts.maxTokens,
      system: cachedPrompt.system,
      messages: cachedPrompt.messages,
      tools: anthropicTools,
      tool_choice: opts.requireToolUse && toolsUsed.length === 0 ? { type: "any" } : { type: "auto" },
      stream: true,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    });

    const contentBlocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
    const toolInputDeltas = new Map<number, string>();
    let text = "";
    let stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens ?? inputTokens;
        outputTokens = event.message.usage.output_tokens ?? outputTokens;
        stopReason = event.message.stop_reason ?? stopReason;
        continue;
      }
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          contentBlocks[event.index] = { type: "text", text: event.content_block.text ?? "" };
          if (event.content_block.text) {
            text += event.content_block.text;
            try { opts.onToken?.(event.content_block.text); } catch { /* swallow */ }
          }
        } else if (event.content_block.type === "tool_use") {
          contentBlocks[event.index] = {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input ?? {},
          };
        }
        continue;
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          const deltaText = event.delta.text;
          const block = contentBlocks[event.index];
          if (block?.type === "text") block.text += deltaText;
          else contentBlocks[event.index] = { type: "text", text: deltaText };
          text += deltaText;
          try { opts.onToken?.(deltaText); } catch { /* swallow */ }
        } else if (event.delta.type === "input_json_delta") {
          const nextJson = `${toolInputDeltas.get(event.index) ?? ""}${event.delta.partial_json}`;
          toolInputDeltas.set(event.index, nextJson);
        }
        continue;
      }
      if (event.type === "content_block_stop") {
        const block = contentBlocks[event.index];
        if (block?.type === "tool_use") {
          const partialJson = toolInputDeltas.get(event.index);
          if (partialJson) {
            try {
              block.input = JSON.parse(partialJson) as Record<string, unknown>;
            } catch {
              block.input = {};
            }
          }
        }
        continue;
      }
      if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason ?? stopReason;
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
    }

    tokensIn += inputTokens;
    tokensOut += outputTokens;
    tokensUsed += inputTokens + outputTokens;
    const content = contentBlocks.filter(Boolean);

    if (stopReason === "end_turn") {
      const finalText = await finalizeToolLoopAnswer(opts, text, evidence);
      return { response: finalText, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }

    if (stopReason === "tool_use") {
      messages.push({ role: "assistant", content });

      const toolUseBlocks = content.filter(
        (block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
      );
      const toolPromises = toolUseBlocks.map(async (block) => {
        const args = block.input as Record<string, unknown>;
        opts.onToolCall?.(block.name, args);
        if (failureController.isBlocked(block.name, args)) {
          tracer.recordBudgetDecision("stop", `blocked: ${block.name}`, toolBudget.totalUsed, toolBudget.currentLimit);
          return { toolUseId: block.id, content: `[Tool blocked: ${block.name}] Previously blocked. Use collected evidence.` };
        }
        const budgetDecision = toolBudget.beforeTool(block.name, args);
        if (!budgetDecision.allowed) {
          if (opts.accuracyMode === "thorough" || opts.accuracyMode === "balanced") {
            const expand = toolBudget.tryExpand(`required evidence for ${block.name}`);
            if (expand.expanded) {
              tracer.recordBudgetDecision("expand", expand.reason, toolBudget.totalUsed, toolBudget.currentLimit);
            } else {
              tracer.recordBudgetDecision("stop", expand.reason, toolBudget.totalUsed, toolBudget.currentLimit);
            }
          }
          const retryDecision = toolBudget.beforeTool(block.name, args);
          if (!retryDecision.allowed) {
            tracer.recordBudgetDecision("stop", retryDecision.reason ?? budgetDecision.reason ?? "budget", toolBudget.totalUsed, toolBudget.currentLimit);
            return { toolUseId: block.id, content: formatToolBudgetStop(retryDecision.reason || budgetDecision.reason || "Tool budget reached.") };
          }
        }
        toolBudget.recordTool(block.name, args);
        toolsUsed.push(block.name);
        tracer.recordToolStart(block.name, args, toolBudget.totalUsed, toolBudget.currentLimit);
        const content = await executeToolWithTimeout(block.name, args, opts, failureAdvisor);
        const isErr = /^\[Tool (failed|blocked|budget)/.test(content.trim());
        if (isErr) {
          const { category, blocked, retryCount, guidance } = failureController.recordFailure(block.name, args, content);
          tracer.recordFailure(block.name, category, blocked, retryCount);
          tracer.recordToolEnd(block.name, content.length, false, category);
          toolBudget.recordResultUsefulness(false);
          return { toolUseId: block.id, content: guidance };
        }
        tracer.recordToolEnd(block.name, content.length, true);
        evidence.push(createEvidenceItem(block.name, args, content));
        const useful = content.length > 50;
        toolBudget.recordResultUsefulness(useful);
        const noProgressGuidance = useful ? null : failureController.recordNoProgress(block.name, args, content);
        if (noProgressGuidance) return { toolUseId: block.id, content: noProgressGuidance };
        if (toolBudget.shouldStopEarly()) {
          tracer.recordBudgetDecision("stop", "two consecutive tools added no new information", toolBudget.totalUsed, toolBudget.currentLimit);
        }
        const loopWarning = loopDetector.check(block.name, args);
        return { toolUseId: block.id, content: loopWarning ? `${loopWarning}\n\n${content}` : content };
      });
      const batchSafetyAnthropic = isBatchSafeForParallel(
        toolUseBlocks.map((b): BatchToolCall => ({ name: b.name, args: b.input as Record<string, unknown> | undefined })),
        opts.tools,
      );
      let pendingResults: Array<{ toolUseId: string; content: string }>;
      try {
        if (batchSafetyAnthropic.parallel) {
          pendingResults = await Promise.all(toolPromises);
        } else {
          // Sequential fallback — guards against clarify races, destructive bash,
          // and overlapping write_file/edit_file/patch on the same path.
          pendingResults = [];
          for (const p of toolPromises) pendingResults.push(await p);
        }
      } catch (error) {
        if (error instanceof SessionYieldSignal) {
          return buildYieldResult(error, { toolsUsed, tokensUsed, tokensIn, tokensOut });
        }
        throw error;
      }
      const budgetedResults = enforceAggregateToolResultBudget(pendingResults.map((result) => result.content));
      const results: Anthropic.ToolResultBlockParam[] = pendingResults.map((result, index) => ({
        type: "tool_result",
        tool_use_id: result.toolUseId,
        content: budgetedResults[index] ?? result.content,
      }));
      messages.push({ role: "user", content: results });
      continue;
    }

    // max_tokens or unexpected stop reason — return whatever text we have
    const finalText = await finalizeToolLoopAnswer(opts, text || "[No response]", evidence);
    return { response: finalText, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
  }

  const compressedEvidence = evidence.length > 0 ? compressEvidence(evidence) : "";
  tracer.recordSynthesisStart(evidence.length, Math.max(0, deadline - Date.now()), "anthropic tool-loop limit reached");
  return {
    response: compressedEvidence
      ? await synthesizeDeadlineAnswer({
          provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
          systemPrompt: `${opts.systemPrompt}\n\n${buildFinalSynthesisPrompt({ originalMessage: opts.userMessage, compressedEvidence, mode: opts.accuracyMode === "fast" ? "balanced" : (opts.accuracyMode ?? "balanced") })}`,
          maxTokens: opts.maxTokens, temperature: opts.temperature, fastMode: opts.fastMode,
          agentId: opts.agentId, channelSessionId: opts.channelSessionId,
          accumulatedMessages: messages as Array<{ role: string; content?: string }>,
          evidence, reason: "Tool-call limit reached.",
        })
      : "[Max tool calls reached — please ask a more specific question.]",
    toolsUsed,
    tokensUsed,
    tokensIn,
    tokensOut,
    tracer,
  };
}

// ── OpenAI-compatible (OpenAI, Groq, Together, OpenRouter, Ollama, DeepSeek, Mistral, GLM, Kimi, Grok) ──

async function callOpenAIWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const baseURL = resolveProviderBaseUrl(opts.provider, opts.baseUrl);
  const modelId = normalizeProviderScopedModelId(opts.provider, opts.modelId);
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: opts.apiKey || "ollama",
    defaultHeaders: getProviderRequiredHeaders(opts.provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider: opts.provider, baseUrl: baseURL }),
    maxRetries: 1,
  };
  if (baseURL) clientOpts.baseURL = baseURL;
  const client = new OpenAI(clientOpts);

  const toolsUsed: string[] = [];
  let tokensUsed = 0;
  let tokensIn   = 0;
  let tokensOut  = 0;
  const limit = resolveLimit(opts.maxToolCalls);
  const loopDetector = new LoopDetector();
  const failureAdvisor = new ToolFailureAdvisor();
  const failureController = new ToolFailureController();
  const deadline = Date.now() + (opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
  const synthReserveMs = opts.synthReserveMs ?? defaultSynthReserveMs(opts.accuracyMode);
  const toolBudget = new ToolBudgetTracker(
    opts.toolBudget ?? createToolBudgetPolicy(opts.modelLedLane ?? "read_only_workspace"),
    opts.maxExpandedToolBudget,
  );
  const evidence: EvidenceItem[] = [];
  const tracer = opts.tracer ?? new ToolTracer(opts.channelSessionId, opts.agentId, opts.provider, opts.modelId);
  let requiredToolRetryUsed = false;

  const serviceTier = resolveOpenAIFastServiceTier({
    provider: opts.provider,
    baseUrl: baseURL,
    fastMode: opts.fastMode,
  });
  const openAITools: OpenAI.ChatCompletionTool[] = opts.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  type Msg = OpenAI.ChatCompletionMessageParam;
  let messages: Msg[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  const compactOptsOAI: CompactOpts = {
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    maxTokens: opts.maxTokens,
    agentId: opts.agentId,
    sessionId: opts.channelSessionId,
  };
  const contextEngine = getContextEngine();

  for (let i = 0; i < limit; i++) {
    if (Date.now() > deadline) {
      tracer.recordDeadlineFallback();
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: messages as Array<{ role: string; content?: string }>,
        evidence,
      });
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }
    if (toolsUsed.length > 0 && Date.now() > deadline - synthReserveMs) {
      tracer.recordSynthesisStart(evidence.length, Math.max(0, deadline - Date.now()), "synthesis reserve reached");
      const synthStart = Date.now();
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: messages as Array<{ role: string; content?: string }>,
        evidence, reason: "Stopped tool use to preserve final synthesis time.",
      });
      tracer.recordSynthesisComplete(Date.now() - synthStart, synthesis.length, evidence.length > 0);
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }
    const prepared = await contextEngine.prepareOpenAI(messages, compactOptsOAI);
    messages = prepared.messages;

    // Stream the response so the user sees tokens as they arrive instead of
    // waiting silently for the whole round. We accumulate text + tool_calls
    // delta-by-delta, then decide whether to run tools or return the final
    // text after the stream completes. opts.onToken receives only text deltas.
    const stream = await client.chat.completions.create({
      model: modelId,
      messages,
      tools: openAITools,
      tool_choice: opts.requireToolUse && toolsUsed.length === 0 ? "required" : "auto",
      max_tokens: opts.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...getOpenAIChatExtraParams(opts.provider, modelId),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    });

    let accumulatedText = "";
    const toolCallDeltas = new Map<number, { id: string; name: string; argsText: string }>();
    let finishReason: string | null = null;
    let usagePromptTokens = 0;
    let usageCompletionTokens = 0;
    let usageTotalTokens = 0;

    for await (const chunk of stream) {
      const c = chunk.choices?.[0];
      if (chunk.usage) {
        usagePromptTokens = chunk.usage.prompt_tokens ?? usagePromptTokens;
        usageCompletionTokens = chunk.usage.completion_tokens ?? usageCompletionTokens;
        usageTotalTokens = chunk.usage.total_tokens ?? usageTotalTokens;
      }
      if (!c) continue;
      if (c.finish_reason) finishReason = c.finish_reason;
      const delta = c.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        accumulatedText += delta.content;
        if (opts.onToken) {
          try { opts.onToken(delta.content); } catch { /* swallow */ }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index ?? 0;
          const existing = toolCallDeltas.get(idx) ?? { id: "", name: "", argsText: "" };
          if (tcDelta.id) existing.id = tcDelta.id;
          if (tcDelta.function?.name) existing.name += tcDelta.function.name;
          if (tcDelta.function?.arguments) existing.argsText += tcDelta.function.arguments;
          toolCallDeltas.set(idx, existing);
        }
      }
    }

    tokensIn += usagePromptTokens;
    tokensOut += usageCompletionTokens;
    tokensUsed += usageTotalTokens;

    if (
      opts.requireToolUse &&
      toolsUsed.length === 0 &&
      toolCallDeltas.size === 0 &&
      accumulatedText.length > 0 &&
      openAITools.length > 0 &&
      !requiredToolRetryUsed
    ) {
      requiredToolRetryUsed = true;
      messages.push({ role: "assistant", content: accumulatedText });
      messages.push({
        role: "user",
        content: "The answer requires direct tool evidence. Call at least one relevant available tool now, then answer from the result. Do not finalize from assumptions alone.",
      });
      continue;
    }

    if (finishReason === "stop" || (toolCallDeltas.size === 0 && accumulatedText.length > 0)) {
      const finalText = await finalizeToolLoopAnswer(opts, accumulatedText || "[No response]", evidence);
      return { response: finalText, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }

    if (finishReason === "tool_calls" || toolCallDeltas.size > 0) {
      // Reconstruct the assistant message in the format expected by subsequent rounds.
      const reconstructedToolCalls = Array.from(toolCallDeltas.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argsText || "{}" },
        }));
      messages.push({
        role: "assistant",
        content: accumulatedText || null,
        tool_calls: reconstructedToolCalls,
      });
      const toolCalls = reconstructedToolCalls;
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ok */ }
        opts.onToolCall?.(tc.function.name, args);
      }
      const toolCallPromises = toolCalls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ok */ }

        if (failureController.isBlocked(tc.function.name, args)) {
          const msg = `[Tool blocked: ${tc.function.name}] This exact call was previously blocked or failed repeatedly. Use collected evidence instead.`;
          tracer.recordBudgetDecision("stop", `blocked: ${tc.function.name}`, toolBudget.totalUsed, toolBudget.currentLimit);
          return { toolCallId: tc.id, content: msg };
        }

        const budgetDecision = toolBudget.beforeTool(tc.function.name, args);
        if (!budgetDecision.allowed) {
          if (opts.accuracyMode === "thorough" || opts.accuracyMode === "balanced") {
            const expand = toolBudget.tryExpand(`required evidence for ${tc.function.name}`);
            if (expand.expanded) {
              tracer.recordBudgetDecision("expand", expand.reason, toolBudget.totalUsed, toolBudget.currentLimit);
              const retryDecision = toolBudget.beforeTool(tc.function.name, args);
              if (retryDecision.allowed) {
                toolBudget.recordTool(tc.function.name, args);
                toolsUsed.push(tc.function.name);
                tracer.recordToolStart(tc.function.name, args, toolBudget.totalUsed, toolBudget.currentLimit);
                const content = await executeToolWithTimeout(tc.function.name, args, opts, failureAdvisor);
                const isErr = /^\[Tool (failed|blocked|budget)/.test(content.trim());
                tracer.recordToolEnd(tc.function.name, content.length, !isErr, isErr ? "tool_error" : undefined);
                evidence.push(createEvidenceItem(tc.function.name, args, content));
                const useful = !isErr && content.length > 50;
                toolBudget.recordResultUsefulness(useful);
                const noProgressGuidance = useful ? null : failureController.recordNoProgress(tc.function.name, args, content);
                if (noProgressGuidance) return { toolCallId: tc.id, content: noProgressGuidance };
                const loopWarning = loopDetector.check(tc.function.name, args);
                return { toolCallId: tc.id, content: loopWarning ? `${loopWarning}\n\n${content}` : content };
              }
            }
          }
          tracer.recordBudgetDecision("stop", budgetDecision.reason ?? "budget", toolBudget.totalUsed, toolBudget.currentLimit);
          return { toolCallId: tc.id, content: formatToolBudgetStop(budgetDecision.reason || "Tool budget reached.") };
        }
        toolBudget.recordTool(tc.function.name, args);
        toolsUsed.push(tc.function.name);
        tracer.recordToolStart(tc.function.name, args, toolBudget.totalUsed, toolBudget.currentLimit);
        const content = await executeToolWithTimeout(tc.function.name, args, opts, failureAdvisor);
        const isErr = /^\[Tool (failed|blocked|budget)/.test(content.trim());
        if (isErr) {
          const { category, blocked, retryCount, guidance } = failureController.recordFailure(tc.function.name, args, content);
          tracer.recordFailure(tc.function.name, category, blocked, retryCount);
          tracer.recordToolEnd(tc.function.name, content.length, false, category);
          toolBudget.recordResultUsefulness(false);
          return { toolCallId: tc.id, content: guidance };
        }
        tracer.recordToolEnd(tc.function.name, content.length, true);
        evidence.push(createEvidenceItem(tc.function.name, args, content));
        const useful = content.length > 50;
        toolBudget.recordResultUsefulness(useful);
        const noProgressGuidance = useful ? null : failureController.recordNoProgress(tc.function.name, args, content);
        if (noProgressGuidance) return { toolCallId: tc.id, content: noProgressGuidance };
        if (toolBudget.shouldStopEarly()) {
          tracer.recordBudgetDecision("stop", "two consecutive tools added no new information", toolBudget.totalUsed, toolBudget.currentLimit);
        }
        const loopWarning = loopDetector.check(tc.function.name, args);
        return { toolCallId: tc.id, content: loopWarning ? `${loopWarning}\n\n${content}` : content };
      });
      const batchSafetyOpenAI = isBatchSafeForParallel(
        toolCalls.map((tc): BatchToolCall => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
          return { name: tc.function.name, args: parsed };
        }),
        opts.tools,
      );
      let pendingToolMessages: Array<{ toolCallId: string; content: string }>;
      try {
        if (batchSafetyOpenAI.parallel) {
          pendingToolMessages = await Promise.all(toolCallPromises);
        } else {
          pendingToolMessages = [];
          for (const p of toolCallPromises) pendingToolMessages.push(await p);
        }
      } catch (error) {
        if (error instanceof SessionYieldSignal) {
          return buildYieldResult(error, { toolsUsed, tokensUsed, tokensIn, tokensOut });
        }
        throw error;
      }
      const budgetedToolMessages = enforceAggregateToolResultBudget(pendingToolMessages.map((result) => result.content));
      for (const [index, toolMessage] of pendingToolMessages.entries()) {
        messages.push({ role: "tool", tool_call_id: toolMessage.toolCallId, content: budgetedToolMessages[index] ?? toolMessage.content });
      }
      continue;
    }

    // Fallback for unexpected finish reasons (length, content_filter, etc.) —
    // return whatever text we accumulated.
    const finalText = await finalizeToolLoopAnswer(opts, accumulatedText || "[No response]", evidence);
    return { response: finalText, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
  }

  const remainingMs = deadline - Date.now();
  tracer.recordSynthesisStart(evidence.length, Math.max(0, remainingMs), "tool-call limit reached");
  const synthStart = Date.now();
  const compressedEvidence = evidence.length > 0 ? compressEvidence(evidence) : "";
  const synthPrompt = evidence.length > 0
    ? buildFinalSynthesisPrompt({
        originalMessage: opts.userMessage,
        compressedEvidence,
        mode: opts.accuracyMode === "fast" ? "balanced" : (opts.accuracyMode ?? "balanced"),
      })
    : undefined;
  const finalAnswer = await synthesizeDeadlineAnswer({
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    systemPrompt: synthPrompt ? `${opts.systemPrompt}\n\n${synthPrompt}` : opts.systemPrompt,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    fastMode: opts.fastMode,
    agentId: opts.agentId,
    channelSessionId: opts.channelSessionId,
    accumulatedMessages: messages as Array<{ role: string; content?: string }>,
    evidence,
    reason: "The tool-call budget is reached.",
  });
  tracer.recordSynthesisComplete(Date.now() - synthStart, finalAnswer.length, evidence.length > 0);
  log.info(tracer.formatSummary(toolsUsed));
  return { response: finalAnswer, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
// Uses Gemini function declarations, but keeps tool execution in disp8ch AI's
// own loop so provider SDK quirks cannot bypass budgets, tracing, or evidence.

async function callGeminiWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const genai = await import("@google/genai");
  const baseURL = resolveProviderBaseUrl(opts.provider, opts.baseUrl);
  const modelId = normalizeProviderScopedModelId(opts.provider, opts.modelId);
  const ai = new genai.GoogleGenAI({
    apiKey: opts.apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const toolsUsed: string[] = [];
  const limit = resolveLimit(opts.maxToolCalls);
  const loopDetector = new LoopDetector();
  const failureAdvisor = new ToolFailureAdvisor();
  const failureController = new ToolFailureController();
  const deadline = Date.now() + (opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
  const synthReserveMs = opts.synthReserveMs ?? defaultSynthReserveMs(opts.accuracyMode);
  const toolBudget = new ToolBudgetTracker(
    opts.toolBudget ?? createToolBudgetPolicy(opts.modelLedLane ?? "read_only_workspace"),
    opts.maxExpandedToolBudget,
  );
  const evidence: EvidenceItem[] = [];
  const tracer = opts.tracer ?? new ToolTracer(opts.channelSessionId, opts.agentId, opts.provider, opts.modelId);
  let latestToolOutput = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensUsed = 0;
  const contextEngine = getContextEngine();
  const compactOpts: CompactOpts = {
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    maxTokens: opts.maxTokens,
    agentId: opts.agentId,
    sessionId: opts.channelSessionId,
  };
  const executedToolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
  }> = [];
  const readGeminiUsage = (
    usage?: { promptTokenCount?: number; candidatesTokenCount?: number; responseTokenCount?: number; totalTokenCount?: number },
  ) => {
    const tokensIn = usage?.promptTokenCount ?? 0;
    const tokensOut = usage?.candidatesTokenCount ?? usage?.responseTokenCount ?? 0;
    const tokensUsed = usage?.totalTokenCount ?? (tokensIn + tokensOut);
    return { tokensIn, tokensOut, tokensUsed };
  };

  type GemFunctionCall = {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };

  type GeminiTurnResponse = {
    text?: string;
    functionCalls?: GemFunctionCall[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; responseTokenCount?: number; totalTokenCount?: number };
  };

  const finalizeFromToolOutput = async (): Promise<ToolCallResult> => {
    try {
      const followupStream = await ai.models.generateContentStream({
        model: modelId,
        contents: [
          `Original request:\n${opts.userMessage}`,
          `Latest tool output:\n${latestToolOutput.slice(0, 12000)}`,
          "Write the final user-facing answer now. Do not call tools.",
        ].join("\n\n"),
        config: {
          systemInstruction: `${opts.systemPrompt}\n\nAll necessary tools have already finished. Do not call tools again.`,
          maxOutputTokens: opts.maxTokens,
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        },
      });
      let text = "";
      let usageMetadata: GeminiTurnResponse["usageMetadata"];
      for await (const chunk of followupStream) {
        const delta = chunk.text ?? "";
        if (delta) {
          text += delta;
          try { opts.onToken?.(delta); } catch { /* swallow */ }
        }
        usageMetadata = chunk.usageMetadata ?? usageMetadata;
      }
      const usage = readGeminiUsage(usageMetadata);
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      tokensUsed += usage.tokensUsed;
      text = text.trim();
      const draft =
        text ||
        `Tool execution completed, but Gemini failed to finalize the turn.\n\nLatest tool output:\n${latestToolOutput.slice(0, 1800)}`;
      const finalText = await finalizeToolLoopAnswer(opts, draft, evidence);
      return {
        response: finalText,
        toolsUsed,
        tokensUsed,
        tokensIn,
        tokensOut,
        tracer,
      };
    } catch (error) {
      log.warn("Gemini no-tool finalization failed", { error: String(error) });
      return {
        response: `Tool execution completed, but Gemini failed to finalize the turn.\n\nLatest tool output:\n${latestToolOutput.slice(0, 1800)}`,
        toolsUsed,
        tokensUsed,
        tokensIn,
        tokensOut,
        tracer,
      };
    }
  };

  const maybeCompactGeminiToolContext = async () => {
    if (executedToolCalls.length === 0) return;
    const shadowMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userMessage },
      {
        role: "assistant",
        content: "",
        tool_calls: executedToolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      },
      ...executedToolCalls.map((call) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: call.result,
      })),
      {
        role: "assistant",
        content: "Tool results recorded for compaction handoff.",
      },
    ];
    const prepared = await contextEngine.prepareOpenAI(shadowMessages, compactOpts);
    log.info("Gemini shadow context prepared", {
      compacted: prepared.compacted,
      pruned: prepared.pruned,
      sessionId: opts.channelSessionId,
      agentId: opts.agentId,
      shadowMessages: shadowMessages.length,
    });
  };

  const toolByName = new Map(opts.tools.map((toolDef) => [toolDef.name, toolDef]));
  const geminiTools = [{
    functionDeclarations: opts.tools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      parametersJsonSchema: toolDef.parameters,
    })),
  }];

  const executeGeminiFunctionCalls = async (functionCalls: GemFunctionCall[]) => {
    const slots: Array<{ callId: string; name: string; args: Record<string, unknown>; resultIndex: number }> = [];
    for (const functionCall of functionCalls) {
      const name = String(functionCall.name || "").trim();
      if (!name) continue;
      const args = (functionCall.args ?? {}) as Record<string, unknown>;
      opts.onToolCall?.(name, args);
      const callId = functionCall.id ?? `${name}-${executedToolCalls.length + 1}`;
      const resultIndex = executedToolCalls.length;
      executedToolCalls.push({ id: callId, name, args, result: "" });
      slots.push({ callId, name, args, resultIndex });
    }
    const callPromises = slots.map(async (slot) => {
      if (!toolByName.has(slot.name)) {
        const content = `[Tool blocked: ${slot.name}] This tool was not declared in the current Gemini toolset. Use collected evidence instead.`;
        return { callId: slot.callId, name: slot.name, content, resultIndex: slot.resultIndex };
      }
      if (failureController.isBlocked(slot.name, slot.args)) {
        const msg = `[Tool blocked: ${slot.name}] This exact call was previously blocked or failed repeatedly. Use collected evidence instead.`;
        tracer.recordBudgetDecision("stop", `blocked: ${slot.name}`, toolBudget.totalUsed, toolBudget.currentLimit);
        return { callId: slot.callId, name: slot.name, content: msg, resultIndex: slot.resultIndex };
      }
      const budgetDecision = toolBudget.beforeTool(slot.name, slot.args);
      if (!budgetDecision.allowed) {
        if (opts.accuracyMode === "thorough" || opts.accuracyMode === "balanced") {
          const expand = toolBudget.tryExpand(`required evidence for ${slot.name}`);
          if (expand.expanded) {
            tracer.recordBudgetDecision("expand", expand.reason, toolBudget.totalUsed, toolBudget.currentLimit);
          } else {
            tracer.recordBudgetDecision("stop", expand.reason, toolBudget.totalUsed, toolBudget.currentLimit);
          }
        }
        const retryDecision = toolBudget.beforeTool(slot.name, slot.args);
        if (!retryDecision.allowed) {
          tracer.recordBudgetDecision("stop", retryDecision.reason ?? budgetDecision.reason ?? "budget", toolBudget.totalUsed, toolBudget.currentLimit);
          return {
            callId: slot.callId,
            name: slot.name,
            content: formatToolBudgetStop(retryDecision.reason || budgetDecision.reason || "Tool budget reached."),
            resultIndex: slot.resultIndex,
          };
        }
      }
      toolBudget.recordTool(slot.name, slot.args);
      toolsUsed.push(slot.name);
      tracer.recordToolStart(slot.name, slot.args, toolBudget.totalUsed, toolBudget.currentLimit);
      const content = await executeToolWithTimeout(slot.name, slot.args, opts, failureAdvisor);
      const isErr = /^\[Tool (failed|blocked|budget)/.test(content.trim());
      if (isErr) {
        const { category, blocked, retryCount, guidance } = failureController.recordFailure(slot.name, slot.args, content);
        tracer.recordFailure(slot.name, category, blocked, retryCount);
        tracer.recordToolEnd(slot.name, content.length, false, category);
        toolBudget.recordResultUsefulness(false);
        return { callId: slot.callId, name: slot.name, content: guidance, resultIndex: slot.resultIndex };
      }
      tracer.recordToolEnd(slot.name, content.length, true);
      evidence.push(createEvidenceItem(slot.name, slot.args, content));
      const useful = content.length > 50;
      toolBudget.recordResultUsefulness(useful);
      const noProgressGuidance = useful ? null : failureController.recordNoProgress(slot.name, slot.args, content);
      if (noProgressGuidance) {
        return { callId: slot.callId, name: slot.name, content: noProgressGuidance, resultIndex: slot.resultIndex };
      }
      if (toolBudget.shouldStopEarly()) {
        tracer.recordBudgetDecision("stop", "two consecutive tools added no new information", toolBudget.totalUsed, toolBudget.currentLimit);
      }
      const loopWarning = loopDetector.check(slot.name, slot.args);
      return {
        callId: slot.callId,
        name: slot.name,
        content: loopWarning ? `${loopWarning}\n\n${content}` : content,
        resultIndex: slot.resultIndex,
      };
    });
    const batchSafetyGemini = isBatchSafeForParallel(
      slots.map((s): BatchToolCall => ({ name: s.name, args: s.args })),
      opts.tools,
    );
    let allResults: Awaited<typeof callPromises[number]>[];
    if (batchSafetyGemini.parallel) {
      allResults = await Promise.all(callPromises);
    } else {
      allResults = [];
      for (const p of callPromises) allResults.push(await p);
    }
    const budgetedGeminiResults = enforceAggregateToolResultBudget(allResults.map((result) => result.content));
    const parts = [];
    for (const [index, result] of allResults.entries()) {
      const content = budgetedGeminiResults[index] ?? result.content;
      latestToolOutput = content;
      executedToolCalls[result.resultIndex].result = content;
      parts.push(
        genai.createPartFromFunctionResponse(
          result.callId,
          result.name,
          { output: content },
        ),
      );
    }
    await maybeCompactGeminiToolContext();
    return parts;
  };

  const chat = ai.chats.create({
    model: modelId,
    config: {
      systemInstruction: opts.systemPrompt,
      maxOutputTokens: opts.maxTokens,
      tools: geminiTools,
      toolConfig: {
        functionCallingConfig: { mode: genai.FunctionCallingConfigMode.AUTO },
      },
      automaticFunctionCalling: {
        disable: true,
        maximumRemoteCalls: 0,
      },
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    },
  });

  const sendGeminiStream = async (
    params: Parameters<typeof chat.sendMessageStream>[0],
    emitText: boolean,
  ): Promise<GeminiTurnResponse> => {
    const stream = await chat.sendMessageStream(params);
    let text = "";
    let usageMetadata: GeminiTurnResponse["usageMetadata"];
    let functionCalls: GemFunctionCall[] = [];
    for await (const chunk of stream) {
      const delta = chunk.text ?? "";
      if (delta) {
        text += delta;
        if (emitText) {
          try { opts.onToken?.(delta); } catch { /* swallow */ }
        }
      }
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        functionCalls = chunk.functionCalls as GemFunctionCall[];
      }
      usageMetadata = chunk.usageMetadata ?? usageMetadata;
    }
    return { text, functionCalls, usageMetadata };
  };

  let response: GeminiTurnResponse;
  try {
    response = await sendGeminiStream({ message: opts.userMessage }, true);
  } catch (error) {
    if (error instanceof SessionYieldSignal) {
      return buildYieldResult(error, { toolsUsed, tokensUsed, tokensIn, tokensOut });
    }
    throw error;
  }

  for (let i = 0; i < limit; i++) {
    if (Date.now() > deadline) {
      tracer.recordDeadlineFallback();
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: executedToolCalls.map((call) => ({ role: "tool", content: call.result })),
        evidence,
      });
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }
    if (toolsUsed.length > 0 && Date.now() > deadline - synthReserveMs) {
      tracer.recordSynthesisStart(evidence.length, Math.max(0, deadline - Date.now()), "synthesis reserve reached");
      const synthStart = Date.now();
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: executedToolCalls.map((call) => ({ role: "tool", content: call.result })),
        evidence, reason: "Stopped tool use to preserve final synthesis time.",
      });
      tracer.recordSynthesisComplete(Date.now() - synthStart, synthesis.length, evidence.length > 0);
      log.info(tracer.formatSummary(toolsUsed));
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut, tracer };
    }

    const usage = readGeminiUsage(response.usageMetadata);
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;
    tokensUsed += usage.tokensUsed;

    const text = response.text?.trim() || "";
    const functionCalls = (response.functionCalls ?? []) as GemFunctionCall[];
    if (functionCalls.length === 0) {
      const draft =
        text ||
        (latestToolOutput
          ? `Tool execution completed, but the model returned no final text.\n\nLatest tool output:\n${latestToolOutput.slice(0, 1800)}`
          : "[No response]");
      const finalText = await finalizeToolLoopAnswer(opts, draft, evidence);
      return {
        response: finalText,
        toolsUsed,
        tokensUsed,
        tokensIn,
        tokensOut,
        tracer,
      };
    }
    try {
      const functionResponseParts = await executeGeminiFunctionCalls(functionCalls);
      response = await sendGeminiStream({
        message: functionResponseParts,
        config: {
          systemInstruction: opts.systemPrompt,
          maxOutputTokens: opts.maxTokens,
          tools: geminiTools,
          toolConfig: {
            functionCallingConfig: { mode: genai.FunctionCallingConfigMode.AUTO },
          },
          automaticFunctionCalling: {
            disable: true,
            maximumRemoteCalls: 0,
          },
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        },
      }, true);
    } catch (error) {
      if (error instanceof SessionYieldSignal) {
        return buildYieldResult(error, { toolsUsed, tokensUsed, tokensIn, tokensOut });
      }
      if (latestToolOutput && String(error).includes("thought_signature")) {
        return finalizeFromToolOutput();
      }
      throw error;
    }
  }

  tracer.recordSynthesisStart(evidence.length, Math.max(0, deadline - Date.now()), "gemini tool-loop limit reached");
  const compressedEvidence = evidence.length > 0 ? compressEvidence(evidence) : "";
  const synthesis = await synthesizeDeadlineAnswer({
    provider: opts.provider,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    systemPrompt: compressedEvidence
      ? `${opts.systemPrompt}\n\n${buildFinalSynthesisPrompt({
          originalMessage: opts.userMessage,
          compressedEvidence,
          mode: opts.accuracyMode === "fast" ? "balanced" : (opts.accuracyMode ?? "balanced"),
        })}`
      : opts.systemPrompt,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    fastMode: opts.fastMode,
    agentId: opts.agentId,
    channelSessionId: opts.channelSessionId,
    accumulatedMessages: executedToolCalls.map((call) => ({ role: "tool", content: call.result })),
    evidence,
    reason: "Gemini tool-call limit reached.",
  });
  tracer.recordSynthesisComplete(0, synthesis.length, evidence.length > 0);
  log.info(tracer.formatSummary(toolsUsed));
  return {
    response: synthesis,
    toolsUsed,
    tokensUsed,
    tokensIn,
    tokensOut,
    tracer,
  };
}

async function callOpenAIResponsesWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const baseURL = resolveProviderBaseUrl(opts.provider, opts.baseUrl);
  const modelId = normalizeProviderScopedModelId(opts.provider, opts.modelId);
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: getProviderRequiredHeaders(opts.provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider: opts.provider, baseUrl: baseURL }),
    maxRetries: 1,
  });

  const toolsUsed: string[] = [];
  let tokensUsed = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let previousResponseId: string | null = null;
  let latestToolOutput = "";
  let input: Array<
    | {
        type: "message";
        role: "user";
        content: string;
      }
    | {
        id: string;
        type: "function_call_output";
        call_id: string;
        output: string;
      }
  > = [{ type: "message", role: "user", content: opts.userMessage }];
  const limit = resolveLimit(opts.maxToolCalls);
  const loopDetector = new LoopDetector();
  const failureAdvisor = new ToolFailureAdvisor();
  const deadline = Date.now() + (opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
  const evidence: EvidenceItem[] = [];
  const serviceTier = resolveOpenAIFastServiceTier({
    provider: opts.provider,
    baseUrl: baseURL,
    fastMode: opts.fastMode,
  });
  const responseTools = opts.tools.map((toolDef) => ({
    type: "function" as const,
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    strict: false,
  }));

  for (let i = 0; i < limit; i++) {
    if (Date.now() > deadline) {
      const synthesis = await synthesizeDeadlineAnswer({
        provider: opts.provider, modelId: opts.modelId, apiKey: opts.apiKey, baseUrl: opts.baseUrl,
        systemPrompt: opts.systemPrompt, maxTokens: opts.maxTokens, temperature: opts.temperature,
        fastMode: opts.fastMode, agentId: opts.agentId, channelSessionId: opts.channelSessionId,
        accumulatedMessages: [],
      });
      return { response: synthesis, toolsUsed, tokensUsed, tokensIn, tokensOut };
    }
    const res: OpenAI.Responses.Response = await client.responses.create({
      model: modelId,
      instructions: opts.systemPrompt,
      input,
      max_output_tokens: opts.maxTokens,
      tools: responseTools,
      tool_choice: opts.requireToolUse && toolsUsed.length === 0 ? "required" : "auto",
      parallel_tool_calls: true,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    });

    tokensIn += res.usage?.input_tokens ?? 0;
    tokensOut += res.usage?.output_tokens ?? 0;
    tokensUsed += res.usage?.total_tokens ?? 0;

    const functionCalls = res.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );
    const text = res.output_text?.trim() ?? "";

    if (functionCalls.length === 0) {
      const draft =
        text ||
        (latestToolOutput
          ? `Tool execution completed, but the model returned no final text.\n\nLatest tool output:\n${latestToolOutput.slice(0, 1800)}`
          : "[No response]");
      const finalText = await finalizeToolLoopAnswer(opts, draft, evidence);
      return {
        response: finalText,
        toolsUsed,
        tokensUsed,
        tokensIn,
        tokensOut,
      };
    }

    previousResponseId = res.id;
    input = [];

    for (const functionCall of functionCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(functionCall.arguments) as Record<string, unknown>;
      } catch {
        // Ignore malformed function args and execute with empty input.
      }
      opts.onToolCall?.(functionCall.name, args);
      toolsUsed.push(functionCall.name);
    }
    const fnCallPromises = functionCalls.map(async (functionCall) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(functionCall.arguments) as Record<string, unknown>;
      } catch {
        // Ignore malformed function args and execute with empty input.
      }
      const content = await executeToolWithTimeout(functionCall.name, args, opts, failureAdvisor);
      evidence.push(createEvidenceItem(functionCall.name, args, content));
      const loopWarning = loopDetector.check(functionCall.name, args);
      return { callId: functionCall.call_id, content: loopWarning ? `${loopWarning}\n\n${content}` : content };
    });
    const batchSafetyResponses = isBatchSafeForParallel(
      functionCalls.map((fc): BatchToolCall => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(fc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
        return { name: fc.name, args: parsed };
      }),
      opts.tools,
    );
    let pendingFunctionOutputs: Array<{ callId: string; content: string }>;
    try {
      if (batchSafetyResponses.parallel) {
        pendingFunctionOutputs = await Promise.all(fnCallPromises);
      } else {
        pendingFunctionOutputs = [];
        for (const p of fnCallPromises) pendingFunctionOutputs.push(await p);
      }
    } catch (error) {
      if (error instanceof SessionYieldSignal) {
        return buildYieldResult(error, { toolsUsed, tokensUsed, tokensIn, tokensOut });
      }
      throw error;
    }

    const budgetedFunctionOutputs = enforceAggregateToolResultBudget(pendingFunctionOutputs.map((result) => result.content));
    for (const [index, pendingOutput] of pendingFunctionOutputs.entries()) {
      const toolResult = budgetedFunctionOutputs[index] ?? pendingOutput.content;
      latestToolOutput = toolResult;

      input.push({
        id: `fcout_${crypto.randomBytes(6).toString("hex")}`,
        type: "function_call_output",
        call_id: pendingOutput.callId,
        output: toolResult,
      });
    }

  }

  const finalText = evidence.length > 0
    ? await finalizeToolLoopAnswer(opts, "[Max tool calls reached. Here is the best supported answer from collected evidence.]", evidence)
    : "[Max tool calls reached — please ask a more specific question.]";
  return {
    response: finalText,
    toolsUsed,
    tokensUsed,
    tokensIn,
    tokensOut,
  };
}


// ── Provider failover ─────────────────────────────────────────────────────────

type ActiveModelCandidate = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  fastMode?: boolean;
};

function loadActiveModels(): ActiveModelCandidate[] {
  const rows = getSqlite()
    .prepare(
      `
        SELECT provider, model_id, api_key, base_url, max_tokens, fast_mode
        FROM models
        WHERE is_active = 1
        ORDER BY priority DESC, created_at DESC
      `,
    )
    .all() as Array<{
      provider: string;
      model_id: string;
      api_key: string | null;
      base_url: string | null;
      max_tokens: number | null;
      fast_mode: number | null;
    }>;

  return rows
    .map((row): ActiveModelCandidate | null => {
      const provider = normalizeProviderId(row.provider) ?? row.provider.trim().toLowerCase();
      try {
        const auth = providerUsesOAuth(provider)
          ? resolveProviderOAuthCredential(provider)
          : resolveModelApiKey({ provider, storedApiKey: row.api_key });
        return {
          provider,
          modelId: resolveModelAlias(row.model_id),
          apiKey: auth.apiKey,
          baseUrl: row.base_url ?? (auth as { baseUrl?: string }).baseUrl ?? undefined,
          maxTokens: row.max_tokens ?? undefined,
          fastMode: row.fast_mode === 1,
        };
      } catch {
        return null;
      }
    })
    .filter((row): row is ActiveModelCandidate => row !== null)
    .filter((row) => row.provider === "anthropic" || !providerRequiresApiKey(row.provider) || Boolean(row.apiKey));
}

function resolveOAuthToolOptions(opts: ToolCallOptions): ToolCallOptions {
  if (!providerUsesOAuth(opts.provider)) return opts;
  try {
    const auth = resolveProviderOAuthCredential(opts.provider);
    return {
      ...opts,
      apiKey: auth.apiKey,
      baseUrl: opts.baseUrl || auth.baseUrl,
    };
  } catch (error) {
    if (!opts.apiKey) throw error;
    return opts;
  }
}

async function dispatchToProvider(opts: ToolCallOptions): Promise<ToolCallResult> {
  const provider = normalizeProviderId(opts.provider) ?? opts.provider.trim().toLowerCase();
  const modelId = resolveModelAlias(opts.modelId);
  const apiMode = resolveProviderApiMode(provider, modelId);
  const support = checkModelToolSupport(provider, modelId);

  if (opts.tools.length > 0 && support.status === "unsupported") {
    const recommendations = support.recommendations.map((model) => model.id).slice(0, 3);
    const suffix = recommendations.length ? ` Recommended tool-capable models: ${recommendations.join(", ")}` : "";
    throw new Error(`${support.reason}${suffix}`);
  }

  const resolvedOpts: ToolCallOptions = resolveOAuthToolOptions({
    ...opts,
    provider,
    modelId,
  });

  if (provider === "anthropic" || apiMode === "anthropic") return callAnthropicWithTools(resolvedOpts);
  if (provider === "google" || apiMode === "google") return callGeminiWithTools(resolvedOpts);
  if (apiMode === "openai-responses") return callOpenAIResponsesWithTools(resolvedOpts);
  return callOpenAIWithTools(resolvedOpts);
}

export async function callWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const toolRuntimeSessionId = opts.toolRuntimeSessionId ?? crypto.randomBytes(8).toString("hex");
  let resolvedOpts: ToolCallOptions = {
    ...opts,
    provider: normalizeProviderId(opts.provider) ?? opts.provider.trim().toLowerCase(),
    modelId: resolveModelAlias(opts.modelId),
    toolRuntimeSessionId,
  };
  let routeLabel: string | null = null;

  const smartRoute = opts.enableSmartRouting
    ? resolveSmartRoute({
        userMessage: opts.userMessage,
        requireTools: opts.tools.length > 0,
        current: {
          provider: resolvedOpts.provider,
          modelId: resolvedOpts.modelId,
          apiKey: resolvedOpts.apiKey,
        },
      })
    : null;

  if (smartRoute) {
    resolvedOpts = {
      ...resolvedOpts,
      provider: smartRoute.provider,
      modelId: smartRoute.modelId,
      apiKey: smartRoute.apiKey,
      baseUrl: smartRoute.baseUrl ?? resolvedOpts.baseUrl,
      maxTokens: smartRoute.maxTokens ?? resolvedOpts.maxTokens,
      fastMode: smartRoute.fastMode,
    };
    routeLabel = smartRoute.routeLabel;
  }

  const exactIdentifierResolution = await resolveExactIdentifierFromMemory(resolvedOpts).catch((error) => {
    log.warn("Exact identifier recall resolution failed", {
      sessionId: resolvedOpts.channelSessionId,
      agentId: resolvedOpts.agentId,
      error: String(error),
    });
    return null;
  });

  if (exactIdentifierResolution) {
    const wantsOnlyIdentifier = isIdentifierOnlyReplyQuery(resolvedOpts.userMessage);
    return {
      response: exactIdentifierResolution.response || (wantsOnlyIdentifier
        ? exactIdentifierResolution.identifier
        : [
            `The current exact identifier is ${exactIdentifierResolution.identifier}.`,
            `Source memory: ${exactIdentifierResolution.snippet}`,
          ].join("\n")),
      toolsUsed: [],
      tokensUsed: 0,
      tokensIn: 0,
      tokensOut: 0,
      provider: resolvedOpts.provider,
      modelId: resolvedOpts.modelId,
      routeLabel,
    };
  }

  resolvedOpts = await injectActiveMemoryContext(resolvedOpts);

  // Background skill review: after every SKILL_NUDGE_INTERVAL turns per session,
  // fire a background LLM review of the full conversation to create workspace skills.
  const nudgeSessionId = opts.channelSessionId;
  const nudgeState = nudgeSessionId ? getOrCreateNudgeState(nudgeSessionId) : null;

  try {
    const primary = await dispatchToProvider(resolvedOpts);
    if (nudgeState) {
      nudgeState.turnCount++;
      // Fire background skill review every N turns — fire-and-forget, never blocks
      if (nudgeSessionId && nudgeState.turnCount % SKILL_NUDGE_INTERVAL === 0) {
        void import("@/lib/agents/skill-review").then(({ runBackgroundSkillReview }) =>
          runBackgroundSkillReview({
            sessionId: nudgeSessionId,
            agentId: resolvedOpts.agentId,
            provider: resolvedOpts.provider,
            modelId: resolvedOpts.modelId,
            apiKey: resolvedOpts.apiKey,
            baseUrl: resolvedOpts.baseUrl,
          }).catch(() => {}),
        );
      }
    }
    return {
      ...primary,
      provider: primary.provider ?? resolvedOpts.provider,
      modelId: primary.modelId ?? resolvedOpts.modelId,
      routeLabel: primary.routeLabel ?? routeLabel,
    };
  } catch (error) {
    if (nudgeState) nudgeState.turnCount++;
    if (!isRateLimitError(error)) throw error;

    const models = loadActiveModels();
    for (const model of models) {
      if (
        (model.provider === resolvedOpts.provider &&
          model.modelId === resolvedOpts.modelId &&
          model.apiKey === resolvedOpts.apiKey) ||
        (model.provider === resolvedOpts.provider &&
          model.apiKey === resolvedOpts.apiKey)
      ) {
        continue;
      }
      if (resolvedOpts.tools.length > 0 && checkModelToolSupport(model.provider, model.modelId).status === "unsupported") {
        continue;
      }

      log.info("Failover attempt", { provider: model.provider, model: model.modelId });
      try {
        const fallback = await dispatchToProvider({
          ...resolvedOpts,
          provider: model.provider,
          modelId: model.modelId,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl ?? resolvedOpts.baseUrl,
          maxTokens: model.maxTokens ?? resolvedOpts.maxTokens,
          fastMode: model.fastMode ?? resolvedOpts.fastMode,
        });
        return {
          ...fallback,
          provider: model.provider,
          modelId: model.modelId,
          routeLabel,
        };
      } catch (fallbackError) {
        if (!isRateLimitError(fallbackError)) {
          log.warn("Failover model failed (non-rate-limit)", {
            provider: model.provider,
            error: String(fallbackError),
          });
        }
      }
    }

    return {
      response: "[All configured models are rate-limited or unavailable. Please try again later or add more providers in Settings → Models.]",
      toolsUsed: [],
      tokensUsed: 0,
      tokensIn: 0,
      tokensOut: 0,
      provider: resolvedOpts.provider,
      modelId: resolvedOpts.modelId,
      routeLabel,
    };
  } finally {
    await disposeToolRuntimeSession(toolRuntimeSessionId);
  }
}
