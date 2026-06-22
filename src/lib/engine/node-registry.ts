import type { NodeInput, NodeOutput, ExecutionContext } from "@/types/execution";
import { resolveTemplate, evaluateCondition, evaluateExpressionValue } from "./expressions";
import { logger } from "@/lib/utils/logger";
import { broadcastEvent } from "@/lib/ws/broadcast";
import { streamModel } from "@/lib/agents/multi-provider";
import { callWithTools } from "@/lib/agents/tool-caller";
import { estimateCost } from "@/lib/agents/cost-estimator";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { loadAllTools, type ToolExecutionPolicy } from "@/lib/engine/tools";
import { collectStartupContext, formatStartupContextForPrompt } from "@/lib/workspace/files";
import {
  getOrCreateChannelSessionStartupSnapshot,
  type ChannelSessionStartupSnapshotRecord,
} from "@/lib/channels/session-startup-snapshots";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { runHooks } from "@/lib/hooks";
import { getModelConfig } from "@/lib/agents/model-router";
import {
  getLatestSessionCompactionSummary,
  getRecentSessionCompactionSkills,
  persistSessionCompactionSkills,
} from "@/lib/agents/context/session-compaction";
import { getAgentById, getDefaultAgent, listAgents } from "@/lib/agents/registry";
import { getAgentBudgetDecision, recordAgentSpendEvent } from "@/lib/agents/budgets";
import { listAgentRoles } from "@/lib/agents/roles";
import { resolveActiveEnabledSkillEntries, resolveEnabledSkillContext } from "@/lib/extensions/registry";
import { getExtensionPromptContext } from "@/lib/extensions/runtime";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import { runCouncilSession } from "@/lib/council/service";
import { listWorkflowTemplateCatalog, resolveWorkflowTemplateReference } from "@/lib/workflows/template-catalog";
import { resolveSecretValue } from "@/lib/secrets/store";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const log = logger.child("engine");
const execFileAsync = promisify(execFile);

