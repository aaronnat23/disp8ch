import type { ModelProvider } from "@/types/model";
import { callWithTools } from "@/lib/agents/tool-caller";
import type { ToolDefinition } from "@/lib/engine/tools";
import type { ModelLedLane } from "@/lib/channels/model-led-context";
import type { UniversalAgenticSafety } from "@/lib/channels/universal-agentic-runtime";
import type { CodeEditDossier, CommandEvidenceKind } from "@/lib/channels/code-edit-dossier";
import { summarizeCodeEditDossierForPrompt } from "@/lib/channels/code-edit-dossier";
import type { VerificationContract } from "@/lib/channels/code-edit-verification-contract";
import {
  summarizeMissingRequiredProbeExecutionGuide,
  summarizeVerificationContractForPrompt,
} from "@/lib/channels/code-edit-verification-contract";
import { classifyCodeEditCommandEvidence } from "@/lib/channels/code-edit-command-evidence";

export type FreshVerifierVerdict = "pass" | "fail" | "partial" | "skipped";

export type FreshVerifierResult = {
  verdict: FreshVerifierVerdict;
  reason: string;
  commandsRun: Array<{
    command: string;
    kind: CommandEvidenceKind;
    ok: boolean;
    preview: string;
  }>;
  probesSatisfied: string[];
  probesMissing: string[];
  foundIssues: string[];
  tokensUsed: number;
  toolsUsed: string[];
};

const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "workflow_create",
  "workflow_update_node",
  "workflow_delete",
  "workflow_run",
  "memory_store",
  "webhook_create",
  "webhook_update",
  "webhook_delete",
  "design_artifact_create",
  "design_artifact_patch",
  "design_artifact_save_version",
]);

