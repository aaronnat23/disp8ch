import { callModel } from "@/lib/agents/multi-provider";
import { executeTool } from "@/lib/engine/tools";
import type { ModelProvider } from "@/types/model";

export function extractNativeWindowHint(message: string): string | null {
  const text = String(message || "");
  const quoted = text.match(/\b(?:window|dialog|application|app)\s+(?:titled|named|called)\s+["']([^"'\r\n]{1,160})["']/i);
  if (quoted?.[1]) return quoted[1].trim();
  const explicit = text.match(/\bapp_hint\s*=\s*["']?([^,"'\r\n]{1,160})/i);
  return explicit?.[1]?.trim() || null;
}

export function shouldUseNativeObservationFastPath(input: {
  message: string;
  mode: string;
  safetyBoundary?: unknown;
  toolsForbidden?: boolean;
}): boolean {
  if (input.mode !== "computer_use" || input.toolsForbidden) return false;
  if (input.safetyBoundary !== "proposal_only") return false;
  if (!extractNativeWindowHint(input.message)) return false;
  const mentionsMutation = /\b(?:click|type|enter|submit|launch|focus|scroll|drag|press|change|set|delete|send)\b/i.test(input.message);
  const explicitlyReadOnly = /\b(?:read[- ]only|do not|don't|dont|without (?:clicking|typing|changing|interacting))\b/i.test(input.message);
  if (mentionsMutation && !explicitlyReadOnly) return false;
  return /\b(?:inspect|observe|read|report|show|heading|status|text|what)\b/i.test(input.message);
}

export function compactNativeObservationForModel(output: string, maxChars = 5_000): string {
  try {
    const parsed = JSON.parse(output) as { success?: boolean; status?: string; detail?: unknown };
    const detail = String(parsed.detail || "");
    const readableTree = detail.split(/\n\{\"mode\":/)[0].trim();
    return JSON.stringify({
      success: parsed.success === true,
      status: parsed.status || "unknown",
      observation: readableTree.slice(0, maxChars),
    });
  } catch {
    return output.slice(0, maxChars);
  }
}

export async function runNativeObservationFastPath(input: {
  message: string;
  sessionId: string;
  agentId: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  workspacePath?: string | null;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, output: string) => void;
}): Promise<{ answer: string; tokensUsed: number; metadata: Record<string, unknown> } | null> {
  const windowHint = extractNativeWindowHint(input.message);
  if (!windowHint) return null;
  const args = { app_hint: windowHint, mode: "som", max_elements: 160, max_depth: 20 };
  input.onToolCall?.("computer_observe", args);
  const output = await executeTool(
    "computer_observe",
    args,
    {
      agentId: input.agentId,
      channelSessionId: input.sessionId,
      workspacePath: input.workspacePath ?? undefined,
      readOnly: true,
    },
    { approvalMode: "off" },
  );
  let ok = false;
  try {
    const parsed = JSON.parse(output) as { success?: boolean };
    ok = parsed.success === true;
  } catch {
    ok = false;
  }
  input.onToolResult?.("computer_observe", ok, output);

  const result = await callModel({
    provider: input.provider as ModelProvider,
    modelId: input.modelId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    systemPrompt: [
      "Answer a read-only native-window inspection from the supplied computer_observe result.",
      "Use only the tool result. Never substitute the foreground browser or another app for the explicitly targeted window.",
      "Answer in at most six short lines. State the requested result first, then direct UI evidence and one important unknown if needed.",
      "Do not add repository paths, commands, recommendations, generic risk sections, or internal routing details.",
      "If the tool failed, report the failure plainly. Do not claim that anything was clicked, typed, focused, or changed.",
    ].join("\n"),
    userMessage: `User request:\n${input.message}\n\ncomputer_observe result:\n${compactNativeObservationForModel(output)}`,
    maxTokens: 900,
    temperature: 0.1,
  });
  return {
    answer: result.response.trim(),
    tokensUsed: result.tokensUsed,
    metadata: {
      nativeObservationFastPath: true,
      windowHint,
      toolResultOk: ok,
      provider: result.provider ?? input.provider,
      modelId: result.modelId ?? input.modelId,
    },
  };
}