/** Run a command with stdin closed — prevents hanging when the parent process has no TTY (e.g. Next.js server). */
function spawnAsync(
  bin: string, args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d; });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", stdout, stderr }));
        }, opts.timeout)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error(`Command failed: ${bin}`), { code, stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
const HEARTBEAT_STARTUP_FILES = ["AGENTS.md", "IDENTITY.md", "HEARTBEAT.md", "BOOTSTRAP.md"];

export interface NodeHandler {
  type: string;
  execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function bytesToHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function statNumber(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

function parseDelimitedValues(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];
  return raw
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function parseDateInput(raw: string): Date | null {
  const value = String(raw || "").trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const asMillis = value.length <= 10 ? numeric * 1000 : numeric;
    const fromNumeric = new Date(asMillis);
    return Number.isNaN(fromNumeric.getTime()) ? null : fromNumeric;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function joinUniquePromptSections(sections: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const section of sections) {
    const normalized = String(section || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered.join("\n\n");
}

function buildSessionCompactionContext(sessionIdRaw: unknown, agentId: string): string {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return "";
  const latestSummary = getLatestSessionCompactionSummary(sessionId, agentId);
  const recentSkills = getRecentSessionCompactionSkills(sessionId, agentId);
  if (!latestSummary && recentSkills.length === 0) return "";
  const sections = [
    "Session compaction handoff",
    "Use this persisted summary to preserve continuity from earlier compacted turns.",
  ];
  if (latestSummary) {
    sections.push(latestSummary);
  }
  if (recentSkills.length > 0) {
    sections.push(
      `Recently active skill packs during compacted turns:
${recentSkills
        .map((skill) => `- ${skill.label} (${skill.id})`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function shiftDate(base: Date, amount: number, unit: string): Date {
  const next = new Date(base);
  switch (unit) {
    case "minutes":
      next.setMinutes(next.getMinutes() + amount);
      break;
    case "hours":
      next.setHours(next.getHours() + amount);
      break;
    case "weeks":
      next.setDate(next.getDate() + amount * 7);
      break;
    case "months":
      next.setMonth(next.getMonth() + amount);
      break;
    case "days":
    default:
      next.setDate(next.getDate() + amount);
      break;
  }
  return next;
}

function formatDateWithStyle(params: {
  date: Date;
  timezone: string;
  locale: string;
  outputStyle: string;
}): string {
  if (params.outputStyle === "iso") {
    return params.date.toISOString();
  }

  const options: Intl.DateTimeFormatOptions =
    params.outputStyle === "date"
      ? { timeZone: params.timezone, year: "numeric", month: "short", day: "2-digit" }
      : params.outputStyle === "time"
        ? { timeZone: params.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : {
            timeZone: params.timezone,
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          };

  return new Intl.DateTimeFormat(params.locale || "en-US", options).format(params.date);
}

function summarizeChannelStatuses(statuses: Record<string, Record<string, unknown>>): string {
  const lines = ["Channel Runtime Status"];
  for (const [channel, details] of Object.entries(statuses)) {
    const connected = Boolean(details.connected ?? details.configured ?? false);
    const summaryBits: string[] = [];
    for (const [key, value] of Object.entries(details)) {
      if (key === "connected" || key === "configured") continue;
      const text = String(value || "").trim();
      if (!text) continue;
      summaryBits.push(`${key}=${text}`);
    }
    lines.push(
      `- ${channel}: ${connected ? "ready" : "inactive"}${summaryBits.length > 0 ? ` (${summaryBits.join(", ")})` : ""}`,
    );
  }
  return lines.join("\n");
}

function summarizeCouncilResult(result: Record<string, unknown>): string {
  const topic = String(result.topic || "").trim();
  const winner = String(result.winner || "").trim() || "No verdict";
  const participants = Number(result.participants || 0);
  const simulatedCount = Number(result.simulatedCount || 0);
  const tally = Array.isArray(result.tally)
    ? (result.tally as Array<Record<string, unknown>>)
        .map((entry) => `- ${String(entry.option || "")}: ${Number(entry.votes || 0)}`)
        .join("\n")
    : "";
  const blocked = Array.isArray(result.blockedAgents)
    ? (result.blockedAgents as Array<Record<string, unknown>>)
        .map((entry) => `- ${String(entry.agentName || entry.agentId || "agent")}: ${String(entry.reason || "")}`)
        .join("\n")
    : "";

  return [
    `Council Topic: ${topic || "Untitled"}`,
    `Verdict: ${winner}`,
    `Participants: ${participants}${simulatedCount > 0 ? ` (${simulatedCount} simulated)` : ""}`,
    tally ? `Tally:\n${tally}` : "",
    blocked ? `Blocked:\n${blocked}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseExecAllowlist(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lowered = trimmed.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    deduped.push(trimmed);
  }
  return deduped;
}

function resolveCredentialValue(raw: unknown): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("secret:")) {
    return resolveSecretValue(value.slice("secret:".length).trim().toUpperCase()) ?? "";
  }
  if (value.startsWith("secret://")) {
    return resolveSecretValue(value.slice("secret://".length).trim().toUpperCase()) ?? "";
  }
  return value;
}

function parseJsonConfig(raw: unknown, fallback: Record<string, unknown> | unknown[] = {}): Record<string, unknown> | unknown[] {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as Record<string, unknown> | unknown[];
  } catch {
    return fallback;
  }
}

function stringifyOutput(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * `[SILENT]` notification suppression for quiet automation runs.
 * When an upstream agent/node decides there is nothing worth reporting, it emits an
 * empty string or `[SILENT]` and the downstream send/notification node skips delivery
 * (returns `skipped: true`) instead of sending a noisy "nothing changed" message.
 */
function isSilentMessage(message: unknown): boolean {
  const text = String(message ?? "").trim();
  if (!text) return true;
  return /^\[silent\]$/i.test(text) || /^\[\s*silent\s*\]/i.test(text);
}

function resolveNodeMessage(data: Record<string, unknown>): string {
  const direct =
    (data.response as string) ||
    (data.message as string) ||
    (data.summary as string) ||
    "";
  if (direct) return direct;

  const result = data.result as Record<string, unknown> | undefined;
  if (result) {
    const nested =
      (result.response as string) ||
      (result.message as string) ||
      (result.summary as string) ||
      "";
    if (nested) return nested;
    return stringifyOutput(result);
  }

  if (typeof data.bodyText === "string" && data.bodyText) return data.bodyText;
  if (typeof data.toolResultText === "string" && data.toolResultText) return data.toolResultText;
  return stringifyOutput(data);
}

function formatIngressProvenanceContext(data: Record<string, unknown>): string {
  const meta =
    data.systemInputProvenance && typeof data.systemInputProvenance === "object"
      ? (data.systemInputProvenance as Record<string, unknown>)
      : null;
  const receipt = typeof data.provenanceReceipt === "string" ? data.provenanceReceipt.trim() : "";
  if (!meta && !receipt) return "";

  const lines: string[] = [];
  if (meta) {
    lines.push("Ingress provenance metadata:");
    for (const [key, value] of Object.entries(meta)) {
      const text = String(value || "").trim();
      if (!text) continue;
      lines.push(`- ${key}: ${text}`);
    }
  }
  if (receipt) {
    if (lines.length > 0) lines.push("");
    lines.push(receipt);
  }
  return lines.join("\n").trim();
}

function formatPendingFollowUpContext(data: Record<string, unknown>): string {
  const hiddenPayload = String(data.hiddenFollowUpPayload || "").trim();
  const message = String(data.hiddenFollowUpMessage || "").trim();
  if (!hiddenPayload && !message) return "";
  return [
    "Pending yielded follow-up from the previous turn:",
    message ? `- Prior yield message: ${message}` : "",
    hiddenPayload ? `- Hidden follow-up payload: ${hiddenPayload}` : "",
    "- Treat this as hidden continuity context for the current turn.",
  ]
    .filter(Boolean)
    .join("\n");
}

function clampMessageLength(message: string, maxLength = 12000): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}\n\n[truncated]`;
}

function buildAgentRoleContext(agentId: string): string {
  try {
    const roles = listAgentRoles();
    const self = roles.find((role) => role.agentId === agentId);
    if (!self) return "";
    const manager = self.reportsTo
      ? roles.find((role) => role.agentId === self.reportsTo)
      : null;
    const directReports = roles.filter((role) => role.reportsTo === agentId);

    const lines: string[] = [
      "Agent team profile:",
      `- Role type: ${self.roleType}`,
      `- Role title: ${self.roleTitle || "not set"}`,
    ];
    if (self.roleDescription) {
      lines.push(`- Role description: ${self.roleDescription}`);
    }
    if (self.capabilities.length > 0) {
      lines.push(`- Capabilities: ${self.capabilities.join(", ")}`);
    }
    if (manager) {
      lines.push(`- Reports to: ${manager.roleTitle || manager.agentId} (${manager.agentId})`);
    }
    if (directReports.length > 0) {
      lines.push(
        `- Direct reports: ${directReports
          .map((role) => `${role.agentId} (${role.roleTitle || role.roleType})`)
          .join(", ")}`,
      );
    }
    if (self.roleType === "orchestrator" && directReports.length > 0) {
      lines.push(
        "- Delegation guidance: break large tasks into clear subtasks and route them to appropriate specialist workflows when possible.",
      );
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function buildAgentSkillPackContext(
  agentId: string,
  overrides?: { enabledExtensions?: string[]; enabledSkills?: string[] },
): { prompt: string; activeSkills: Array<{ id: string; label: string }> } {
  try {
    const agent = getAgentById(agentId);
    if (!agent) return { prompt: "", activeSkills: [] };
    const enabledExtensions = overrides?.enabledExtensions?.length ? overrides.enabledExtensions : agent.enabledExtensions;
    const enabledSkills = overrides?.enabledSkills?.length ? overrides.enabledSkills : agent.enabledSkills;
    const skillContext = resolveEnabledSkillContext({
      enabledExtensions,
      enabledSkills,
      agentWorkspacePath: agent.workspacePath,
      maxChars: 5000,
    });
    const activeSkills = resolveActiveEnabledSkillEntries({
      enabledExtensions,
      enabledSkills,
      agentWorkspacePath: agent.workspacePath,
      maxChars: 5000,
    });
    if (!skillContext) return { prompt: "", activeSkills };
    return { prompt: `Installed skill packs:
${skillContext}`, activeSkills };
  } catch {
    return { prompt: "", activeSkills: [] };
  }
}

function resolveAgentForNode(requestedAgentIdRaw: unknown) {
  const requestedAgentId = String(requestedAgentIdRaw || "").trim();
  let agent = requestedAgentId ? getAgentById(requestedAgentId) : null;
  const defaultAgent = getDefaultAgent();
  if (!agent) {
    agent = defaultAgent;
  }
  if (!agent.isActive) {
    agent = defaultAgent;
  }
  return agent;
}

function resolveStartupContext(params: {
  sessionId?: string;
  agentId: string;
  agentWorkspacePath?: string | null;
  includeHeartbeat: boolean;
}): { prompt: string; snapshot: ChannelSessionStartupSnapshotRecord | null } {
  if (params.includeHeartbeat) {
    return {
      prompt: formatStartupContextForPrompt(
        collectStartupContext({
          includeHeartbeat: true,
          workspacePath: params.agentWorkspacePath || undefined,
          includeFiles: HEARTBEAT_STARTUP_FILES,
        }),
        5000,
      ),
      snapshot: null,
    };
  }

  if (!params.sessionId) {
    return {
      prompt: formatStartupContextForPrompt(
        collectStartupContext({
          workspacePath: params.agentWorkspacePath || undefined,
        }),
        12000,
      ),
      snapshot: null,
    };
  }

  const snapshot = getOrCreateChannelSessionStartupSnapshot({
    sessionId: params.sessionId,
    agentId: params.agentId,
    workspacePath: params.agentWorkspacePath || undefined,
    maxChars: 12000,
  });

  return {
    prompt: snapshot?.startupContext || "",
    snapshot,
  };
}

async function runConfiguredAgent(params: {
  config: Record<string, unknown>;
  inputData: Record<string, unknown>;
  context: ExecutionContext;
  nodeId: string;
  streamTokens?: boolean;
}): Promise<NodeOutput> {
  const agent = resolveAgentForNode(params.config.agentId);
  const sessionId = String(params.inputData.sessionId || "").trim() || undefined;
  const model = getModelConfig({ agentId: agent.id, sessionId });
  const baseSystemPrompt = resolveTemplate(
    (params.config.systemPrompt as string) || model.agentSystemPrompt || "You are a helpful AI assistant.",
    params.context
  );
  const includeHeartbeat = Boolean(params.inputData.schedule);
  const startupContext = resolveStartupContext({
    sessionId,
    agentId: agent.id,
    agentWorkspacePath: agent.workspacePath,
    includeHeartbeat,
  }).prompt;
  const roleContext = buildAgentRoleContext(agent.id);
  const scheduleSkillOverrides = readStringArray(params.context.get("scheduleProfile.skillOverrides"));
  const scheduleExtensionOverrides = readStringArray(params.context.get("scheduleProfile.extensionOverrides"));
  const skillPackState = buildAgentSkillPackContext(agent.id, {
    enabledSkills: scheduleSkillOverrides,
    enabledExtensions: scheduleExtensionOverrides,
  });
  const skillPackContext = skillPackState.prompt;
  if (sessionId && skillPackState.activeSkills.length > 0) {
    persistSessionCompactionSkills({
      sessionId,
      agentId: agent.id,
      skills: skillPackState.activeSkills,
    });
  }
  const sessionCompactionContext = buildSessionCompactionContext(sessionId, agent.id);
  const extensionPromptContext = await getExtensionPromptContext({
    agentId: agent.id,
    enabledExtensions: scheduleExtensionOverrides.length ? scheduleExtensionOverrides : agent.enabledExtensions,
    enabledSkills: scheduleSkillOverrides.length ? scheduleSkillOverrides : agent.enabledSkills,
  });
  const ingressProvenanceContext = formatIngressProvenanceContext(params.inputData);
  const pendingFollowUpContext = formatPendingFollowUpContext(params.inputData);
  const systemPrefix = joinUniquePromptSections([
    startupContext,
    ingressProvenanceContext,
    pendingFollowUpContext,
    roleContext,
    extensionPromptContext,
    skillPackContext,
    sessionCompactionContext,
  ]);
  const systemPrompt = systemPrefix ? `${systemPrefix}\n\n${baseSystemPrompt}` : baseSystemPrompt;
  const parallelSummary = String(params.inputData.parallelSummary || "").trim();
  const originalMessage = String(params.inputData.message || "").trim();
  const defaultUserMessage = parallelSummary
    ? [
        "Worker summary:",
        parallelSummary,
        originalMessage ? `Original request:\n${originalMessage}` : "",
      ].filter(Boolean).join("\n\n")
    : (
        (params.inputData.message as string) ||
        (params.inputData.response as string) ||
        (params.inputData.triggeredAt as string ? `Manual trigger at ${params.inputData.triggeredAt}` : "Hello")
      );
  const userMessage = resolveTemplate(
    (params.config.message as string) || defaultUserMessage,
    params.context
  );
  const maxTokens = (params.config.maxTokens as number) ?? model.maxTokens ?? 1024;
  const budgetDecision = getAgentBudgetDecision(agent);

  if (!model.apiKey && providerRequiresApiKey(model.provider)) {
    return {
      data: {
        response: `[No API key configured for ${model.provider}. Add your key in Settings or via: dpc models add ${model.provider} <your-key>]`,
        error: `No API key configured for ${model.provider}`,
        tokensUsed: 0,
        agentId: agent.id,
        agentName: agent.name,
        model: "none",
      },
    };
  }

  if (!budgetDecision.allowed) {
    return {
      data: {
        response: budgetDecision.message || "Agent budget blocked this run.",
        error: budgetDecision.message || "Agent budget blocked this run.",
        tokensUsed: 0,
        agentId: agent.id,
        agentName: agent.name,
        model: model.modelId,
        budgetSummary: budgetDecision.summary,
      },
    };
  }

  const enabledToolNames = (params.config.enabledTools as string[]) ?? [];
  const disabledTools = new Set(agent.disabledTools);
  const effectiveToolNames = enabledToolNames.filter((name) => !disabledTools.has(name));
  const maxToolCalls = (params.config.maxToolCalls as number) ?? 25;
  const approvalMode =
    (params.config.approvalMode as "off" | "model" | "human" | undefined) ??
    (((params.config.confirmDangerous as boolean) ?? false) ? "model" : "off");
  const toolPolicy: ToolExecutionPolicy = {
    approvalMode,
    execSecurity: (params.config.execSecurity as "deny" | "allowlist" | "full" | undefined) ?? "full",
    execAsk: (params.config.execAsk as "off" | "on-miss" | "always" | undefined) ?? "on-miss",
    execAllowlist: parseExecAllowlist(params.config.execAllowlist),
  };
  const tools = await loadAllTools(effectiveToolNames, {
    toolPolicy,
    enabledToolsets: agent.enabledToolsets,
  });

  try {
    let responseText: string;
    let tokensUsed: number;
    let tokensIn = 0;
    let tokensOut = 0;
    let yielded = false;
    let usedProvider: string = model.provider;
    let usedModelId = model.modelId;
    let routeLabel: string | null = null;

    // Emit a coarse "calling LLM" status so the user sees movement during the
    // silent period between workflow:node:start and the first streamed token.
    // DeepSeek/Anthropic TTFT is typically 1-5s; this fills that gap.
    if (params.streamTokens !== false) {
      const modelLabel = `${model.provider}:${model.modelId}`;
      params.context.emit("stream:status", {
        nodeId: params.nodeId,
        phase: "model_call",
        label: tools.length > 0 ? `Calling ${modelLabel} (with tools)…` : `Calling ${modelLabel}…`,
      });
    }

    if (tools.length > 0) {
      const result = await callWithTools({
        provider: model.provider,
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        fastMode: model.fastMode,
        enableSmartRouting: true,
        temperature: (params.config.temperature as number | undefined) ?? model.temperature,
        systemPrompt,
        userMessage,
        maxTokens,
        tools,
        maxToolCalls,
        toolPolicy,
        modelLedLane: (params.config.modelLedLane as never) || undefined,
        accuracyMode: (params.config.accuracyMode as never) || undefined,
        maxExpandedToolBudget: params.config.maxExpandedToolBudget as number | undefined,
        turnDeadlineMs: params.config.turnDeadlineMs as number | undefined,
        agentId: agent.id,
        channelSessionId: sessionId,
        toolMode:
          params.inputData.toolMode === "restricted"
            ? "restricted"
            : params.inputData.toolMode === "full"
              ? "full"
              : "default",
        readOnly: Boolean(params.inputData.readOnly),
        onToolCall: (name, args) => {
          const preview = Object.entries(args)
            .slice(0, 2)
            .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
            .join(", ");
          recordTelemetryEvent("tool.call", {
            workflowId: params.context.workflowId,
            executionId: params.context.executionId,
            nodeId: params.nodeId,
            tool: name,
            preview,
          });
          void runHooks("tool.call", {
            workflowId: params.context.workflowId,
            executionId: params.context.executionId,
            nodeId: params.nodeId,
            tool: name,
            args,
          });
          broadcastEvent("webchat:tool", {
            clientTurnId: params.context.get("channel.clientTurnId") as string | null | undefined,
            sessionId,
            phase: "start",
            name,
            args,
          });
        },
        onToolResult: (name, success, output) => {
          broadcastEvent("webchat:tool", {
            clientTurnId: params.context.get("channel.clientTurnId") as string | null | undefined,
            sessionId,
            phase: success ? "done" : "error",
            name,
            resultPreview: output.slice(0, 200),
          });
        },
        onToken: (token: string) => {
          // Stream final-round assistant text deltas to the WebChat UI.
          if (params.streamTokens !== false) {
            params.context.emit("stream:token", { token, nodeId: params.nodeId });
          }
        },
      });
      responseText = result.response;
      tokensUsed = result.tokensUsed;
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;
      yielded = result.yielded === true;
      usedProvider = result.provider ?? usedProvider;
      usedModelId = result.modelId ?? usedModelId;
      routeLabel = result.routeLabel ?? routeLabel;
    } else {
      const result = await streamModel(
        {
          provider: model.provider,
          modelId: model.modelId,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          fastMode: model.fastMode,
          enableSmartRouting: true,
          temperature: (params.config.temperature as number | undefined) ?? model.temperature,
          systemPrompt,
          userMessage,
          maxTokens,
        },
        (token: string) => {
          if (params.streamTokens !== false) {
            params.context.emit("stream:token", { token, nodeId: params.nodeId });
          }
        }
      );
      responseText = result.response;
      tokensUsed = result.tokensUsed;
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;
      usedProvider = result.provider ?? usedProvider;
      usedModelId = result.modelId ?? usedModelId;
      routeLabel = result.routeLabel ?? routeLabel;
    }

    const response = responseText.replace(/<internal>[\s\S]*?<\/internal>/gi, "").trim();
    const costUsd = estimateCost(usedModelId, tokensIn, tokensOut);
    // Resolve goal_id from workflow record for cost attribution
    let workflowGoalId: string | null = null;
    try {
      const db = (await import("@/lib/db")).getSqlite();
      const wfRow = db.prepare("SELECT goal_id FROM workflows WHERE id = ?").get(params.context.workflowId) as { goal_id: string | null } | undefined;
      workflowGoalId = wfRow?.goal_id ?? null;
    } catch { /* non-fatal */ }
    const monthlyBudgetResult = recordAgentSpendEvent({
      agentId: agent.id,
      provider: usedProvider,
      modelId: usedModelId,
      source: "workflow-node",
      referenceId: `${params.context.executionId}:${params.nodeId}`,
      tokensUsed,
      costUsd,
      goalId: workflowGoalId,
      metadata: {
        workflowId: params.context.workflowId,
        executionId: params.context.executionId,
        nodeId: params.nodeId,
      },
    });
    const postSpendBudget = getAgentBudgetDecision(agent);

    let budgetMessage: string | undefined;
    if (monthlyBudgetResult?.budgetExceeded && monthlyBudgetResult.message) {
      budgetMessage = monthlyBudgetResult.message;
    } else if (
      postSpendBudget.message &&
      postSpendBudget.summary.budgetAction === "warn"
    ) {
      budgetMessage = postSpendBudget.message;
    } else if (monthlyBudgetResult?.budgetWarning && monthlyBudgetResult.message) {
      budgetMessage = monthlyBudgetResult.message;
    }

    return {
      data: {
        response,
        tokensUsed,
        tokensIn,
        tokensOut,
        costUsd,
        yielded,
        agentId: agent.id,
        agentName: agent.name,
        model: usedModelId,
        provider: usedProvider,
        routeLabel: routeLabel ?? undefined,
        toolsUsed: effectiveToolNames.length > 0 ? effectiveToolNames : undefined,
        toolsetsUsed: agent.enabledToolsets.length > 0 ? agent.enabledToolsets : undefined,
        disabledToolsApplied:
          enabledToolNames.length > effectiveToolNames.length
            ? enabledToolNames.filter((name) => disabledTools.has(name))
            : undefined,
        budgetSummary: postSpendBudget.summary,
        budgetWarning: budgetMessage,
      },
    };
  } catch (error) {
    log.error("Agent error", { provider: model.provider, error: String(error) });
    return {
      data: {
        response: `Error calling ${model.provider}: ${String(error)}`,
        error: String(error),
        tokensUsed: 0,
        model: model.modelId,
      },
    };
  }
}

// Manual Trigger
const manualTriggerHandler: NodeHandler = {
  type: "manual-trigger",
  async execute(input) {
    return {
      data: {
        triggeredAt: new Date().toISOString(),
        inputData: input.data,
      },
    };
  },
};

// Message Trigger
const messageTriggerHandler: NodeHandler = {
  type: "message-trigger",
  async execute(input) {
    return {
      data: {
        ...input.data,
        message: (input.data.message as string) || "",
        sender: (input.data.sender as string) || "user",
        channel: (input.config.channel as string) || "webchat",
        sessionId: (input.data.sessionId as string) || "",
        timestamp: new Date().toISOString(),
      },
    };
  },
};

// Webhook Trigger
const webhookTriggerHandler: NodeHandler = {
  type: "webhook-trigger",
  async execute(input) {
    return {
      data: {
        headers: input.data.headers || {},
        body: input.data.body || {},
        query: input.data.query || {},
      },
    };
  },
};

// Claude Agent (works with any provider via multi-provider router)
// When enabledTools is set, runs a full tool-use loop — the LLM decides which
// tools to call and how many times. Otherwise falls back to a single stream call.
const claudeAgentHandler: NodeHandler = {
  type: "claude-agent",
  async execute(input, context) {
    const nodeId = input.node?.id ?? "unknown";
    return runConfiguredAgent({
      config: input.config,
      inputData: input.data,
      context,
      nodeId,
      streamTokens: true,
    });
  },
};

const integrationAgentHandler: NodeHandler = {
  type: "integration-agent",
  async execute(input, context) {
    const serviceName = String(input.config.serviceName || "Custom API").trim() || "Custom API";
    const baseUrl = resolveTemplate(String(input.config.baseUrl || ""), context).trim();
    const authHeaderName = String(input.config.authHeaderName || "Authorization").trim() || "Authorization";
    const authScheme = String(input.config.authScheme || "Bearer").trim();
    const rawToken = resolveCredentialValue(input.config.authToken);
    const authHeaderValue =
      rawToken && authScheme !== "None"
        ? authScheme === "Bearer" || authScheme === "Basic" || authScheme === "Token"
          ? `${authScheme} ${rawToken}`
          : rawToken
        : rawToken;
    const objective = resolveTemplate(
      String(input.config.objective || input.data.message || "Inspect the service and complete the requested integration task."),
      context,
    );

    const systemPrompt = [
      `You are an integration agent for ${serviceName}.`,
      "You are executing inside a workflow node. Use tools to interact with the service and then continue the workflow with a concise, factual result.",
      "Prefer direct API calls with the http_request tool.",
      baseUrl ? `Base URL: ${baseUrl}` : "",
      rawToken
        ? `Authentication: include header ${authHeaderName}: ${authHeaderValue}`
        : "Authentication: no preset token was provided. If the API needs auth, explain the missing credential clearly.",
      "When you finish, summarize what you did, what data was returned, and any IDs or next-step values the next node may need.",
    ].filter(Boolean).join("\n");

    return runConfiguredAgent({
      config: {
        ...input.config,
        systemPrompt,
        enabledTools: ["http_request"],
        maxToolCalls: (input.config.maxToolCalls as number | undefined) ?? 10,
      },
      inputData: {
        ...input.data,
        message: objective,
        integration: {
          serviceName,
          baseUrl,
          authHeaderName,
          authHeaderValue,
        },
      },
      context,
      nodeId: input.node?.id ?? "integration-agent",
      streamTokens: true,
    });
  },
};

type ParallelWorkerConfig = {
  roleKey?: string;
  label?: string;
  taskTemplate?: string;
  systemPrompt?: string;
  agentId?: string;
  temperature?: number;
  maxTokens?: number;
  enabledTools?: string[];
  maxToolCalls?: number;
  approvalMode?: "off" | "model" | "human";
};

type ParallelWorkerReport = {
  roleKey: string;
  label: string;
  response: string;
  error: string | null;
  status?: string;
  tokensUsed: number;
  agentId: string;
  agentName: string;
  attempt?: number;
};

export function verifyParallelWorkerReports(reports: ParallelWorkerReport[]) {
  const issues: string[] = [];
  const reviewedReports = reports.map((report) => {
    const reportIssues: string[] = [];
    const normalized = report.response.trim();
    if (report.error) reportIssues.push(`worker error: ${report.error}`);
    if (!normalized) reportIssues.push("missing response");
    if (normalized.length > 0 && normalized.length < 80) reportIssues.push("response is too short to verify");
    if (/\b(?:i don't know|cannot determine|unable to verify|not enough information|failed|error)\b/i.test(normalized)) {
      reportIssues.push("worker reported uncertainty or failure");
    }
    if (reportIssues.length > 0) {
      issues.push(`${report.label}: ${reportIssues.join("; ")}`);
    }
    return {
      roleKey: report.roleKey,
      label: report.label,
      ok: reportIssues.length === 0,
      issues: reportIssues,
      evidenceChars: normalized.length,
    };
  });

  const nonEmptyResponses = reports.map((report) => report.response.trim()).filter(Boolean);
  if (nonEmptyResponses.length >= 2) {
    const rejectCount = nonEmptyResponses.filter((response) => /\b(?:reject|do not proceed|block|not ready)\b/i.test(response)).length;
    const approveCount = nonEmptyResponses.filter((response) => /\b(?:approve|proceed|ready|go ahead)\b/i.test(response)).length;
    if (rejectCount > 0 && approveCount > 0) {
      issues.push("worker reports appear to disagree on proceed/reject readiness");
    }
  }

  return {
    ok: issues.length === 0,
    checkedReports: reports.length,
    issues,
    reviewedReports,
    summary: issues.length === 0
      ? `Verified ${reports.length} worker report(s): no missing, failed, or low-signal outputs detected.`
      : `Verification flagged ${issues.length} issue(s): ${issues.slice(0, 5).join(" | ")}`,
  };
}

const parallelAgentsHandler: NodeHandler = {
  type: "parallel-agents",
  async execute(input, context) {
    const workersRaw = Array.isArray(input.config.workers)
      ? (input.config.workers as ParallelWorkerConfig[])
      : [];
    const workers = workersRaw.filter((worker) => Boolean(worker?.roleKey));
    if (workers.length === 0) {
      return {
        data: {
          ...input.data,
          workerReports: [],
          reportsByRole: {},
          parallelSummary: "No workers configured",
          allSucceeded: false,
        },
      };
    }

    const maxParallel = clamp((input.config.maxParallel as number) || workers.length, 1, workers.length);
    const sharedTask = resolveTemplate(
      (input.config.taskTemplate as string) ||
        (input.data.message as string) ||
        (input.data.response as string) ||
        "Analyze the request and return findings.",
      context
    );
    const nodeId = input.node?.id ?? "parallel-agents";

    const WORKER_TIMEOUT_MS = 120_000;
    const WORKER_MAX_RETRIES = 1;

    const runWorker = async (worker: ParallelWorkerConfig, index: number): Promise<ParallelWorkerReport> => {
      const roleKey = String(worker.roleKey || `worker${index + 1}`);
      const label = worker.label?.trim() || roleKey;
      const workerTask = resolveTemplate(worker.taskTemplate || sharedTask, context);
      const inheritedSessionId =
        String(input.data.sessionId || "").trim() ||
        String((context.get("trigger.sessionId") as string | undefined) || "").trim();
      const workerPrompt =
        worker.systemPrompt ||
        "You are a specialized worker. Complete the given task and return a concise report.";
      const workerConfig: Record<string, unknown> = {
        agentId: worker.agentId || "",
        systemPrompt: workerPrompt,
        temperature: worker.temperature ?? 0.4,
        maxTokens: worker.maxTokens ?? 900,
        enabledTools: worker.enabledTools ?? [],
        maxToolCalls: worker.maxToolCalls ?? 25,
        approvalMode: worker.approvalMode ?? "off",
      };

      for (let attempt = 1; attempt <= WORKER_MAX_RETRIES + 1; attempt++) {
        try {
          const workerPromise = runConfiguredAgent({
            config: workerConfig,
            inputData: {
              ...input.data,
              ...(inheritedSessionId ? { sessionId: inheritedSessionId } : {}),
              message: workerTask,
            },
            context,
            nodeId: `${nodeId}:${roleKey}`,
            streamTokens: true,
          });

          const result = await Promise.race([
            workerPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Worker ${label} timed out after ${WORKER_TIMEOUT_MS}ms`)), WORKER_TIMEOUT_MS)
            ),
          ]);

          const output = (result as { data?: Record<string, unknown> }).data || {};
          const response = String(output.response || "");

          if (response.trim()) {
            return {
              roleKey,
              label,
              response,
              error: null,
              status: "completed",
              tokensUsed: Number(output.tokensUsed || 0),
              agentId: String(output.agentId || worker.agentId || ""),
              agentName: String((output as Record<string, unknown>).agentName || ""),
              attempt,
            };
          }

          if (attempt <= WORKER_MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }

          return {
            roleKey, label,
            response: "",
            error: "worker returned empty response after retries",
            status: "failed",
            tokensUsed: 0,
            agentId: String(worker.agentId || ""),
            agentName: "",
            attempt,
          };
        } catch (err) {
          const errorMsg = String(err);
          const isTimeout = errorMsg.includes("timed out");

          if (attempt <= WORKER_MAX_RETRIES && !isTimeout) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }

          return {
            roleKey, label,
            response: "",
            error: errorMsg,
            status: isTimeout ? "timeout" : "failed",
            tokensUsed: 0,
            agentId: String(worker.agentId || ""),
            agentName: "",
            attempt,
          };
        }
      }

      return {
        roleKey, label,
        response: "",
        error: "unknown error",
        status: "failed",
        tokensUsed: 0,
        agentId: "",
        agentName: "",
        attempt: WORKER_MAX_RETRIES + 1,
      };
    };

    const queue = workers.map((worker, index) => ({ worker, index }));
    const reports: ParallelWorkerReport[] = [];
    const running = new Set<Promise<void>>();
    const heartbeats = new Map<number, number>(); // worker index → last heartbeat timestamp
    const aborted = new Set<number>();

    // Add heartbeat tracking to each runWorker call
    const runWorkerWithHeartbeat = async (worker: ParallelWorkerConfig, index: number) => {
      // Start heartbeat
      heartbeats.set(index, Date.now());
      
      // Background heartbeat updater (runs every 3s during the worker's lifetime)
      const heartbeatInterval = setInterval(() => {
        heartbeats.set(index, Date.now());
      }, 3000);

      try {
        const result = await runWorker(worker, index);
        heartbeats.delete(index);
        clearInterval(heartbeatInterval);
        return result;
      } catch (err) {
        heartbeats.delete(index);
        clearInterval(heartbeatInterval);
        throw err;
      }
    };

    const launchNext = () => {
      if (queue.length === 0) return;
      const next = queue.shift();
      if (!next) return;
      const task = runWorkerWithHeartbeat(next.worker, next.index)
        .then((report) => {
          reports.push(report);
        })
        .finally(() => {
          running.delete(task);
        });
      running.add(task);
    };

    while (running.size < maxParallel && queue.length > 0) {
      launchNext();
    }

    // Stale detection: check heartbeats every 1s, abort workers stalled >10s
    const HEARTBEAT_STALE_MS = 10_000;
    const staleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [index, lastBeat] of heartbeats.entries()) {
        if (aborted.has(index)) continue;
        if (now - lastBeat > HEARTBEAT_STALE_MS) {
          aborted.add(index);
          logger.warn("[parallel-agents] Worker stalled — marking as failed", {
            workerIndex: index,
            label: workers[index]?.label || `worker ${index}`,
            lastHeartbeat: lastBeat,
          });
          // Add a synthetic failed report so the worker is accounted for
          reports.push({
            roleKey: String(workers[index]?.roleKey || `worker${index + 1}`),
            label: workers[index]?.label || `Worker ${index + 1}`,
            response: "",
            error: "worker stalled — no heartbeat received for 10s",
            status: "failed",
            tokensUsed: 0,
            agentId: "",
            agentName: "",
            attempt: 1,
          });
        }
      }
    }, 1000);

    while (running.size > 0) {
      await Promise.race([...running]);
      while (running.size < maxParallel && queue.length > 0) {
        launchNext();
      }
    }

    clearInterval(staleCheckInterval);

    reports.sort((a, b) => {
      const ia = workers.findIndex((worker) => String(worker.roleKey || "") === a.roleKey);
      const ib = workers.findIndex((worker) => String(worker.roleKey || "") === b.roleKey);
      return ia - ib;
    });

    for (const report of reports) {
      if (report.status === "failed" || report.status === "timeout") {
        if (!report.response) {
          report.response = `[${report.status}] ${report.error || "worker did not complete"}`;
        }
      }
    }

    const failedReports = reports.filter(r => r.status !== "completed");
    let allSucceeded = failedReports.length === 0;

    const reportsByRole: Record<string, string> = {};
    let totalTokens = 0;
    for (const report of reports) {
      reportsByRole[report.roleKey] = report.response;
      totalTokens += report.tokensUsed;
    }

    const parallelSummary = reports
      .map((report) => `### ${report.label}\n${report.response || "(no output)"}`)
      .join("\n\n");
    const verification = verifyParallelWorkerReports(reports);

    return {
      data: {
        ...input.data,
        workerReports: reports,
        reportsByRole,
        parallelSummary,
        parallelVerification: verification,
        workerVerification: verification,
        verificationSummary: verification.summary,
        totalWorkerTokens: totalTokens,
        allSucceeded: allSucceeded && verification.ok,
        ...Object.fromEntries(
          reports.map((report) => [`${report.roleKey}Report`, report.response]),
        ),
      },
    };
  },
};