function filterVerifierTools(tools: ToolDefinition[], safety: UniversalAgenticSafety): ToolDefinition[] {
  const allowed = new Set([
    "read_file",
    "search_files",
    "list_files",
    "bash_exec",
    "run_python",
    "run_python_script",
    "browser_navigate",
    "browser_get_text",
    "browser_snapshot",
    "browser_console",
    "http_request",
  ]);
  return tools.filter((tool) => {
    if (MUTATING_TOOLS.has(tool.name)) return false;
    if (!allowed.has(tool.name)) return false;
    if ((tool.name === "bash_exec" || tool.name.startsWith("run_python")) && !safety.allowShell) return false;
    return true;
  });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*({[\s\S]*?})\s*```/i);
  const candidate = fenced?.[1] ?? trimmed.match(/({[\s\S]*})/)?.[1];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 20) : [];
}

function normalizeVerdict(value: unknown): FreshVerifierVerdict {
  const text = String(value || "").toLowerCase();
  if (text === "pass" || text === "fail" || text === "partial") return text;
  return "partial";
}

export async function runFreshCodeEditVerifier(input: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  originalRequest: string;
  currentAnswer: string;
  codeEditDossier: CodeEditDossier;
  contract: VerificationContract;
  tools: ToolDefinition[];
  modelLedLane: ModelLedLane;
  workspacePath?: string;
  deadlineMs: number;
  maxToolCalls: number;
  maxTokens: number;
  safety: UniversalAgenticSafety;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, output: string) => void;
}): Promise<FreshVerifierResult> {
  if (input.deadlineMs < 20_000 || input.maxToolCalls <= 0) {
    return {
      verdict: "skipped",
      reason: "insufficient remaining verifier budget",
      commandsRun: [],
      probesSatisfied: [],
      probesMissing: input.contract.probes.filter((probe) => !probe.satisfied).map((probe) => probe.id),
      foundIssues: [],
      tokensUsed: 0,
      toolsUsed: [],
    };
  }
  const verifierTools = filterVerifierTools(input.tools, input.safety);
  if (verifierTools.length === 0) {
    return {
      verdict: "skipped",
      reason: "no safe read-only verification tools available",
      commandsRun: [],
      probesSatisfied: [],
      probesMissing: input.contract.probes.filter((probe) => !probe.satisfied).map((probe) => probe.id),
      foundIssues: [],
      tokensUsed: 0,
      toolsUsed: [],
    };
  }

  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolResults: Array<{ name: string; ok: boolean; output: string; args: Record<string, unknown> }> = [];
  const pending = new Map<string, Record<string, unknown>[]>();
  const onToolCall = (name: string, args: Record<string, unknown>) => {
    const queue = pending.get(name) ?? [];
    queue.push(args ?? {});
    pending.set(name, queue);
    toolCalls.push({ name, args });
    input.onToolCall?.(name, args);
  };
  const onToolResult = (name: string, ok: boolean, output: string) => {
    const queue = pending.get(name) ?? [];
    const args = queue.shift() ?? {};
    if (queue.length > 0) pending.set(name, queue);
    else pending.delete(name);
    toolResults.push({ name, ok, output, args });
    input.onToolResult?.(name, ok, output);
  };

  const systemPrompt = [
    "You are a code-edit verification specialist.",
    "Verify only. Do not create, edit, or delete project files.",
    "Use available tools to prove whether the changed behavior satisfies the verification contract.",
    "Reading code is useful context but is not a PASS by itself.",
    "For every missing required probe, run an artifact-linked behavior check when a safe shell or test tool is available.",
    "Artifact-linked means the command imports, executes, requests, or renders the changed file/route/component/API. Do not copy the implementation into a standalone test.",
    "Prefer one compact inline behavior probe that covers multiple required edge cases, or the smallest relevant existing test/typecheck.",
    "Do not print secrets. Do not run destructive commands.",
    "Return JSON only with verdict, reason, commandsRun, probesSatisfied, probesMissing, and foundIssues.",
  ].join("\n");

  const userMessage = [
    `Original request:\n${input.originalRequest}`,
    `Current answer draft:\n${input.currentAnswer.slice(0, 2500)}`,
    `Code edit dossier:\n${summarizeCodeEditDossierForPrompt(input.codeEditDossier, { maxChars: 2600 })}`,
    `Verification contract:\n${summarizeVerificationContractForPrompt(input.contract, { maxChars: 2000 })}`,
    summarizeMissingRequiredProbeExecutionGuide(input.contract, { maxChars: 1600 }),
    "Run only non-destructive checks. If you cannot verify because tools or environment are missing, return partial and say exactly why.",
    "If an assertion fails, verdict must be fail and foundIssues must name the failed rule. If a required probe is not checked, verdict must be partial and probesMissing must include it.",
    "JSON shape: {\"verdict\":\"pass|fail|partial\",\"reason\":\"...\",\"commandsRun\":[{\"command\":\"...\",\"kind\":\"behavior_probe|unit_test|typecheck|lint|build|api_probe|browser_probe|unknown\",\"ok\":true,\"preview\":\"...\"}],\"probesSatisfied\":[\"...\"],\"probesMissing\":[\"...\"],\"foundIssues\":[\"...\"]}",
  ].join("\n\n");

  const result = await callWithTools({
    provider: input.provider as ModelProvider,
    modelId: input.modelId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    systemPrompt,
    userMessage,
    maxTokens: Math.min(input.maxTokens, 3000),
    temperature: 0.05,
    tools: verifierTools,
    maxToolCalls: Math.min(input.maxToolCalls, input.contract.minimumEvidence.requiresFreshVerifier ? 6 : 4),
    readOnly: true,
    requireToolUse: true,
    modelLedLane: input.modelLedLane,
    accuracyMode: "thorough",
    maxExpandedToolBudget: Math.min(input.maxToolCalls, 6),
    workspacePath: input.workspacePath,
    evidenceMode: undefined,
    toolPolicy: { approvalMode: "off" },
    turnDeadlineMs: Math.min(input.deadlineMs, 90_000),
    onToolCall,
    onToolResult,
  });

  const parsed = parseJsonObject(result.response);
  const commandsRun = (Array.isArray(parsed?.commandsRun) ? parsed.commandsRun : []).map((item) => {
    const obj = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const command = String(obj.command || "");
    const classified = classifyCodeEditCommandEvidence({
      toolName: "fresh_verifier",
      commandOrSummary: command,
      outputPreview: String(obj.preview || ""),
      ok: obj.ok !== false,
      changedFiles: input.codeEditDossier.changedFiles,
    });
    return {
      command,
      kind: (String(obj.kind || classified.kind) as CommandEvidenceKind),
      ok: obj.ok !== false,
      preview: String(obj.preview || "").slice(0, 800),
    };
  });
  const inferredCommands = commandsRun.length > 0 ? commandsRun : toolResults.map((item) => {
    const command = typeof item.args.command === "string"
      ? item.args.command
      : typeof item.args.code === "string"
        ? item.args.code
        : JSON.stringify(item.args).slice(0, 500);
    const classified = classifyCodeEditCommandEvidence({
      toolName: item.name,
      commandOrSummary: command,
      outputPreview: item.output,
      ok: item.ok,
      changedFiles: input.codeEditDossier.changedFiles,
    });
    return {
      command,
      kind: classified.kind,
      ok: classified.ok,
      preview: classified.preview,
    };
  });

  return {
    verdict: normalizeVerdict(parsed?.verdict),
    reason: String(parsed?.reason || result.response || "fresh verifier returned no structured reason").slice(0, 1000),
    commandsRun: inferredCommands,
    probesSatisfied: asStringArray(parsed?.probesSatisfied),
    probesMissing: asStringArray(parsed?.probesMissing),
    foundIssues: asStringArray(parsed?.foundIssues),
    tokensUsed: result.tokensUsed,
    toolsUsed: result.toolsUsed,
  };
}
