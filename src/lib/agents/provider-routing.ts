import { normalizeProviderId } from "@/lib/agents/provider-normalization";

export type ProviderApiMode =
  | "anthropic"
  | "google"
  | "openai-chat"
  | "openai-responses";

export function normalizeProviderScopedModelId(provider: string, modelId: string): string {
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;

  const prefixes = [normalizedProvider];
  if (normalizedProvider === "opencode") {
    prefixes.push("opencode-zen");
  }

  for (const prefix of prefixes) {
    const marker = `${prefix}/`;
    if (trimmed.toLowerCase().startsWith(marker)) {
      return trimmed.slice(marker.length);
    }
  }

  return trimmed;
}

export function resolveProviderApiMode(provider: string, modelId: string): ProviderApiMode | null {
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const scopedModelId = normalizeProviderScopedModelId(normalizedProvider, modelId).toLowerCase();

  if (normalizedProvider === "google" || normalizedProvider === "google-gemini-cli") {
    return "google";
  }

  if (normalizedProvider === "opencode-go") {
    if (scopedModelId.startsWith("minimax-")) return "anthropic";
    return "openai-chat";
  }

  if (normalizedProvider === "openai") {
    if (
      scopedModelId.startsWith("gpt-5") ||
      scopedModelId.startsWith("o1") ||
      scopedModelId.startsWith("o3") ||
      scopedModelId.startsWith("codex")
    ) {
      return "openai-responses";
    }
    return "openai-chat";
  }

  if (normalizedProvider === "opencode") {
    if (scopedModelId.startsWith("claude-") || scopedModelId.startsWith("minimax-")) {
      return "anthropic";
    }
    if (scopedModelId.startsWith("gemini-")) return "google";
    if (
      scopedModelId.startsWith("gpt-") ||
      scopedModelId.startsWith("o1") ||
      scopedModelId.startsWith("o3") ||
      scopedModelId.startsWith("codex")
    ) {
      return "openai-responses";
    }
    return "openai-chat";
  }

  return null;
}