// Send WebChat
const sendWebchatHandler: NodeHandler = {
  type: "send-webchat",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message = clampMessageLength(configuredMessage || resolveNodeMessage(input.data));
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const { presentChannelResponse } = await import("@/lib/channels/presentation");
    const content = presentChannelResponse("webchat", message);

    context.emit("webchat:message", {
      content,
      executionId: context.executionId,
    });

    return {
      data: {
        messageId: `msg_${Date.now()}`,
        content,
      },
    };
  },
};

function parseJsonLike(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseHeaderObject(value: unknown): Record<string, string> {
  const parsed = parseJsonLike(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
    const name = String(key || "").trim();
    if (!name) continue;
    headers[name] = typeof headerValue === "string" ? headerValue : JSON.stringify(headerValue);
  }
  return headers;
}

// Webhook Response
const webhookResponseHandler: NodeHandler = {
  type: "webhook-response",
  async execute(input, context) {
    const statusCode = clamp(Number(input.config.statusCode ?? 200), 100, 599);
    const rawBody = typeof input.config.body === "string"
      ? resolveTemplate(input.config.body, context)
      : input.config.body ?? { success: true, data: input.data };
    const rawHeaders = typeof input.config.headers === "string"
      ? resolveTemplate(input.config.headers, context)
      : input.config.headers;
    const body = parseJsonLike(rawBody) ?? { success: true };
    const headers = parseHeaderObject(rawHeaders);

    return {
      data: {
        ...input.data,
        webhookResponse: {
          statusCode,
          headers,
          body,
        },
      },
    };
  },
};

// Send WhatsApp
const sendWhatsappHandler: NodeHandler = {
  type: "send-whatsapp",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const to = (input.config.to as string) || (input.data.sender as string) || "";

    log.info("WhatsApp send", { to, messageLength: message.length });

    if (!to) {
      return { data: { sent: false, error: "No recipient" } };
    }

    try {
      const { sendWhatsAppMessage } = await import("@/lib/channels/whatsapp");
      const result = await sendWhatsAppMessage(to, message);
      return {
        data: {
          messageId: result.messageId || `wa_${Date.now()}`,
          status: result.status,
          to,
          content: message,
        },
      };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

// If/Else
const ifElseHandler: NodeHandler = {
  type: "if-else",
  async execute(input, context) {
    const rawCondition = (input.config.condition as string) || "true";
    // Resolve {{…}} templates in the condition — exactly as switch,
    // set-variables, http-request, and send-* nodes already do.
    // Without this, `{{run.result}} > 10` silently evaluates to false.
    const condition = resolveTemplate(rawCondition, context);

    const variables: Record<string, unknown> = { ...input.data };

    const result = evaluateCondition(condition, variables);
    const merged: Record<string, unknown> = {
      ...input.data,
      conditionResult: result,
      branch: result ? "true" : "false",
    };
    // Backwards compatibility for workflows that read `result` from if-else output.
    if (typeof merged.result === "undefined") {
      merged.result = result;
    }

    return {
      data: merged,
    };
  },
};

// Memory Recall
const memoryRecallHandler: NodeHandler = {
  type: "memory-recall",
  async execute(input, context) {
    const query = resolveTemplate(
      (input.config.query as string) || "{{trigger.message}}",
      context
    );
    const limit = (input.config.limit as number) || 5;
    const mode = String((input.config.mode as string) || "search").toLowerCase() === "gpt"
      ? "gpt"
      : "search";

    try {
      const res = await fetch(
        `http://localhost:${process.env.PORT || 3100}/api/memory?action=search&mode=${mode}&query=${encodeURIComponent(query)}&limit=${limit}`
      );
      const data = await res.json();
      if (data.success) {
        return {
          data: {
            ...input.data,
            memories: data.data,
            count: data.data.length,
            mode,
            memoriesText: data.data
              .map((m: { content: string }) => m.content)
              .join("\n"),
          },
        };
      }
    } catch {
      // Fall through
    }

    return { data: { ...input.data, memories: [], count: 0, memoriesText: "" } };
  },
};

// Memory Store
const memoryStoreHandler: NodeHandler = {
  type: "memory-store",
  async execute(input, context) {
    const mode = (input.config.extractMode as string) || "auto";
    const configuredContent = resolveTemplate(
      String(input.config.manualContent ?? input.config.content ?? ""),
      context,
    );
    const content =
      configuredContent
        ? configuredContent
        : mode === "manual"
          ? ""
        : (input.data.response as string) ||
          (input.data.message as string) ||
          "";

    if (!content) {
      return { data: { ...input.data, stored: [], count: 0 } };
    }

    try {
      const payload: Record<string, unknown> = {
        content,
        type: (input.config.type as string) || "fact",
      };
      if (mode !== "manual") {
        payload.extractMode = "auto";
        payload.messages = [{ role: "user", content }];
      } else {
        payload.extractMode = "manual";
      }

      const res = await fetch(
        `http://localhost:${process.env.PORT || 3100}/api/memory`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (data.success) {
        if (Array.isArray(data.data?.entries)) {
          return {
            data: { ...input.data, stored: data.data.entries, count: data.data.entries.length },
          };
        }
        return {
          data: { ...input.data, stored: [data.data], count: 1 },
        };
      }
    } catch {
      // Fall through
    }

    return { data: { ...input.data, stored: [], count: 0 } };
  },
};

// System Command Tool
const systemCommandHandler: NodeHandler = {
  type: "system-command",
  async execute(input, context) {
    // The node contract exposes the action selector under `command` (values
    // "pc-specs" / "list-files" / "move-files"), while older templates set `action` directly and
    // free-form shell usage sets `command` to a real command string. Reconcile all
    // three so a contract-aligned `command: "list-files"` actually runs the
    // list-files branch instead of being treated as a shell command.
    const BUILTIN_ACTIONS = new Set(["pc-specs", "list-files", "move-files"]);
    let action = (input.config.action as string) || "";
    let command = resolveTemplate((input.config.command as string) || "", context);
    if (BUILTIN_ACTIONS.has(command.trim())) {
      if (!action) action = command.trim();
      command = "";
    }
    if (!action) action = "pc-specs";

    if (action === "command" || command) {
      if (!command.trim()) {
        return {
          data: {
            ...input.data,
            stdout: "",
            stderr: "",
            exitCode: null,
            error: "No command provided",
          },
        };
      }

      const timeoutMs = clamp((input.config.timeoutMs as number) || 15000, 1000, 120000);

      try {
        const result =
          process.platform === "win32"
            ? await execFileAsync(
                process.env.ComSpec || "cmd.exe",
                ["/d", "/s", "/c", command],
                { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
              )
            : await execFileAsync(
                "sh",
                ["-lc", command],
                { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
              );

        return {
          data: {
            ...input.data,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            exitCode: 0,
            command,
            toolAction: "command",
            toolResultText: result.stdout.trim() || result.stderr.trim(),
            toolExecutedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        const commandError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
        return {
          data: {
            ...input.data,
            stdout: String(commandError.stdout || "").trim(),
            stderr: String(commandError.stderr || "").trim(),
            exitCode: typeof commandError.code === "number" ? commandError.code : null,
            command,
            error: commandError.message || String(error),
            toolAction: "command",
            toolResultText: [commandError.stdout, commandError.stderr, commandError.message]
              .map((value) => String(value || "").trim())
              .filter(Boolean)
              .join("\n"),
            toolExecutedAt: new Date().toISOString(),
          },
        };
      }
    }

    if (action === "list-files") {
      const rawPath = resolveTemplate((input.config.path as string) || ".", context);
      const targetPath = path.resolve(rawPath);
      const maxEntries = clamp((input.config.maxEntries as number) || 20, 1, 200);
      const timeoutMs = clamp((input.config.timeoutMs as number) || 15000, 1000, 120000);

      try {
        let rawEntries: string[] = [];
        let commandUsed = "";

        try {
          if (process.platform === "win32") {
            commandUsed = "cmd.exe /d /s /c dir /b";
            const { stdout } = await execFileAsync(
              "cmd.exe",
              ["/d", "/s", "/c", "dir /b"],
              { cwd: targetPath, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }
            );
            rawEntries = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          } else {
            commandUsed = "ls -1";
            const { stdout } = await execFileAsync(
              "ls",
              ["-1"],
              { cwd: targetPath, timeout: timeoutMs, maxBuffer: 1024 * 1024 }
            );
            rawEntries = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          }
        } catch {
          // Fall back to direct fs listing if command execution is unavailable.
          commandUsed = "fs.readdirSync fallback";
          rawEntries = fs.readdirSync(targetPath);
        }

        const entries = rawEntries
          .slice(0, maxEntries)
          .map((name) => {
            try {
              const fullPath = path.join(targetPath, name);
              return fs.statSync(fullPath).isDirectory() ? `[DIR] ${name}` : name;
            } catch {
              return name;
            }
          });

        const fileListingText = [
          `Path: ${targetPath}`,
          `Tool: ${commandUsed}`,
          `Entries (max ${maxEntries}):`,
          ...entries.map((entry) => `- ${entry}`),
        ].join("\n");

        return {
          data: {
            ...input.data,
            fileListing: entries,
            fileListingPath: targetPath,
            fileListingText,
            fileListingSource: commandUsed,
            toolAction: action,
            toolResultText: fileListingText,
            toolExecutedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        const message = `Failed to list files at ${targetPath}: ${String(error)}`;
        return {
          data: {
            ...input.data,
            fileListing: [],
            fileListingPath: targetPath,
            fileListingText: message,
            toolAction: action,
            toolResultText: message,
            toolExecutedAt: new Date().toISOString(),
          },
        };
      }
    }

    if (action === "move-files") {
      const sourcePath = path.resolve(resolveTemplate((input.config.sourcePath as string) || (input.config.path as string) || ".", context));
      const targetPath = path.resolve(resolveTemplate((input.config.targetPath as string) || "", context));
      const allowedRootRaw = resolveTemplate((input.config.allowedRoot as string) || "", context);
      const allowedRoot = allowedRootRaw ? path.resolve(allowedRootRaw) : null;
      const ext = String(input.config.ext || "").trim().replace(/^\./, "").toLowerCase();
      const overwrite = Boolean(input.config.overwrite ?? true);
      const maxFiles = clamp(Number(input.config.maxFiles) || 100, 1, 500);
      const resultData =
        input.data?.result && typeof input.data.result === "object" && !Array.isArray(input.data.result)
          ? (input.data.result as Record<string, unknown>)
          : {};
      const rawNames = input.config.fileNames ?? input.config.files ?? resultData.files ?? input.data?.files ?? input.data?.fileListing ?? [];
      const parsedNames = Array.isArray(rawNames)
        ? rawNames
        : String(rawNames || "")
            .split(/[\n,]/)
            .map((name) => name.trim())
            .filter(Boolean);
      const names = parsedNames
        .map((name) => String(name || "").trim())
        .filter((name) => name && !name.startsWith("[DIR]"))
        .filter((name) => (ext ? name.toLowerCase().endsWith(`.${ext}`) : true))
        .slice(0, maxFiles);

      const inside = (root: string, candidate: string) => {
        const rel = path.relative(root, candidate);
        return candidate === root || (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel));
      };

      if (!targetPath) {
        return {
          data: {
            ...input.data,
            movedFiles: [],
            skippedFiles: names,
            movedCount: 0,
            skippedCount: names.length,
            error: "No targetPath provided",
            toolAction: action,
            toolResultText: "Move files failed: no targetPath provided.",
            toolExecutedAt: new Date().toISOString(),
          },
        };
      }

      try {
        if (allowedRoot) {
          if (!inside(allowedRoot, sourcePath) || !inside(allowedRoot, targetPath)) {
            throw new Error(`sourcePath and targetPath must stay inside allowedRoot: ${allowedRoot}`);
          }
        }
        fs.mkdirSync(targetPath, { recursive: true });
        const movedFiles: string[] = [];
        const skippedFiles: string[] = [];
        const errors: Array<{ file: string; error: string }> = [];

        for (const name of names) {
          const base = path.basename(name);
          if (base !== name) {
            skippedFiles.push(name);
            errors.push({ file: name, error: "nested paths are not allowed" });
            continue;
          }
          const from = path.resolve(sourcePath, base);
          const to = path.resolve(targetPath, base);
          if (!inside(sourcePath, from) || !inside(targetPath, to)) {
            skippedFiles.push(name);
            errors.push({ file: name, error: "resolved path escaped source or target directory" });
            continue;
          }
          if (allowedRoot && (!inside(allowedRoot, from) || !inside(allowedRoot, to))) {
            skippedFiles.push(name);
            errors.push({ file: name, error: "resolved path escaped allowedRoot" });
            continue;
          }
          if (!fs.existsSync(from)) {
            skippedFiles.push(base);
            continue;
          }
          if (!overwrite && fs.existsSync(to)) {
            skippedFiles.push(base);
            continue;
          }
          fs.copyFileSync(from, to);
          fs.rmSync(from, { force: true });
          movedFiles.push(base);
        }

        const toolResultText = `Moved ${movedFiles.length} file(s) from ${sourcePath} to ${targetPath}.`;
        return {
          data: {
            ...input.data,
            movedFiles,
            skippedFiles,
            moveErrors: errors,
            movedCount: movedFiles.length,
            skippedCount: skippedFiles.length,
            sourcePath,
            targetPath,
            toolAction: action,
            toolResultText,
            toolExecutedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        const message = `Failed to move files from ${sourcePath} to ${targetPath}: ${String(error)}`;
        return {
          data: {
            ...input.data,
            movedFiles: [],
            skippedFiles: names,
            movedCount: 0,
            skippedCount: names.length,
            error: message,
            toolAction: action,
            toolResultText: message,
            toolExecutedAt: new Date().toISOString(),
          },
        };
      }
    }

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(totalMem - freeMem, 0);
    const workspacePath = path.resolve(".");
    let diskText = "Disk information unavailable";
    let diskStats: Record<string, unknown> = {};

    try {
      const stat = fs.statfsSync(workspacePath);
      const blockSize = statNumber(stat.bsize);
      const totalBytes = blockSize * statNumber(stat.blocks);
      const freeBytes = blockSize * statNumber(stat.bavail);
      const usedBytes = Math.max(totalBytes - freeBytes, 0);
      const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;

      diskStats = {
        path: workspacePath,
        totalBytes,
        freeBytes,
        usedBytes,
        freePercent: Number(freePercent.toFixed(2)),
      };
      diskText =
        `${workspacePath}: ${bytesToHuman(freeBytes)} free / ${bytesToHuman(totalBytes)} total ` +
        `(${freePercent.toFixed(1)}% free)`;
    } catch (error) {
      diskText = `Disk info error: ${String(error)}`;
    }

    const pcSpecs = {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model || "Unknown CPU",
      cpuCores: cpus.length,
      ramTotalBytes: totalMem,
      ramUsedBytes: usedMem,
      ramFreeBytes: freeMem,
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg(),
      disk: diskStats,
    };

    const pcSpecsText = [
      `Platform: ${pcSpecs.platform} (${pcSpecs.arch})`,
      `CPU: ${pcSpecs.cpuModel} (${pcSpecs.cpuCores} cores)`,
      `RAM: ${bytesToHuman(usedMem)} used / ${bytesToHuman(totalMem)} total`,
      `Storage: ${diskText}`,
      `Host: ${pcSpecs.hostname}`,
      `Uptime: ${Math.floor(pcSpecs.uptimeSeconds / 3600)}h ${Math.floor((pcSpecs.uptimeSeconds % 3600) / 60)}m`,
    ].join("\n");

    return {
      data: {
        ...input.data,
        pcSpecs,
        pcSpecsText,
        toolAction: "pc-specs",
        toolResultText: pcSpecsText,
        toolExecutedAt: new Date().toISOString(),
      },
    };
  },
};

// Cron Trigger
const cronTriggerHandler: NodeHandler = {
  type: "cron-trigger",
  async execute(input) {
    const schedule =
      (input.config.expression as string) ||
      (input.config.cronExpression as string) ||
      "";
    return {
      data: {
        triggeredAt: new Date().toISOString(),
        schedule,
        inputData: input.data,
      },
    };
  },
};

// Telegram Trigger
const telegramTriggerHandler: NodeHandler = {
  type: "telegram-trigger",
  async execute(input) {
    return {
      data: {
        message: (input.data.message as string) || "",
        sender: (input.data.sender as string) || "",
        chatId: (input.data.chatId as string) || "",
        channel: "telegram",
        timestamp: new Date().toISOString(),
      },
    };
  },
};

// Discord Trigger
const discordTriggerHandler: NodeHandler = {
  type: "discord-trigger",
  async execute(input) {
    return {
      data: {
        message: (input.data.message as string) || "",
        sender: (input.data.sender as string) || "",
        channelId: (input.data.channelId as string) || "",
        guildId: (input.data.guildId as string) || "",
        channel: "discord",
        timestamp: new Date().toISOString(),
      },
    };
  },
};

// HTTP Request
const httpRequestHandler: NodeHandler = {
  type: "http-request",
  async execute(input, context) {
    const url = resolveTemplate((input.config.url as string) || "", context);
    const method = ((input.config.method as string) || "GET").toUpperCase();
    const headersRaw = (input.config.headers as string) || "";
    const bodyRaw = resolveTemplate((input.config.body as string) || "", context);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (headersRaw) {
      try {
        const parsed = JSON.parse(headersRaw) as Record<string, string>;
        Object.assign(headers, parsed);
      } catch {
        // Ignore bad headers
      }
    }

    const fetchOptions: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && bodyRaw) {
      fetchOptions.body = bodyRaw;
    }

    try {
      const res = await fetch(url, fetchOptions);
      const contentType = res.headers.get("content-type") || "";
      const body = contentType.includes("application/json")
        ? await res.json()
        : await res.text();

      return {
        data: {
          status: res.status,
          ok: res.ok,
          body,
          headers: Object.fromEntries(res.headers.entries()),
          bodyText: typeof body === "string" ? body : JSON.stringify(body),
        },
      };
    } catch (error) {
      return {
        data: {
          status: 0,
          ok: false,
          body: null,
          bodyText: `Error: ${String(error)}`,
          error: String(error),
        },
      };
    }
  },
};

// RSS Read — fetch and parse an RSS 2.0 or Atom feed without extra deps.
function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .trim();
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlEntities(match[1]).replace(/<[^>]+>/g, "").trim() : "";
}

function extractAtomLink(block: string): string {
  const alternate = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alternate) return decodeXmlEntities(alternate[1]);
  const plain = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return plain ? decodeXmlEntities(plain[1]) : "";
}

const rssReadHandler: NodeHandler = {
  type: "rss-read",
  async execute(input, context) {
    const url = resolveTemplate(String(input.config.url || ""), context).trim();
    const limit = Math.max(1, Math.min(50, Number(input.config.limit) || 10));
    const sinceHours = Number(input.config.sinceHours) || 0;
    if (!url) {
      return { data: { items: [], count: 0, error: "Missing feed URL" } };
    }
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(Math.max(1000, Number(input.config.timeoutMs) || 20000)),
      });
      if (!response.ok) {
        return { data: { items: [], count: 0, error: `Feed request failed with status ${response.status}` } };
      }
      const xml = await response.text();
      const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
      const blocks = isAtom
        ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
        : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
      const cutoff = sinceHours > 0 ? Date.now() - sinceHours * 60 * 60 * 1000 : null;
      const items = blocks
        .map((block) => {
          const publishedRaw = isAtom
            ? extractXmlTag(block, "updated") || extractXmlTag(block, "published")
            : extractXmlTag(block, "pubDate") || extractXmlTag(block, "dc:date");
          const publishedMs = publishedRaw ? Date.parse(publishedRaw) : NaN;
          return {
            title: extractXmlTag(block, "title"),
            link: isAtom ? extractAtomLink(block) : extractXmlTag(block, "link"),
            publishedAt: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : publishedRaw || null,
            summary: (isAtom
              ? extractXmlTag(block, "summary") || extractXmlTag(block, "content")
              : extractXmlTag(block, "description")
            ).slice(0, 1000),
            id: isAtom ? extractXmlTag(block, "id") : extractXmlTag(block, "guid"),
            _publishedMs: publishedMs,
          };
        })
        .filter((item) => item.title || item.link)
        .filter((item) => (cutoff === null ? true : Number.isFinite(item._publishedMs) && item._publishedMs >= cutoff))
        .slice(0, limit)
        .map(({ _publishedMs, ...item }) => item);
      const feedTitle = isAtom
        ? extractXmlTag(xml.slice(0, xml.search(/<entry[\s>]/i) >= 0 ? xml.search(/<entry[\s>]/i) : 4000), "title")
        : extractXmlTag(xml.slice(0, xml.search(/<item[\s>]/i) >= 0 ? xml.search(/<item[\s>]/i) : 4000), "title");
      return {
        data: {
          items,
          count: items.length,
          feedTitle,
          format: isAtom ? "atom" : "rss",
          url,
        },
      };
    } catch (error) {
      return { data: { items: [], count: 0, error: String(error) } };
    }
  },
};

const googleSheetsHandler: NodeHandler = {
  type: "google-sheets",
  async execute(input, context) {
    const action = String(input.config.action || "read");
    const spreadsheetId = resolveTemplate(String(input.config.spreadsheetId || ""), context).trim();
    const range = resolveTemplate(String(input.config.range || "Sheet1!A:Z"), context).trim();
    const accessToken = String((context.get("google.accessToken") as string | undefined) || "").trim();
    const valueInputOption = String(input.config.valueInputOption || "USER_ENTERED");
    const values = parseJsonConfig(input.config.valuesJson, []);

    if (!spreadsheetId) {
      return { data: { ...input.data, rows: [], error: "No spreadsheetId provided" } };
    }
    if (!accessToken) {
      return { data: { ...input.data, rows: [], error: "No Google access token available. Configure Google OAuth first." } };
    }

    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    try {
      let response: Response;
      if (action === "append") {
        response = await fetch(`${baseUrl}:append?valueInputOption=${encodeURIComponent(valueInputOption)}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ values: Array.isArray(values) ? values : [] }),
        });
      } else if (action === "update") {
        response = await fetch(`${baseUrl}?valueInputOption=${encodeURIComponent(valueInputOption)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ values: Array.isArray(values) ? values : [] }),
        });
      } else {
        response = await fetch(baseUrl, { headers });
      }
      const body = await response.json() as Record<string, unknown>;
      return {
        data: {
          ...input.data,
          action,
          spreadsheetId,
          range,
          rows: Array.isArray(body.values) ? body.values : [],
          response: body,
          error: response.ok ? null : JSON.stringify(body),
        },
      };
    } catch (error) {
      return { data: { ...input.data, action, spreadsheetId, range, rows: [], error: String(error) } };
    }
  },
};

const notionHandler: NodeHandler = {
  type: "notion",
  async execute(input, context) {
    const action = String(input.config.action || "query-database");
    const apiKey = resolveCredentialValue(input.config.apiKey);
    const databaseId = resolveTemplate(String(input.config.databaseId || ""), context).trim();
    const pageId = resolveTemplate(String(input.config.pageId || ""), context).trim();
    const query = parseJsonConfig(input.config.queryJson, {});
    const properties = parseJsonConfig(input.config.propertiesJson, {});

    if (!apiKey) {
      return { data: { ...input.data, error: "No Notion API key configured", items: [] } };
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    try {
      let response: Response;
      if (action === "get-page") {
        if (!pageId) return { data: { ...input.data, error: "No pageId provided", items: [] } };
        response = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, { headers });
      } else if (action === "create-page") {
        if (!databaseId) return { data: { ...input.data, error: "No databaseId provided", items: [] } };
        response = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers,
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties,
          }),
        });
      } else {
        if (!databaseId) return { data: { ...input.data, error: "No databaseId provided", items: [] } };
        response = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify(query),
        });
      }
      const body = await response.json() as Record<string, unknown>;
      return {
        data: {
          ...input.data,
          action,
          items: Array.isArray(body.results) ? body.results : body.object ? [body] : [],
          response: body,
          error: response.ok ? null : JSON.stringify(body),
        },
      };
    } catch (error) {
      return { data: { ...input.data, action, items: [], error: String(error) } };
    }
  },
};

