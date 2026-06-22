import { getProviderPlugin } from "@/lib/agents/provider-plugins";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function normalizeProviderBaseUrl(provider: string, baseUrl?: string | null): string | undefined {
  if (!baseUrl) return undefined;
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const trimmed = trimUrl(baseUrl);
  if (!trimmed) return undefined;

  if (
    normalizedProvider === "ollama" ||
    normalizedProvider === "vllm" ||
    normalizedProvider === "sglang" ||
    normalizedProvider === "lmstudio" ||
    normalizedProvider === "openai-compatible" ||
    normalizedProvider === "qwen" ||
    normalizedProvider === "qwen-oauth"
  ) {
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }

  return trimmed;
}

export function getProviderDefaultBaseUrl(provider: string): string | undefined {
  const normalizedProvider = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  const raw = getProviderPlugin(normalizedProvider)?.baseUrl;
  if (!raw) return undefined;
  return normalizeProviderBaseUrl(normalizedProvider, raw);
}

export function resolveProviderBaseUrl(provider: string, baseUrl?: string | null): string | undefined {
  return normalizeProviderBaseUrl(provider, baseUrl) ?? getProviderDefaultBaseUrl(provider);
}
