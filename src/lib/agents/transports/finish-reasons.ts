import type { NormalizedToolCall, NormalizedProviderResponse } from "@/lib/agents/transports/types";

export function normalizeFinishReason(raw: string, provider: string): NormalizedProviderResponse["finishReason"] {
  const lower = raw.toLowerCase();
  if (!lower || lower === "none") return "stop";

  switch (provider) {
    case "anthropic":
      if (lower === "end_turn") return "stop";
      if (lower === "max_tokens") return "length";
      if (lower === "tool_use") return "tool_calls";
      return "stop";
    case "google":
      if (lower === "stop" || lower === "finish_reason_unspecified") return "stop";
      if (lower === "max_tokens") return "length";
      return "stop";
    case "openai":
    case "openai-compatible":
      if (lower === "tool_calls" || lower === "function_call") return "tool_calls";
      if (lower === "stop") return "stop";
      if (lower === "length") return "length";
      if (lower === "content_filter") return "content_filter";
      return "stop";
    default:
      if (lower.includes("tool") || lower.includes("function")) return "tool_calls";
      if (lower.includes("length") || lower.includes("max")) return "length";
      if (lower.includes("filter") || lower.includes("content")) return "content_filter";
      return "stop";
  }
}

export function normalizeToolCalls(
  rawCalls: Array<{ id?: string; name?: string; function?: { name?: string; arguments?: string } }>,
  provider: string,
): NormalizedToolCall[] {
  return rawCalls.map((call, index) => ({
    id: call.id ?? `tool_${Date.now()}_${index}`,
    name: call.function?.name ?? call.name ?? "unknown",
    argumentsText: call.function?.arguments ?? "{}",
    providerData: { raw: call },
  }));
}