const airtableHandler: NodeHandler = {
  type: "airtable",
  async execute(input, context) {
    const action = String(input.config.action || "list-records");
    const apiKey = resolveCredentialValue(input.config.apiKey);
    const baseId = resolveTemplate(String(input.config.baseId || ""), context).trim();
    const table = resolveTemplate(String(input.config.table || ""), context).trim();
    const recordId = resolveTemplate(String(input.config.recordId || ""), context).trim();
    const maxRecords = clamp((input.config.maxRecords as number) || 20, 1, 100);
    const fields = parseJsonConfig(input.config.fieldsJson, {});

    if (!apiKey) {
      return { data: { ...input.data, error: "No Airtable API key configured", records: [] } };
    }
    if (!baseId || !table) {
      return { data: { ...input.data, error: "baseId and table are required", records: [] } };
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const encodedTable = encodeURIComponent(table);

    try {
      let response: Response;
      if (action === "create-record") {
        response = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodedTable}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ fields }),
        });
      } else if (action === "update-record") {
        if (!recordId) return { data: { ...input.data, error: "recordId is required for update-record", records: [] } };
        response = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodedTable}/${encodeURIComponent(recordId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields }),
        });
      } else {
        response = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodedTable}?maxRecords=${maxRecords}`, {
          headers,
        });
      }
      const body = await response.json() as Record<string, unknown>;
      return {
        data: {
          ...input.data,
          action,
          records: Array.isArray(body.records) ? body.records : body.id ? [body] : [],
          response: body,
          error: response.ok ? null : JSON.stringify(body),
        },
      };
    } catch (error) {
      return { data: { ...input.data, action, records: [], error: String(error) } };
    }
  },
};

// Switch
const switchHandler: NodeHandler = {
  type: "switch",
  async execute(input, context) {
    const expression = resolveTemplate((input.config.expression as string) || "false", context);
    const cases = (input.config.cases as string[]) || [];

    let value: unknown;
    try {
      value = evaluateExpressionValue(expression, input.data);
    } catch {
      value = expression;
    }

    const valueStr = String(value);
    const matchedIndex = cases.indexOf(valueStr);
    const branch = matchedIndex >= 0 ? `case_${matchedIndex}` : "default";

    return {
      data: {
        ...input.data,
        branch,
        switchValue: value,
      },
    };
  },
};

// Delay
const delayHandler: NodeHandler = {
  type: "delay",
  async execute(input, context) {
    const rawDuration = (input.config.duration as number) ?? (input.config.delayMs as number) ?? 1000;
    const duration = Math.min(rawDuration, 300000);
    const startedAt = Date.now();
    while (Date.now() - startedAt < duration) {
      if (context.abortSignal.aborted) {
        throw new Error("Execution interrupted by user.");
      }
      await new Promise((r) => setTimeout(r, Math.min(250, duration - (Date.now() - startedAt))));
    }
    return { data: { ...input.data, delayed: true, durationMs: duration } };
  },
};

// Set Variables
const setVariablesHandler: NodeHandler = {
  type: "set-variables",
  async execute(input, context) {
    const assignments = (input.config.assignments as Array<{ key: string; value: string }>) || [];
    const existingVars =
      ((context.get("vars.current") as Record<string, unknown> | undefined) ??
        (context.get("vars") as Record<string, unknown> | undefined) ??
        (typeof input.data.vars === "object" && input.data.vars
          ? (input.data.vars as Record<string, unknown>)
          : {})) as Record<string, unknown>;
    const vars: Record<string, unknown> = { ...existingVars };

    const legacyVariables = input.config.variables;
    if (legacyVariables) {
      try {
        const parsed =
          typeof legacyVariables === "string"
            ? JSON.parse(legacyVariables) as Record<string, unknown>
            : legacyVariables as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          vars[key] = typeof value === "string" ? resolveTemplate(value, context) : value;
        }
      } catch {
        // Invalid legacy JSON is ignored; assignment rows remain authoritative.
      }
    }

    for (const { key, value } of assignments) {
      if (key) {
        vars[key] = resolveTemplate(value || "", context);
      }
    }

    context.set("vars", vars);
    return { data: { ...input.data, ...vars, vars } };
  },
};

// Filter
const filterHandler: NodeHandler = {
  type: "filter",
  async execute(input, context) {
    const rawCondition = (input.config.condition as string) || "true";
    // Resolve {{…}} templates in the condition — same fix as if-else.
    const condition = resolveTemplate(rawCondition, context);
    const result = evaluateCondition(condition, input.data);

    if (!result) {
      context.emit("filter:stopped", { message: input.config.stopMessage || "Filter condition not met" });
      return { data: { ...input.data, stopped: true, filterPassed: false } };
    }

    return { data: { ...input.data, stopped: false, filterPassed: true } };
  },
};

// Send Email
const sendEmailHandler: NodeHandler = {
  type: "send-email",
  async execute(input, context) {
    const to = resolveTemplate((input.config.to as string) || "", context);
    const subject = resolveTemplate((input.config.subject as string) || "Message from disp8ch", context);
    const body = resolveTemplate(
      (input.config.body as string) ||
        (input.data.response as string) ||
        (input.data.message as string) ||
        "",
      context
    );

    if (isSilentMessage(body)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    if (!to) {
      return { data: { sent: false, error: "No recipient" } };
    }

    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.default.createTransport({
        host: (input.config.host as string) || "smtp.gmail.com",
        port: (input.config.port as number) || 587,
        secure: (input.config.secure as boolean) ?? false,
        auth: {
          user: (input.config.user as string) || "",
          pass: (input.config.pass as string) || "",
        },
      });

      const info = await transport.sendMail({
        from: (input.config.user as string) || "disp8ch",
        to,
        subject,
        text: body,
      });

      return { data: { sent: true, messageId: info.messageId, to, subject } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

// Send Telegram
const sendTelegramHandler: NodeHandler = {
  type: "send-telegram",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const to =
      (input.config.to as string) ||
      (input.config.chatId as string) ||
      (input.data.chatId as string) ||
      (input.data.sender as string) ||
      "";

    if (!to) {
      return { data: { sent: false, error: "No chat ID" } };
    }

    try {
      const { sendTelegramMessage } = await import("@/lib/channels/telegram");
      await sendTelegramMessage(to, message);
      return { data: { sent: true, to, content: message } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

// Send Discord
const sendDiscordHandler: NodeHandler = {
  type: "send-discord",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const channelId =
      (input.config.channelId as string) ||
      (input.config.webhookId as string) ||
      (input.config.channel as string) ||
      (input.data.channelId as string) ||
      "";

    if (!channelId) {
      return { data: { sent: false, error: "No channel ID" } };
    }

    try {
      const { sendDiscordMessage } = await import("@/lib/channels/discord");
      await sendDiscordMessage(channelId, message);
      return { data: { sent: true, channelId, content: message } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

const sendSlackHandler: NodeHandler = {
  type: "send-slack",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const channelId =
      (input.config.channelId as string) ||
      (input.config.channel as string) ||
      (input.data.channelId as string) ||
      "";
    const blocksJson =
      (input.config.blocksJson as string) ||
      (input.data.blocks as string) ||
      "";

    if (!channelId) {
      return { data: { sent: false, error: "No Slack channel ID" } };
    }

    try {
      const { parseSlackBlocksJson } = await import("@/lib/channels/slack-blocks");
      const { sendSlackMessage } = await import("@/lib/channels/slack");
      const blocks = parseSlackBlocksJson(blocksJson);
      await sendSlackMessage(channelId, message, { blocks });
      return { data: { sent: true, channelId, content: message, blocksSent: blocks.length } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

const sendBlueBubblesHandler: NodeHandler = {
  type: "send-bluebubbles",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const chatGuid =
      (input.config.chatGuid as string) ||
      (input.data.chatGuid as string) ||
      "";

    if (!chatGuid) {
      return { data: { sent: false, error: "No BlueBubbles chat GUID" } };
    }

    try {
      const { sendBlueBubblesMessage } = await import("@/lib/channels/bluebubbles");
      await sendBlueBubblesMessage(chatGuid, message);
      return { data: { sent: true, chatGuid, content: message } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

const sendTeamsHandler: NodeHandler = {
  type: "send-teams",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const conversationId =
      (input.config.conversationId as string) ||
      (input.data.conversationId as string) ||
      "";
    const serviceUrl =
      (input.config.serviceUrl as string) ||
      (input.data.serviceUrl as string) ||
      "";

    if (!conversationId || !serviceUrl) {
      return { data: { sent: false, error: "Teams conversationId and serviceUrl are required" } };
    }

    try {
      const { sendTeamsMessage } = await import("@/lib/channels/teams");
      await sendTeamsMessage(serviceUrl, conversationId, message);
      return { data: { sent: true, conversationId, serviceUrl, content: message } };
    } catch (error) {
      return { data: { sent: false, error: String(error) } };
    }
  },
};

const sendSmsHandler: NodeHandler = {
  type: "send-sms",
  async execute(input, context) {
    const configuredMessage = resolveTemplate((input.config.message as string) || "", context);
    const message =
      configuredMessage ||
      (input.data.response as string) ||
      (input.data.message as string) ||
      "";
    if (isSilentMessage(message)) {
      return { data: { sent: false, skipped: true, reason: "silent" } };
    }
    const to = resolveTemplate(
      (input.config.to as string) ||
        (input.data.phone as string) ||
        (input.data.to as string) ||
        "",
      context,
    );
    if (!to) {
      return { data: { sent: false, error: "No SMS recipient" } };
    }
    const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
    const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    const from = String(process.env.TWILIO_FROM_NUMBER || input.config.from || "").trim();
    const mockMode = input.config.mockMode !== false || !accountSid || !authToken || !from;
    if (mockMode) {
      return { data: { sent: true, mock: true, to, from: from || "(not configured)", message } };
    }

    const body = new URLSearchParams({ To: to, From: from, Body: message });
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      return { data: { sent: false, error: String(payload.message || text || response.statusText), status: response.status } };
    }
    return { data: { sent: true, to, from, messageId: payload.sid, status: payload.status, provider: "twilio" } };
  },
};

// GitHub Trigger — parses a GitHub webhook payload (pull_request / issues / push)
// into structured fields. Use it as the entry node when a GitHub webhook invokes the workflow.
const githubTriggerHandler: NodeHandler = {
  type: "github-trigger",
  async execute(input) {
    const body = (input.data.body || input.data || {}) as Record<string, any>;
    const headers = (input.data.headers || {}) as Record<string, any>;
    const event = String(headers["x-github-event"] || headers["X-GitHub-Event"] || body.event || "");
    const pr = body.pull_request;
    const issue = body.issue;
    const actor = pr?.user || issue?.user || body.sender;
    return {
      data: {
        event,
        action: String(body.action || ""),
        repo: body.repository?.full_name || "",
        number: pr?.number ?? issue?.number ?? null,
        title: pr?.title || issue?.title || "",
        author: actor?.login || "",
        diffUrl: pr?.diff_url || "",
        htmlUrl: pr?.html_url || issue?.html_url || "",
        body: pr?.body || issue?.body || "",
        raw: body,
      },
    };
  },
};

// GitHub Comment — posts a comment to an issue or pull request. Mock mode (default, or when
// no GITHUB_TOKEN is configured) returns a staged result so the node is testable without
// credentials. Respects the [SILENT] suppression convention.
const githubCommentHandler: NodeHandler = {
  type: "github-comment",
  async execute(input, context) {
    const message = resolveTemplate(
      (input.config.body as string) || (input.data.response as string) || (input.data.message as string) || "",
      context,
    );
    if (isSilentMessage(message)) {
      return { data: { posted: false, skipped: true, reason: "silent" } };
    }
    const repo = resolveTemplate((input.config.repo as string) || (input.data.repo as string) || "", context).trim();
    const number = resolveTemplate(String(input.config.issueNumber ?? input.data.number ?? ""), context).trim();
    if (!repo || !number) {
      return { data: { posted: false, error: "repo (owner/name) and issue/PR number are required" } };
    }
    const token = String(process.env.GITHUB_TOKEN || input.config.token || "").trim();
    const mockMode = input.config.mockMode !== false || !token;
    if (mockMode) {
      return { data: { posted: true, mock: true, repo, number, message } };
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ body: message }),
      });
      const text = await res.text();
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = { raw: text }; }
      if (!res.ok) {
        return { data: { posted: false, error: String(payload.message || text || res.statusText), status: res.status } };
      }
      return { data: { posted: true, repo, number, commentId: payload.id, htmlUrl: payload.html_url, provider: "github" } };
    } catch (error) {
      return { data: { posted: false, error: String(error) } };
    }
  },
};

// Call Workflow
const callWorkflowHandler: NodeHandler = {
  type: "call-workflow",
  async execute(input, context) {
    const targetId = (input.config.workflowId as string) || "";
    if (!targetId) {
      return { data: { error: "No target workflow ID", result: null } };
    }

    // Depth guard — prevent infinite loops
    const depth = ((input.data._callDepth as number) || 0) + 1;
    if (depth > 5) {
      return { data: { error: "Max call depth (5) exceeded", result: null } };
    }

    try {
      const { getSqlite } = await import("@/lib/db");
      const db = getSqlite();
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(targetId) as {
        nodes: string; edges: string;
      } | undefined;

      if (!row) {
        return { data: { error: `Workflow ${targetId} not found`, result: null } };
      }

      const { executeWorkflow } = await import("@/lib/engine/executor");
      const { getModelConfig } = await import("@/lib/agents/model-router");

      const nodes = JSON.parse(row.nodes);
      const edges = JSON.parse(row.edges);
      const modelConfig = getModelConfig();

      const inputData = {
        ...(typeof input.config.inputData === "object" ? (input.config.inputData as Record<string, unknown>) : {}),
        _callDepth: depth,
      };

      const result = await executeWorkflow({
        workflowId: targetId,
        nodes,
        edges,
        triggerType: "manual",
        triggerData: inputData,
        modelConfig,
        lane: "subflow",
        parentExecutionId: context.executionId,
        parentNodeId: input.node?.id ?? "call-workflow",
      });

      return {
        data: {
          result: result.nodeResults,
          status: result.status,
          error: result.error,
        },
      };
    } catch (error) {
      return { data: { error: String(error), result: null } };
    }
  },
};

// Run Code
const runCodeHandler: NodeHandler = {
  type: "run-code",
  async execute(input) {
    const code = (input.config.code as string) || "";
    const timeout = Math.min((input.config.timeout as number) || 5000, 30000);

    if (!code.trim()) {
      return { data: { result: null, error: "No code provided" } };
    }

    try {
      // Safe sandbox: no require, no process, no __dirname
      const sandbox = {
        input: input.data,
        result: undefined as unknown,
        console: { log: log.info.bind(log), error: log.error.bind(log) },
        JSON,
        Math,
        Date,
        String,
        Number,
        Boolean,
        Array,
        Object,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
      };
      vm.runInNewContext(code, sandbox, { timeout });
      return { data: { result: sandbox.result, error: null } };
    } catch (error) {
      return { data: { result: null, error: String(error) } };
    }
  },
};

// Read File (also supports reading a whole directory)
const readFileHandler: NodeHandler = {
  type: "read-file",
  async execute(input, context) {
    const filePath = resolveTemplate(
      (input.config.path as string) ||
        (input.config.filePath as string) ||
        "",
      context,
    );
    const encoding = ((input.config.encoding as BufferEncoding) || "utf-8") as BufferEncoding;

    if (!filePath) {
      return { data: { content: "", error: "No path provided" } };
    }

    try {
      const resolved = path.resolve(filePath);
      // Directory mode: read every matching file and return the concatenated
      // content plus a per-file array. Generic and reusable — any workflow can
      // hand a folder's contents to a downstream node in one step (no per-file
      // tool calls). Bounded by maxFiles / maxBytes to keep prompts safe.
      if (fs.statSync(resolved).isDirectory()) {
        const ext = String((input.config.ext as string) || "").trim().replace(/^\./, "").toLowerCase();
        const maxFiles = Math.max(1, Math.min(Number(input.config.maxFiles) || 25, 200));
        const maxBytes = Math.max(256, Math.min(Number(input.config.maxBytes) || 12000, 200000));
        const sort = String((input.config.sort as string) || "name");
        let names = fs.readdirSync(resolved).filter((name) => {
          try {
            if (!fs.statSync(path.join(resolved, name)).isFile()) return false;
          } catch {
            return false;
          }
          return ext ? name.toLowerCase().endsWith(`.${ext}`) : true;
        });
        names.sort();
        if (sort === "newest" || sort === "recent") names.reverse();
        names = names.slice(0, maxFiles);
        const files = names.map((name) => {
          let body = "";
          try {
            body = fs.readFileSync(path.join(resolved, name), encoding).slice(0, maxBytes);
          } catch (error) {
            body = `(error reading ${name}: ${String(error)})`;
          }
          return { name, content: body };
        });
        const content = files.map((f) => `## ${f.name}\n\n${f.content}`).join("\n\n---\n\n");
        return { data: { content, files, count: files.length, isDirectory: true, path: resolved, error: null } };
      }
      const content = fs.readFileSync(resolved, encoding);
      return { data: { content, path: resolved, error: null } };
    } catch (error) {
      return { data: { content: "", path: filePath, error: String(error) } };
    }
  },
};

