import { normalizeProviderBaseUrl, resolveProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { getProviderPlaceholderApiKey } from "@/lib/agents/provider-plugins";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";

interface OpenAICompatibleModelsResponse {
  data?: Array<{ id?: string }>;
}

export async function discoverOpenAICompatibleModelIds(params: {
  provider: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}): Promise<string[]> {
  const normalizedProvider = normalizeProviderId(params.provider) ?? params.provider.trim().toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 3000);

  try {
    const baseUrl =
      normalizeProviderBaseUrl(normalizedProvider, params.baseUrl) ??
      resolveProviderBaseUrl(normalizedProvider);
    if (!baseUrl) return [];

    const apiKey =
      String(params.apiKey ?? "").trim() || getProviderPlaceholderApiKey(normalizedProvider) || "";
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as OpenAICompatibleModelsResponse;
    return Array.from(
      new Set(
        (data.data ?? [])
          .map((entry) => String(entry.id ?? "").trim())
          .filter(Boolean),
      ),
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