// Write File
const writeFileHandler: NodeHandler = {
  type: "write-file",
  async execute(input, context) {
    const filePath = resolveTemplate(
      (input.config.path as string) ||
        (input.config.filePath as string) ||
        "",
      context,
    );
    const content = resolveTemplate(
      (input.config.content as string) ||
        (input.data.response as string) ||
        (input.data.content as string) ||
        "",
      context
    );
    const mode = (input.config.mode as string) || "overwrite";
    const flag = mode === "append" ? "a" : "w";

    if (!filePath) {
      return { data: { written: false, error: "No path provided" } };
    }

    try {
      const resolved = path.resolve(filePath);
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, content, { flag, encoding: "utf-8" });
      return { data: { written: true, path: resolved, mode, error: null } };
    } catch (error) {
      return { data: { written: false, path: filePath, error: String(error) } };
    }
  },
};

const boardTaskHandler: NodeHandler = {
  type: "board-task",
  async execute(input, context) {
    const action = String(input.config.action ?? "list").trim().toLowerCase();
    const boardId = resolveTemplate(String(input.config.boardId ?? "main-board"), context) || "main-board";
    const title = resolveTemplate(String(input.config.title ?? input.data.taskTitle ?? ""), context).trim();
    const description = resolveTemplate(
      String(input.config.description ?? input.data.message ?? input.data.response ?? ""),
      context,
    ).trim();
    const query = resolveTemplate(String(input.config.query ?? ""), context).trim().toLowerCase();
    const status = resolveTemplate(String(input.config.status ?? ""), context).trim();
    const priority = resolveTemplate(String(input.config.priority ?? ""), context).trim();
    const taskId = resolveTemplate(String(input.config.taskId ?? ""), context).trim();
    const organizationId = resolveTemplate(String(input.config.organizationId ?? ""), context).trim();
    const goalId = resolveTemplate(String(input.config.goalId ?? ""), context).trim();
    const assignedAgentId = resolveTemplate(String(input.config.assignedAgentId ?? ""), context).trim();
    const limit = Math.max(1, Math.min(25, Number(input.config.limit) || 10));

    const { claimBoardTask, createBoardTask, deleteBoardTask, getBoardTask, listBoardTasks, releaseBoardTask, updateBoardTask } = await import("@/lib/boards/manager");
    const allTasks = listBoardTasks(boardId, {
      organizationId: organizationId || undefined,
      goalId: goalId || undefined,
    });
    const findTask = () => {
      if (taskId) {
        return getBoardTask(taskId);
      }
      if (!title) return null;
      const normalizedTitle = title.toLowerCase();
      return (
        allTasks.find((task) => task.title.toLowerCase() === normalizedTitle) ??
        allTasks.find((task) => task.title.toLowerCase().includes(normalizedTitle))
      );
    };

    if (action === "list") {
      const filtered = allTasks.filter((task) => {
        if (status && task.status !== status) return false;
        if (query) {
          const haystack = [task.title, task.description ?? "", task.workflowTemplateKey ?? ""].join(" ").toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
      const items = filtered.slice(0, limit);
      const response = items.length === 0
        ? `No board tasks found on ${boardId}.`
        : items.map((task, index) => `${index + 1}. ${task.title} [${task.status}] (${task.id})`).join("\n");
      return { data: { ...input.data, action, boardId, total: filtered.length, items, response } };
    }

    if (action === "create") {
      if (!title) {
        return { data: { ...input.data, action, error: "title is required", response: "Board task creation failed: title is required." } };
      }
      const created = createBoardTask({
        boardId,
        title,
        description: description || null,
        organizationId: organizationId || null,
        goalId: goalId || null,
        workflowTemplateKey: String(input.config.workflowTemplateKey ?? "").trim() || null,
        status: (status as "inbox" | "in_progress" | "review" | "done") || "inbox",
        priority: (priority as "low" | "medium" | "high") || "medium",
        assignedAgentId: assignedAgentId || null,
      });
      return {
        data: {
          ...input.data,
          action,
          task: created,
          response: `Created board task "${created.title}" (${created.id}) on ${created.boardName || boardId}.`,
        },
      };
    }

    if (action === "update") {
      const existing = findTask();
      if (!existing) {
        return { data: { ...input.data, action, error: "task not found", response: "Board task update failed: task not found." } };
      }
      const updated = updateBoardTask(existing.id, {
        organizationId: organizationId || undefined,
        goalId: goalId || undefined,
        title: title || undefined,
        description: description || undefined,
        status: status ? (status as "inbox" | "in_progress" | "review" | "done") : undefined,
        priority: priority ? (priority as "low" | "medium" | "high") : undefined,
        assignedAgentId: assignedAgentId || undefined,
      });
      return {
        data: {
          ...input.data,
          action,
          task: updated,
          response: `Updated board task "${updated.title}" (${updated.id}) to ${updated.status}.`,
        },
      };
    }

    if (action === "delete") {
      const existing = findTask();
      if (!existing) {
        return { data: { ...input.data, action, error: "task not found", response: "Board task delete failed: task not found." } };
      }
      deleteBoardTask(existing.id);
      return {
        data: {
          ...input.data,
          action,
          taskId: existing.id,
          response: `Deleted board task "${existing.title}" (${existing.id}).`,
        },
      };
    }

    if (action === "claim") {
      const existing = findTask();
      if (!existing) {
        return { data: { ...input.data, action, error: "task not found", response: "Board task claim failed: task not found." } };
      }
      const claimed = claimBoardTask(existing.id, assignedAgentId || "main");
      return { data: { ...input.data, action, task: claimed, response: `Claimed board task "${claimed.title}" (${claimed.id}).` } };
    }

    if (action === "release") {
      const existing = findTask();
      if (!existing) {
        return { data: { ...input.data, action, error: "task not found", response: "Board task release failed: task not found." } };
      }
      const released = releaseBoardTask(existing.id, assignedAgentId || undefined);
      return { data: { ...input.data, action, task: released, response: `Released board task "${released.title}" (${released.id}).` } };
    }

    const existing = findTask();
    if (!existing) {
      return { data: { ...input.data, action, error: "task not found", response: "Board task not found." } };
    }
    return {
      data: {
        ...input.data,
        action: action === "get" ? action : "get",
        task: existing,
        response: `Board task "${existing.title}" (${existing.id}) is ${existing.status}.`,
      },
    };
  },
};

const documentToolHandler: NodeHandler = {
  type: "document-tool",
  async execute(input, context) {
    const action = String(input.config.action ?? "list").trim().toLowerCase();
    const query = resolveTemplate(String(input.config.query ?? input.data.message ?? ""), context).trim();
    const documentId = resolveTemplate(String(input.config.documentId ?? ""), context).trim();
    const documentName = resolveTemplate(String(input.config.documentName ?? input.config.query ?? ""), context).trim();
    const url = resolveTemplate(String(input.config.url ?? ""), context).trim();
    const strategy = resolveTemplate(String(input.config.strategy ?? "static"), context).trim() || "static";
    const maxPages = Math.max(1, Math.min(50, Number(input.config.maxPages) || 12));
    const maxDepth = Math.max(0, Math.min(5, Number(input.config.maxDepth) || 1));
    const limit = Math.max(1, Math.min(25, Number(input.config.limit) || 10));

    const { deleteDocument, formatDocumentContentForModel, getDocumentById, getDocumentByName, listDocuments, searchDocuments } =
      await import("@/lib/documents/store");

    if (action === "list") {
      const items = listDocuments().slice(0, limit);
      const response = items.length === 0
        ? "No documents stored yet."
        : items.map((doc, index) => `${index + 1}. ${doc.name} (${doc.id}) [${doc.sourceType}]`).join("\n");
      return { data: { ...input.data, action, total: items.length, items, response } };
    }

    if (action === "search") {
      if (!query) {
        return { data: { ...input.data, action, error: "query is required", response: "Document search failed: query is required." } };
      }
      const items = searchDocuments(query, limit);
      const response = items.length === 0
        ? `No document matches for "${query}".`
        : items.map((doc, index) => `${index + 1}. ${doc.name} (${doc.id})\n${doc.excerpt}`).join("\n\n");
      return { data: { ...input.data, action, query, total: items.length, items, response } };
    }

    const doc = documentId ? getDocumentById(documentId) : documentName ? getDocumentByName(documentName) : null;

    if (action === "get") {
      if (!doc) {
        return { data: { ...input.data, action, error: "document not found", response: "Document not found." } };
      }
      return {
        data: {
          ...input.data,
	          action,
	          document: doc,
	          response: `Document ${doc.name} (${doc.id})\n\n${formatDocumentContentForModel(doc, 3000)}`,
	        },
	      };
    }

    if (action === "delete") {
      if (!doc) {
        return { data: { ...input.data, action, error: "document not found", response: "Document delete failed: document not found." } };
      }
      deleteDocument(doc.id);
      return { data: { ...input.data, action, documentId: doc.id, response: `Deleted document "${doc.name}" (${doc.id}).` } };
    }

    if (action === "scrape") {
      if (!url) {
        return { data: { ...input.data, action, error: "url is required", response: "Document scrape failed: url is required." } };
      }
      const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3100}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scrape",
          mode: maxPages > 1 || maxDepth > 0 ? "crawl" : "single",
          url,
          name: documentName || undefined,
          strategy,
          maxPages,
          maxDepth,
        }),
      });
      const payload = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: string };
      if (!response.ok || !payload.success || !payload.data) {
        return { data: { ...input.data, action, error: payload.error || `HTTP ${response.status}`, response: `Document scrape failed: ${payload.error || `HTTP ${response.status}`}.` } };
      }
      const created = payload.data;
      return {
        data: {
          ...input.data,
          action,
          document: created,
          response: `Scraped ${String(created.name || "document")} (${String(created.id || "")}) from ${url}.`,
        },
      };
    }

    return { data: { ...input.data, action, error: "unsupported action", response: `Unsupported document action: ${action}` } };
  },
};

const workflowTemplateHandler: NodeHandler = {
  type: "workflow-template",
  async execute(input, context) {
    const action = String(input.config.action ?? "list-templates").trim().toLowerCase();
    const templateRef = resolveTemplate(String(input.config.template ?? input.config.templateKey ?? ""), context).trim();
    const workflowName = resolveTemplate(String(input.config.name ?? input.data.taskTitle ?? ""), context).trim();
    const workflowDescription = resolveTemplate(String(input.config.description ?? input.data.message ?? ""), context).trim();
    const port = process.env.PORT ?? 3100;

    if (action === "list-templates") {
      const items = listWorkflowTemplateCatalog();
      return {
        data: {
          ...input.data,
          action,
          items,
          response: items.map((item) => `- ${item.name} (${item.key})`).join("\n"),
        },
      };
    }

    if (action === "list-workflows") {
      const { getSqlite, initializeDatabase } = await import("@/lib/db");
      initializeDatabase();
      const db = getSqlite();
      const items = db
        .prepare("SELECT id, name, is_active FROM workflows ORDER BY updated_at DESC LIMIT 50")
        .all() as Array<{ id: string; name: string; is_active: number }>;
      return {
        data: {
          ...input.data,
          action,
          items,
          response: items.map((item, index) => `${index + 1}. ${item.name} (${item.id}) [${item.is_active === 1 ? "active" : "disabled"}]`).join("\n"),
        },
      };
    }

    if (action === "create-from-template") {
      const resolvedTemplate = resolveWorkflowTemplateReference(templateRef);
      if (!resolvedTemplate) {
        return {
          data: {
            ...input.data,
            action,
            error: "template not found",
            response: `Workflow template not found for "${templateRef}".`,
          },
        };
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workflowName || resolvedTemplate.name,
          description: workflowDescription || undefined,
          template: resolvedTemplate.key,
        }),
      });
      const payload = await response.json() as { success?: boolean; data?: { id?: string; name?: string }; error?: string };
      if (!response.ok || !payload.success || !payload.data?.id) {
        return {
          data: {
            ...input.data,
            action,
            error: payload.error || `HTTP ${response.status}`,
            response: `Workflow creation failed: ${payload.error || `HTTP ${response.status}`}.`,
          },
        };
      }
      return {
        data: {
          ...input.data,
          action,
          workflowId: payload.data.id,
          workflowName: payload.data.name || workflowName || resolvedTemplate.name,
          templateKey: resolvedTemplate.key,
          response: `Created workflow "${payload.data.name || workflowName || resolvedTemplate.name}" (${payload.data.id}) from template "${resolvedTemplate.name}".`,
        },
      };
    }

    return { data: { ...input.data, action, error: "unsupported action", response: `Unsupported workflow template action: ${action}` } };
  },
};

const schedulerJobHandler: NodeHandler = {
  type: "scheduler-job",
  async execute(input, context) {
    const action = String(input.config.action ?? "list").trim().toLowerCase();
    const workflowId = resolveTemplate(String(input.config.workflowId ?? ""), context).trim();
    const workflowName = resolveTemplate(String(input.config.workflowName ?? ""), context).trim();
    const port = process.env.PORT ?? 3100;

    if (action === "resync") {
      const response = await fetch(`http://127.0.0.1:${port}/api/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resync" }),
      });
      if (!response.ok) {
        return { data: { ...input.data, action, error: `HTTP ${response.status}`, response: `Scheduler resync failed: HTTP ${response.status}.` } };
      }
      return { data: { ...input.data, action, response: "Scheduler resynced successfully." } };
    }

    if (action === "run") {
      let targetWorkflowId = workflowId;
      if (!targetWorkflowId && workflowName) {
        const { getSqlite, initializeDatabase } = await import("@/lib/db");
        initializeDatabase();
        const db = getSqlite();
        const row = db
          .prepare("SELECT id FROM workflows WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?) ORDER BY updated_at DESC LIMIT 1")
          .get(workflowName, `%${workflowName}%`) as { id: string } | undefined;
        targetWorkflowId = row?.id ?? "";
      }
      if (!targetWorkflowId) {
        return { data: { ...input.data, action, error: "workflow not found", response: "Scheduler run failed: workflow not found." } };
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", workflowId: targetWorkflowId }),
      });
      if (!response.ok) {
        return { data: { ...input.data, action, error: `HTTP ${response.status}`, response: `Scheduler run failed: HTTP ${response.status}.` } };
      }
      return { data: { ...input.data, action, workflowId: targetWorkflowId, response: `Triggered scheduled workflow ${targetWorkflowId}.` } };
    }

    const { listScheduledCronJobs } = await import("@/lib/cron/manager");
    const jobs = listScheduledCronJobs();
    const response = jobs.length === 0
      ? "No scheduled workflows."
      : jobs.map((job, index) => `${index + 1}. ${job.workflowId} | ${job.expression} | ${job.timezone}`).join("\n");
    return { data: { ...input.data, action: "list", total: jobs.length, jobs, response } };
  },
};

const dateTimeHandler: NodeHandler = {
  type: "date-time",
  async execute(input, context) {
    const operation = String(input.config.operation || "now").trim().toLowerCase();
    const rawInput = resolveTemplate(String(input.config.input || input.data.iso || ""), context);
    const timezone = String(input.config.timezone || "UTC").trim() || "UTC";
    const locale = String(input.config.locale || "en-US").trim() || "en-US";
    const outputStyle = String(input.config.outputStyle || "datetime").trim().toLowerCase();
    const amount = Number(input.config.amount || 0);
    const unit = String(input.config.unit || "days").trim().toLowerCase();

    const baseDate = parseDateInput(rawInput) ?? new Date();
    if (rawInput && !parseDateInput(rawInput)) {
      return {
        data: {
          ...input.data,
          error: `Invalid date input: ${rawInput}`,
          response: `Date & Time failed: invalid date input "${rawInput}".`,
        },
      };
    }

    const resultDate =
      operation === "add"
        ? shiftDate(baseDate, Number.isFinite(amount) ? amount : 0, unit)
        : baseDate;
    const formatted = formatDateWithStyle({ date: resultDate, timezone, locale, outputStyle });

    return {
      data: {
        ...input.data,
        operation,
        inputIso: baseDate.toISOString(),
        iso: resultDate.toISOString(),
        unixMs: resultDate.getTime(),
        unixSeconds: Math.floor(resultDate.getTime() / 1000),
        timezone,
        locale,
        outputStyle,
        amount,
        unit,
        formatted,
        date: formatDateWithStyle({ date: resultDate, timezone, locale, outputStyle: "date" }),
        time: formatDateWithStyle({ date: resultDate, timezone, locale, outputStyle: "time" }),
        datetime: formatDateWithStyle({ date: resultDate, timezone, locale, outputStyle: "datetime" }),
        human: formatted,
        response: formatted,
      },
    };
  },
};

const channelStatusHandler: NodeHandler = {
  type: "channel-status",
  async execute(input) {
    const format = String(input.config.format || "summary").trim().toLowerCase();
    const [{ getTelegramStatus }, { getDiscordStatus }, { getWhatsAppStatus }, { getSlackStatus }, { getBlueBubblesStatus }, { getTeamsStatus }] =
      await Promise.all([
        import("@/lib/channels/telegram"),
        import("@/lib/channels/discord"),
        import("@/lib/channels/whatsapp"),
        import("@/lib/channels/slack"),
        import("@/lib/channels/bluebubbles"),
        import("@/lib/channels/teams"),
      ]);

    const statuses = {
      telegram: getTelegramStatus(),
      discord: getDiscordStatus(),
      whatsapp: getWhatsAppStatus(),
      slack: getSlackStatus(),
      bluebubbles: getBlueBubblesStatus(),
      teams: getTeamsStatus(),
    };
    const response =
      format === "json"
        ? JSON.stringify(statuses, null, 2)
        : summarizeChannelStatuses(statuses as unknown as Record<string, Record<string, unknown>>);

    return {
      data: {
        ...input.data,
        format,
        statuses,
        response,
      },
    };
  },
};

const councilHandler: NodeHandler = {
  type: "council",
  async execute(input, context) {
    const topic = resolveTemplate(String(input.config.topic || input.data.message || "Untitled council topic"), context).trim();
    const options = parseDelimitedValues(input.config.optionsText).slice(0, 8);
    const decisionMode = String(input.config.decisionMode || "majority").trim().toLowerCase();
    const requestedAgentIds = parseDelimitedValues(input.config.agentIds);
    const activeAgentIds = listAgents()
      .filter((agent) => agent.isActive)
      .map((agent) => agent.id);
    const agentIds = (requestedAgentIds.length > 0 ? requestedAgentIds : activeAgentIds).slice(0, 12);

    if (agentIds.length < 2) {
      return {
        data: {
          ...input.data,
          error: "Council requires at least two active agents.",
          response: "Council requires at least two active agents. Create or enable more agents first.",
        },
      };
    }

    const resolvedOptions = options.length >= 2 ? options : ["Approve", "Revise", "Reject"];
    try {
      const payload = await runCouncilSession({
        topic,
        agentIds,
        options: resolvedOptions,
        decisionMode: decisionMode === "consensus" ? "consensus" : "majority",
      });
      return {
        data: {
          ...input.data,
          ...payload,
          topic,
          options: resolvedOptions,
          agentIds,
          decisionMode: decisionMode === "consensus" ? "consensus" : "majority",
          response: summarizeCouncilResult(payload as unknown as Record<string, unknown>),
        },
      };
    } catch (error) {
      return {
        data: {
          ...input.data,
          error: String(error),
          response: `Council failed: ${String(error)}.`,
        },
      };
    }
  },
};

// Voice STT
const voiceSttHandler: NodeHandler = {
  type: "voice-stt",
  async execute(input) {
    const audioBase64 = (input.data.audioBase64 as string) || (input.config.audioBase64 as string) || "";
    const mimeType = (input.data.mimeType as string) || "audio/webm";
    const language = (input.config.language as string) || undefined;

    if (!audioBase64) {
      return { data: { text: "", error: "No audio data" } };
    }

    try {
      const { getSqlite } = await import("@/lib/db");
      const db = getSqlite();
      const cfgRow = db.prepare("SELECT voice_stt_provider, voice_stt_api_key FROM app_config LIMIT 1").get() as Record<string, unknown> | undefined;
      const sttProvider = (cfgRow?.voice_stt_provider as string) || "openai-whisper";
      const sttApiKey = (cfgRow?.voice_stt_api_key as string | null) || null;

      if (sttProvider === "deepgram") {
        const key = sttApiKey;
        if (!key) return { data: { text: "", error: "Deepgram API key not configured" } };
        const buffer = Buffer.from(audioBase64, "base64");
        const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true" + (language ? `&language=${language}` : ""), {
          method: "POST",
          headers: { Authorization: `Token ${key}`, "Content-Type": mimeType },
          body: buffer,
        });
        const json = await res.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }; err_msg?: string };
        if (!res.ok) return { data: { text: "", error: json.err_msg ?? "Deepgram error" } };
        const text = json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
        return { data: { text, error: null } };
      }

      // openai-whisper or local-whisper
      const oaiRow = db.prepare("SELECT * FROM models WHERE provider = 'openai' AND is_active = 1 ORDER BY priority DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      const auth = sttProvider === "local-whisper"
        ? { apiKey: sttApiKey ?? "none" }
        : resolveModelApiKey({ provider: "openai", storedApiKey: oaiRow?.api_key as string });
      if (!auth.apiKey) return { data: { text: "", error: "No API key resolved for STT" } };

      const OpenAI = (await import("openai")).default;
      const baseUrl = sttProvider === "local-whisper"
        ? "http://localhost:8080/v1"
        : normalizeProviderBaseUrl("openai", (oaiRow?.base_url as string | undefined) || undefined);
      const client = new OpenAI({ apiKey: auth.apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      const buffer = Buffer.from(audioBase64, "base64");
      const file = new File([buffer], "audio.webm", { type: mimeType });
      const transcription = await client.audio.transcriptions.create({
        model: "whisper-1",
        file,
        ...(language ? { language } : {}),
      });
      return { data: { text: transcription.text, error: null } };
    } catch (error) {
      return { data: { text: "", error: String(error) } };
    }
  },
};

// Voice TTS
const voiceTtsHandler: NodeHandler = {
  type: "voice-tts",
  async execute(input) {
    const text =
      (input.data.response as string) ||
      (input.data.text as string) ||
      (input.config.text as string) ||
      "";
    const voice = (input.config.voice as string) || "alloy";
    const model = (input.config.model as string) || "tts-1";
    const speed = (input.config.speed as number) || 1.0;

    if (!text) {
      return { data: { audioBase64: "", mimeType: "audio/mp3", error: "No text to synthesize" } };
    }

    try {
      const { getSqlite } = await import("@/lib/db");
      const db = getSqlite();
      const cfgRow = db.prepare("SELECT voice_tts_provider, voice_tts_api_key, voice_tts_voice_model FROM app_config LIMIT 1").get() as Record<string, unknown> | undefined;
      const ttsProvider = (cfgRow?.voice_tts_provider as string) || "openai";
      const ttsApiKey = (cfgRow?.voice_tts_api_key as string | null) || null;
      const ttsVoiceModel = (cfgRow?.voice_tts_voice_model as string | null) || null;

      if (ttsProvider === "elevenlabs") {
        const key = ttsApiKey;
        if (!key) return { data: { audioBase64: "", mimeType: "audio/mpeg", error: "ElevenLabs API key not configured" } };
        const voiceId = ttsVoiceModel || "21m00Tcm4TlvDq8ikWAM";
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.5 } }),
        });
        if (!res.ok) return { data: { audioBase64: "", mimeType: "audio/mpeg", error: `ElevenLabs error: ${res.status}` } };
        const buffer = Buffer.from(await res.arrayBuffer());
        return { data: { audioBase64: buffer.toString("base64"), mimeType: "audio/mpeg", text, error: null } };
      }

      if (ttsProvider === "azure-tts") {
        const key = ttsApiKey;
        if (!key) return { data: { audioBase64: "", mimeType: "audio/wav", error: "Azure TTS key not configured" } };
        const voiceName = ttsVoiceModel || "en-US-JennyNeural";
        const region = "eastus";
        const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voiceName}'>${text.replace(/</g, "&lt;")}</voice></speak>`;
        const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm" },
          body: ssml,
        });
        if (!res.ok) return { data: { audioBase64: "", mimeType: "audio/wav", error: `Azure TTS error: ${res.status}` } };
        const buffer = Buffer.from(await res.arrayBuffer());
        return { data: { audioBase64: buffer.toString("base64"), mimeType: "audio/wav", text, error: null } };
      }

      // openai (default)
      const row = db.prepare("SELECT * FROM models WHERE provider = 'openai' AND is_active = 1 ORDER BY priority DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return { data: { audioBase64: "", mimeType: "audio/mp3", error: "No OpenAI model configured for TTS" } };
      const auth = resolveModelApiKey({ provider: "openai", storedApiKey: row.api_key as string });
      if (!auth.apiKey) return { data: { audioBase64: "", mimeType: "audio/mp3", error: "No OpenAI API key resolved for TTS" } };

      const OpenAI = (await import("openai")).default;
      const baseUrl = normalizeProviderBaseUrl("openai", (row.base_url as string | undefined) || undefined);
      const client = new OpenAI({ apiKey: auth.apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      const response = await client.audio.speech.create({
        model,
        voice: voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
        input: text,
        speed,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      return { data: { audioBase64: buffer.toString("base64"), mimeType: "audio/mp3", text, error: null } };
    } catch (error) {
      return { data: { audioBase64: "", mimeType: "audio/mp3", error: String(error) } };
    }
  },
};

// Loop — iterate over an array, outputting each item sequentially
const loopHandler: NodeHandler = {
  type: "loop",
  async execute(input, context) {
    const sourcePath = (input.config.sourcePath as string) || "";
    let items: unknown[];

    if (sourcePath) {
      const resolved = resolveTemplate(sourcePath, context);
      try {
        items = JSON.parse(resolved);
      } catch {
        const raw = input.data[sourcePath];
        items = Array.isArray(raw) ? raw : [];
      }
    } else {
      // Auto-detect array in input
      const candidates = Object.values(input.data).filter(Array.isArray);
      items = candidates.length > 0 ? (candidates[0] as unknown[]) : [];
    }

    if (!Array.isArray(items)) items = [];

    return {
      data: {
        ...input.data,
        items,
        totalItems: items.length,
        currentIndex: 0,
        loopActive: true,
      },
    };
  },
};

// Aggregate — collect items into a single array
const aggregateHandler: NodeHandler = {
  type: "aggregate",
  async execute(input) {
    const existing = Array.isArray(input.data.collected) ? (input.data.collected as unknown[]) : [];
    const newItem = input.data.result ?? input.data.response ?? input.data.content ?? input.data;
    const collected = [...existing, newItem];

    return {
      data: {
        collected,
        count: collected.length,
        collectedText: collected.map((item) =>
          typeof item === "string" ? item : JSON.stringify(item)
        ).join("\n"),
      },
    };
  },
};

// Merge — combine outputs from multiple branches into one
const mergeHandler: NodeHandler = {
  type: "merge",
  async execute(input) {
    const rawData = input.config as Record<string, unknown>;
    // Support both "mode" (legacy) and "mergeMode" (new contract field name)
    const mergeMode = String(rawData?.mergeMode ?? rawData?.mode ?? "wait-all");
    const outputShape = String(rawData?.outputShape ?? "merged-object");

    // Get structured upstream outputs injected by the executor.
    const structuredUpstream = (input.data as Record<string, unknown>).__upstream as
      | {
          byNodeId?: Record<string, unknown>;
          byLabel?: Record<string, unknown>;
          ordered?: Array<{ nodeId: string; label: string; output: unknown }>;
        }
      | undefined;
    const upstreamByNodeId =
      structuredUpstream?.byNodeId ??
      ((input.data as Record<string, unknown>).__upstreamByNodeId as Record<string, unknown> | undefined) ??
      {};
    const upstreamByLabel = structuredUpstream?.byLabel ?? {};
    const ordered =
      structuredUpstream?.ordered ??
      Object.entries(upstreamByNodeId).map(([nodeId, output]) => ({ nodeId, label: nodeId, output }));

    // If no upstream injection available, fall back to passing through input data
    if (ordered.length === 0) {
      return { data: { ...input.data, merged: true, mergeMode, outputShape, upstreamCount: 0 } };
    }

    let result: Record<string, unknown>;

    if (outputShape === "by-node-id") {
      result = { ...upstreamByNodeId };
    } else if (outputShape === "by-label") {
      result = { ...upstreamByLabel };
    } else if (outputShape === "array") {
      result = { items: ordered.map((e) => e.output) };
    } else {
      // merged-object with collision detection
      const collisions: Record<string, unknown[]> = {};
      const merged: Record<string, unknown> = {};
      for (const { output } of ordered) {
        if (output && typeof output === "object") {
          for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
            // Skip the internal injection key
            if (k === "__upstreamByNodeId") continue;
            if (k in merged) {
              if (!collisions[k]) collisions[k] = [merged[k]];
              collisions[k].push(v);
            } else {
              merged[k] = v;
            }
          }
        }
      }
      result = { ...merged };
      if (Object.keys(collisions).length > 0) result._collisions = collisions;
    }

    return {
      data: {
        ...result,
        merged: true,
        mergeMode,
        outputShape,
        upstreamCount: ordered.length,
      },
    };
  },
};

// Error Handler — catches errors from upstream nodes
const errorHandlerNode: NodeHandler = {
  type: "error-handler",
  async execute(input) {
    const hasError = Boolean(input.data.error) || Boolean(input.data.stopped);
    return {
      data: {
        ...input.data,
        hasError,
        branch: hasError ? "error" : "success",
        errorMessage: hasError ? String(input.data.error || input.data.stopMessage || "Unknown error") : null,
      },
    };
  },
};

// Wait for Input — pause workflow and wait for user response via WebChat
const waitForInputHandler: NodeHandler = {
  type: "wait-for-input",
  async execute(input, context) {
    const prompt = resolveTemplate(
      (input.config.prompt as string) || "Waiting for your input...",
      context
    );
    const timeoutMs = Math.min((input.config.timeout as number) || 60000, 300000);

    // Emit the prompt to webchat
    const { presentChannelResponse } = await import("@/lib/channels/presentation");
    context.emit("webchat:message", {
      content: presentChannelResponse("webchat", prompt),
      executionId: context.executionId,
      waitingForInput: true,
    });

    // Wait for a response (poll-based via context events)
    const start = Date.now();
    let userResponse = "";

    // Simple polling mechanism — check for a response event
    while (Date.now() - start < timeoutMs) {
      if (context.abortSignal.aborted) {
        throw new Error("Execution interrupted by user.");
      }
      const pending = context.get("waitForInput.response") as string | undefined;
      if (pending) {
        userResponse = pending;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return {
      data: {
        ...input.data,
        userResponse,
        timedOut: !userResponse,
        prompt,
      },
    };
  },
};

// JSON Transform — map, filter, reshape JSON data
const jsonTransformHandler: NodeHandler = {
  type: "json-transform",
  async execute(input) {
    const code = (input.config.expression as string) || "";
    const transform = (input.config.transform as string) || "";
    const timeout = 5000;

    if (!code.trim() && transform === "sort") {
      const source =
        (Array.isArray(input.data.result) && input.data.result) ||
        (Array.isArray(input.data.items) && input.data.items) ||
        (Array.isArray(input.data.rows) && input.data.rows) ||
        [];
      const result = [...source].sort((left, right) => String(left).localeCompare(String(right)));
      return { data: { result, error: null } };
    }

    try {
      const sandbox = {
        input: input.data,
        result: undefined as unknown,
        JSON,
        Math,
        String,
        Number,
        Boolean,
        Array,
        Object,
        parseInt,
        parseFloat,
        isNaN,
      };
      vm.runInNewContext(code, sandbox, { timeout });
      return { data: { result: sandbox.result, error: null } };
    } catch (error) {
      return { data: { result: null, error: String(error) } };
    }
  },
};

// Split Text — split long text into chunks
const splitTextHandler: NodeHandler = {
  type: "split-text",
  async execute(input, context) {
    const text = resolveTemplate(
      (input.config.text as string) || (input.data.response as string) || (input.data.content as string) || "",
      context
    );
    const mode = (input.config.mode as string) || "separator";
    const separator = (input.config.separator as string) || "\n";
    const chunkSize = Math.max((input.config.chunkSize as number) || 1000, 1);

    let chunks: string[];

    if (mode === "characters") {
      chunks = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
      }
    } else if (mode === "words") {
      const words = text.split(/\s+/);
      chunks = [];
      let current: string[] = [];
      for (const word of words) {
        current.push(word);
        if (current.join(" ").length >= chunkSize) {
          chunks.push(current.join(" "));
          current = [];
        }
      }
      if (current.length > 0) chunks.push(current.join(" "));
    } else {
      // separator mode
      chunks = text.split(separator).filter(Boolean);
    }

    return {
      data: {
        chunks,
        totalChunks: chunks.length,
        originalLength: text.length,
      },
    };
  },
};

// Regex Extract — extract patterns from text
const regexExtractHandler: NodeHandler = {
  type: "regex-extract",
  async execute(input, context) {
    const text = resolveTemplate(
      (input.config.text as string) || (input.data.response as string) || (input.data.content as string) || "",
      context
    );
    const pattern = (input.config.pattern as string) || "";
    const flags = (input.config.flags as string) || "g";

    if (!pattern) {
      return { data: { matches: [], count: 0, error: "No pattern provided" } };
    }

    try {
      const regex = new RegExp(pattern, flags);
      const matches: string[] = [];
      let match: RegExpExecArray | null;

      if (flags.includes("g")) {
        while ((match = regex.exec(text)) !== null) {
          matches.push(match[1] || match[0]);
          if (matches.length > 1000) break; // Safety limit
        }
      } else {
        match = regex.exec(text);
        if (match) matches.push(match[1] || match[0]);
      }

      return {
        data: {
          matches,
          count: matches.length,
          matchesText: matches.join("\n"),
          error: null,
        },
      };
    } catch (error) {
      return { data: { matches: [], count: 0, error: String(error) } };
    }
  },
};

// Compare Text — diff two texts
const compareTextHandler: NodeHandler = {
  type: "compare-text",
  async execute(input, context) {
    const textA = resolveTemplate(
      (input.config.textA as string) || (input.data.textA as string) || "",
      context
    );
    const textB = resolveTemplate(
      (input.config.textB as string) || (input.data.textB as string) || "",
      context
    );

    const linesA = textA.split("\n");
    const linesB = textB.split("\n");

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    const setA = new Set(linesA);
    const setB = new Set(linesB);

    for (const line of linesA) {
      if (!setB.has(line)) removed.push(line);
      else unchanged.push(line);
    }
    for (const line of linesB) {
      if (!setA.has(line)) added.push(line);
    }

    const identical = textA === textB;

    return {
      data: {
        identical,
        added,
        removed,
        unchanged,
        addedCount: added.length,
        removedCount: removed.length,
        diffSummary: identical
          ? "Texts are identical"
          : `+${added.length} added, -${removed.length} removed, ${unchanged.length} unchanged`,
      },
    };
  },
};

// Rate Limiter — throttle execution to N calls per window
const rateLimiterCallTimes = new Map<string, number[]>();

const rateLimiterHandler: NodeHandler = {
  type: "rate-limiter",
  async execute(input) {
    const key = (input.config.key as string) || "default";
    const maxCalls = Math.max((input.config.maxCalls as number) || 10, 1);
    const windowMs = Math.max((input.config.windowMs as number) || 60000, 1000);
    const now = Date.now();

    const times = rateLimiterCallTimes.get(key) || [];
    const windowStart = now - windowMs;
    const recent = times.filter((t) => t > windowStart);

    if (recent.length >= maxCalls) {
      const waitMs = recent[0] + windowMs - now;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 30000)));
    }

    recent.push(now);
    rateLimiterCallTimes.set(key, recent.slice(-maxCalls));

    return {
      data: {
        ...input.data,
        rateLimited: false,
        callsInWindow: recent.length,
      },
    };
  },
};

// Database Query — run SQL against SQLite
const databaseQueryHandler: NodeHandler = {
  type: "database-query",
  async execute(input, context) {
    const query = resolveTemplate((input.config.query as string) || "", context);
    const dbPath = resolveTemplate((input.config.dbPath as string) || "", context);

    if (!query) {
      return { data: { ...input.data, rows: [], error: "No query provided" } };
    }

    try {
      const Database = (await import("better-sqlite3")).default;
      const resolvedPath = dbPath
        ? path.resolve(dbPath)
        : path.resolve(process.env.DATABASE_PATH || "data/disp8ch.db");
      const db = new Database(resolvedPath, { readonly: query.trim().toUpperCase().startsWith("SELECT") });

      const isSelect = query.trim().toUpperCase().startsWith("SELECT") ||
                       query.trim().toUpperCase().startsWith("PRAGMA");

      if (isSelect) {
        const rows = db.prepare(query).all();
        db.close();
        return { data: { ...input.data, rows, count: rows.length, rowCount: rows.length, error: null } };
      }

      const result = db.prepare(query).run();
      db.close();
      return {
        data: {
          ...input.data,
          changes: result.changes,
          lastInsertRowid: Number(result.lastInsertRowid),
          error: null,
        },
      };
    } catch (error) {
      return { data: { ...input.data, rows: [], error: String(error) } };
    }
  },
};

// Clipboard — read/write system clipboard
const clipboardHandler: NodeHandler = {
  type: "clipboard",
  async execute(input, context) {
    const action = (input.config.action as string) || "read";
    const content = resolveTemplate(
      (input.config.content as string) || (input.data.response as string) || "",
      context
    );

    try {
      if (action === "write") {
        if (process.platform === "win32") {
          await execFileAsync("cmd.exe", ["/d", "/s", "/c", `echo ${content.replace(/[&|<>^]/g, "^$&")}| clip`], { timeout: 5000 });
        } else if (process.platform === "darwin") {
          const proc = require("node:child_process").spawn("pbcopy");
          proc.stdin.write(content);
          proc.stdin.end();
          await new Promise<void>((resolve) => proc.on("close", () => resolve()));
        } else {
          await execFileAsync("xclip", ["-selection", "clipboard"], { input: content, timeout: 5000 } as Parameters<typeof execFileAsync>[2]);
        }
        return { data: { action: "write", success: true, content } };
      }

      // Read clipboard
      let result = "";
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], { timeout: 5000 });
        result = stdout.trim();
      } else if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("pbpaste", [], { timeout: 5000 });
        result = stdout;
      } else {
        const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 5000 });
        result = stdout;
      }

      return { data: { action: "read", content: result, error: null } };
    } catch (error) {
      return { data: { action, content: "", error: String(error) } };
    }
  },
};

// Notification — OS-level desktop notification
const notificationHandler: NodeHandler = {
  type: "notification",
  async execute(input, context) {
    const title = resolveTemplate(
      (input.config.title as string) || "disp8ch",
      context
    );
    const message = resolveTemplate(
      (input.config.message as string) || (input.data.response as string) || "",
      context
    );

    if (isSilentMessage(message)) {
      return { data: { notified: false, skipped: true, reason: "silent" } };
    }
    try {
      if (process.platform === "win32") {
        const script = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${message.replace(/'/g, "''")}', 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`;
        await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10000 });
      } else if (process.platform === "darwin") {
        await execFileAsync("osascript", ["-e", `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`], { timeout: 5000 });
      } else {
        await execFileAsync("notify-send", [title, message], { timeout: 5000 });
      }
      return { data: { sent: true, title, message } };
    } catch (error) {
      return { data: { sent: false, title, message, error: String(error) } };
    }
  },
};

// Git Operation — structured git commands
const gitOperationHandler: NodeHandler = {
  type: "git-operation",
  async execute(input, context) {
    const action = (input.config.action as string) || (input.config.operation as string) || "status";
    const repoPath = resolveTemplate((input.config.repoPath as string) || ".", context);
    const resolved = path.resolve(repoPath);

    const gitArgs: Record<string, string[]> = {
      status: ["status", "--porcelain"],
      log: ["log", "--oneline", "-20"],
      diff: ["diff", "--stat"],
      "diff-full": ["diff"],
      branch: ["branch", "-a"],
      "remote-url": ["remote", "-v"],
      stash: ["stash", "list"],
    };

    const args = gitArgs[action] || ["status", "--porcelain"];

    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: resolved,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });

      return {
        data: {
          action,
          output: stdout.trim(),
          stderr: stderr.trim(),
          repoPath: resolved,
          error: null,
        },
      };
    } catch (error) {
      return { data: { action, output: "", repoPath: resolved, error: String(error) } };
    }
  },
};

// Archive — create/extract zip archives
const archiveHandler: NodeHandler = {
  type: "archive",
  async execute(input, context) {
    const action = (input.config.action as string) || (input.config.operation as string) || "create";
    const archivePath = resolveTemplate((input.config.archivePath as string) || "", context);
    const sourcePath = resolveTemplate((input.config.sourcePath as string) || "", context);

    if (!archivePath) {
      return { data: { success: false, error: "No archive path provided" } };
    }

    try {
      const resolvedArchive = path.resolve(archivePath);
      const resolvedSource = path.resolve(sourcePath || ".");

      if (action === "create") {
        if (process.platform === "win32") {
          await execFileAsync("powershell.exe", [
            "-NoProfile", "-Command",
            `Compress-Archive -Path '${resolvedSource}' -DestinationPath '${resolvedArchive}' -Force`,
          ], { timeout: 60000 });
        } else {
          const dir = path.dirname(resolvedSource);
          const base = path.basename(resolvedSource);
          await execFileAsync("zip", ["-r", resolvedArchive, base], { cwd: dir, timeout: 60000 });
        }
        return { data: { success: true, action, archivePath: resolvedArchive } };
      }

      // Extract
      const extractTo = resolvedSource || path.dirname(resolvedArchive);
      fs.mkdirSync(extractTo, { recursive: true });

      if (process.platform === "win32") {
        await execFileAsync("powershell.exe", [
          "-NoProfile", "-Command",
          `Expand-Archive -Path '${resolvedArchive}' -DestinationPath '${extractTo}' -Force`,
        ], { timeout: 60000 });
      } else {
        await execFileAsync("unzip", ["-o", resolvedArchive, "-d", extractTo], { timeout: 60000 });
      }
      return { data: { success: true, action, extractedTo: extractTo } };
    } catch (error) {
      return { data: { success: false, action, error: String(error) } };
    }
  },
};

const spawnCodingAgentHandler: NodeHandler = {
  type: "spawn-coding-agent",
  async execute(input, context) {
    const agent          = String(input.config.agentId ?? input.config.agent ?? "claude").toLowerCase();
    const mode           = String(input.config.mode           ?? "run");
    const permissionMode = String(input.config.permissionMode ?? "approve-reads");
    const taskTpl        = String(input.config.task           ?? input.config.taskTemplate ?? "");
    const task           = resolveTemplate(taskTpl || String(input.data.message ?? ""), context);
    const model          = input.config.model          ? String(input.config.model)          : null;
    const cwdCfg         = input.config.cwd            ? String(input.config.cwd)            : ".";
    const timeoutMs      = Math.min(Number(input.config.timeoutMs) || 120000, 300000);
    const maxBudget      = input.config.maxBudgetUsd   != null ? Number(input.config.maxBudgetUsd) : 0.10;
    const sysPrmt        = input.config.systemPrompt   ? String(input.config.systemPrompt)   : null;
    const label          = input.config.label          ? String(input.config.label)           : task.slice(0, 50);
    const wantWorktree   = Boolean(input.config.worktree);
    const cleanup        = String(input.config.cleanup ?? "keep");

    if (!task) {
      return { data: { ...input.data, error: "spawn-coding-agent: no task provided", success: false } };
    }

    // ── Disp8chTeam worktree isolation ──────────────────────────────────────────
    let effectiveCwd = path.resolve(cwdCfg);
    let worktreePath: string | null = null;
    if (wantWorktree) {
      const { randomUUID } = await import("node:crypto");
      const sessionUuid = randomUUID();
      const wtBranch = `disp8chteam/session/${sessionUuid}`;
      const wtPath = `/tmp/disp8ch-wt-${sessionUuid}`;
      try {
        await execFileAsync("git", ["worktree", "add", "-b", wtBranch, wtPath], { cwd: effectiveCwd, timeout: 15000 });
        worktreePath = wtPath;
        effectiveCwd = wtPath;
        log.info("spawn-coding-agent: worktree created", { wtPath, wtBranch });
      } catch (wtErr) {
        log.warn("spawn-coding-agent: worktree creation failed, falling back to cwd", { error: String(wtErr) });
      }
    }

    if (agent === "claude") {
      const { findClaudeBinary, incrementSpawnDepth, decrementSpawnDepth } =
        await import("@/lib/sessions/coding-agent-registry") as
          typeof import("@/lib/sessions/coding-agent-registry");
      const claudeBin = findClaudeBinary();

      const cliArgs: string[] = ["--print", "--output-format", "json"];
      if (mode === "session") {
        const { randomUUID } = await import("node:crypto");
        cliArgs.push("--session-id", randomUUID());
      }
      if (permissionMode === "approve-all") {
        cliArgs.push("--dangerously-skip-permissions");
      } else if (permissionMode === "deny-all") {
        cliArgs.push("--allowedTools", "Read,Glob,Grep,LS");
      }
      if (model)    cliArgs.push("--model", model);
      if (sysPrmt)  cliArgs.push("--append-system-prompt", sysPrmt);
      if (maxBudget > 0) cliArgs.push("--max-budget-usd", String(maxBudget));
      cliArgs.push(task);

      try {
        const thinkingTokens = input.config.thinking
          ? Math.max(1000, Math.min(Number(input.config.thinking), 100000))
          : 16000;
        incrementSpawnDepth();
        const env = { ...process.env, MAX_THINKING_TOKENS: String(thinkingTokens) };
        const { stdout } = await spawnAsync(claudeBin, cliArgs, {
          cwd: effectiveCwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env,
        });

        let response   = stdout.trim();
        let sessionId: string | undefined;

        try {
          const parsed = JSON.parse(stdout) as { result?: string; session_id?: string; is_error?: boolean };
          if (parsed.is_error) {
            return { data: { ...input.data, error: parsed.result ?? response, success: false, codingAgent: agent } };
          }
          response  = parsed.result   ?? response;
          sessionId = parsed.session_id ?? undefined;
        } catch { /* raw text */ }

        decrementSpawnDepth();
        if (sessionId && mode === "session") {
          const { registerCodingAgentSession } =
            await import("@/lib/sessions/coding-agent-registry") as
              typeof import("@/lib/sessions/coding-agent-registry");
          registerCodingAgentSession({
            sessionId, agent: "claude", label,
            createdAt: Date.now(), lastUsedAt: Date.now(),
            worktreePath: worktreePath ?? undefined,
          });
        } else if (worktreePath && cleanup === "delete") {
          try {
            await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: path.resolve(cwdCfg), timeout: 10000 });
          } catch { /* ignore */ }
        }

        const finalResponse = worktreePath
          ? `${response}\n[Worktree: ${worktreePath}] — agent ran in isolated git worktree (branch: disp8chteam/session/*).`
          : response;

        return {
          data: {
            ...input.data,
            response: finalResponse,
            agentResponse: finalResponse,
            sessionId,
            codingAgent: agent,
            permissionMode,
            worktreePath: worktreePath ?? undefined,
            success: true,
          },
        };
      } catch (err) {
        decrementSpawnDepth();
        // Cleanup worktree on error
        if (worktreePath) {
          try {
            await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: path.resolve(cwdCfg), timeout: 10000 });
          } catch { /* ignore */ }
        }
        const e = err as { stdout?: string; stderr?: string; message?: string };
        // Claude CLI may exit non-zero for budget/limit reasons but still produce valid JSON output
        if (e.stdout?.trim()) {
          try {
            const parsed = JSON.parse(e.stdout) as { result?: string; session_id?: string; is_error?: boolean; subtype?: string };
            if (!parsed.is_error && parsed.result != null) {
              const response = parsed.result;
              const sessionId = parsed.session_id;
              if (sessionId && mode === "session") {
                const { registerCodingAgentSession } =
                  await import("@/lib/sessions/coding-agent-registry") as
                    typeof import("@/lib/sessions/coding-agent-registry");
                registerCodingAgentSession({ sessionId, agent: "claude", label, createdAt: Date.now(), lastUsedAt: Date.now() });
              }
              return { data: { ...input.data, response, agentResponse: response, sessionId, codingAgent: agent, permissionMode, success: true, note: parsed.subtype } };
            }
          } catch { /* not valid JSON, fall through */ }
        }
        const errMsg = [e.stdout?.trim(), e.stderr?.trim(), e.message].filter(Boolean).join("\n");
        return { data: { ...input.data, error: errMsg, success: false, codingAgent: agent } };
      }
    }

    if (agent === "gemini") {
      try {
        const { incrementSpawnDepth, decrementSpawnDepth } =
          await import("@/lib/sessions/coding-agent-registry") as
            typeof import("@/lib/sessions/coding-agent-registry");
        incrementSpawnDepth();
        const { stdout } = await execFileAsync("gemini", ["--prompt", task], {
          cwd: path.resolve(cwdCfg), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
        });
        decrementSpawnDepth();
        return { data: { ...input.data, response: stdout.trim(), agentResponse: stdout.trim(), codingAgent: agent, success: true } };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        return { data: { ...input.data, error: [e.stderr?.trim(), e.message].filter(Boolean).join("\n"), success: false, codingAgent: agent } };
      }
    }

    if (agent === "codex") {
      try {
        const { incrementSpawnDepth, decrementSpawnDepth } =
          await import("@/lib/sessions/coding-agent-registry") as
            typeof import("@/lib/sessions/coding-agent-registry");
        incrementSpawnDepth();
        const { stdout } = await execFileAsync("codex", ["--query", task, "--full-auto"], {
          cwd: path.resolve(cwdCfg), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
        });
        decrementSpawnDepth();
        return { data: { ...input.data, response: stdout.trim(), agentResponse: stdout.trim(), codingAgent: agent, success: true } };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        return { data: { ...input.data, error: [e.stderr?.trim(), e.message].filter(Boolean).join("\n"), success: false, codingAgent: agent } };
      }
    }

    return { data: { ...input.data, error: `Unsupported agent: ${agent}`, success: false } };
  },
};

// Placeholder — used for unsupported imported node types from compatible workflow imports.
const placeholderHandler: NodeHandler = {
  type: "placeholder",
  async execute(input) {
    const originalType = (input.config.originalType as string) || "unknown";
    log.warn("placeholder node executed — passthrough", { originalType });
    return { data: { ...input.data, _placeholder: true, originalType } };
  },
};

const stickyNoteHandler: NodeHandler = {
  type: "sticky-note",
  async execute(input) {
    return {
      data: {
        ...input.data,
        _note: String(input.config.note || input.config.content || "").trim(),
      },
    };
  },
};

const handlers = new Map<string, NodeHandler>();

[
  manualTriggerHandler,
  messageTriggerHandler,
  webhookTriggerHandler,
  cronTriggerHandler,
  telegramTriggerHandler,
  discordTriggerHandler,
  claudeAgentHandler,
  integrationAgentHandler,
  parallelAgentsHandler,
  spawnCodingAgentHandler,
  callWorkflowHandler,
  sendWebchatHandler,
  webhookResponseHandler,
  sendWhatsappHandler,
  sendTelegramHandler,
  sendDiscordHandler,
  sendEmailHandler,
  sendSmsHandler,
  sendSlackHandler,
  sendBlueBubblesHandler,
  sendTeamsHandler,
  githubTriggerHandler,
  githubCommentHandler,
  ifElseHandler,
  switchHandler,
  delayHandler,
  setVariablesHandler,
  filterHandler,
  memoryRecallHandler,
  memoryStoreHandler,
  systemCommandHandler,
  httpRequestHandler,
  rssReadHandler,
  googleSheetsHandler,
  notionHandler,
  airtableHandler,
  runCodeHandler,
  readFileHandler,
  writeFileHandler,
  boardTaskHandler,
  documentToolHandler,
  workflowTemplateHandler,
  schedulerJobHandler,
  voiceSttHandler,
  voiceTtsHandler,
  // New nodes
  loopHandler,
  aggregateHandler,
  mergeHandler,
  errorHandlerNode,
  waitForInputHandler,
  jsonTransformHandler,
  splitTextHandler,
  regexExtractHandler,
  compareTextHandler,
  rateLimiterHandler,
  databaseQueryHandler,
  clipboardHandler,
  notificationHandler,
  gitOperationHandler,
  archiveHandler,
  dateTimeHandler,
  channelStatusHandler,
  councilHandler,
  placeholderHandler,
  stickyNoteHandler,
].forEach((h) => handlers.set(h.type, h));

export function getNodeHandler(type: string): NodeHandler | undefined {
  return handlers.get(type);
}

/**
 * Register (or override) a node handler at runtime. Used by extension-provided
 * node types and by regression tests that need deterministic custom nodes.
 */
export function registerNodeHandler(handler: NodeHandler): void {
  handlers.set(handler.type, handler);
}
