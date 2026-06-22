import { normalizeProviderBaseUrl } from "./provider-base-url";

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
}

export interface OllamaModelDetail {
  id: string;
  contextWindow: number | null;
  isReasoning: boolean;
}

function resolveOllamaNativeBaseUrl(baseUrl?: string | null): string {
  const normalized = normalizeProviderBaseUrl("ollama", baseUrl) || "http://localhost:11434/v1";
  return normalized.replace(/\/v1$/i, "");
}

const REASONING_PATTERN = /r1|reasoning|think|reason/i;

/**
 * Detect whether a model ID looks like a reasoning/chain-of-thought model.
 * Heuristic for common reasoning-model labels — matches "r1", "reasoning", "think", "reason".
 */
export function isReasoningModelHeuristic(modelId: string): boolean {
  return REASONING_PATTERN.test(modelId);
}

export async function discoverOllamaModelIds(
  baseUrl?: string | null,
  timeoutMs = 3000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const nativeBase = resolveOllamaNativeBaseUrl(baseUrl);
    const response = await fetch(`${nativeBase}/api/tags`, { signal: controller.signal });
    if (!response.ok) return [];
    const data = (await response.json()) as OllamaTagsResponse;
    const names = (data.models ?? [])
      .map((m) => String(m.name ?? "").trim())
      .filter(Boolean);
    return Array.from(new Set(names));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch per-model context window from Ollama's `/api/show` endpoint.
 * Looks for keys ending with `.context_length` in the model_info object
 * (e.g. `llama.context_length`). Returns null on any failure.
 */
export async function getOllamaModelContextWindow(
  modelId: string,
  baseUrl?: string | null,
  timeoutMs = 5000,
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const nativeBase = resolveOllamaNativeBaseUrl(baseUrl);
    const response = await fetch(`${nativeBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelId }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as OllamaShowResponse;
    if (!data.model_info) return null;
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
        return value;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover Ollama models with their context windows.
 * Calls /api/tags then /api/show for each model (limited concurrency).
 */
export async function discoverOllamaModelsWithDetails(
  baseUrl?: string | null,
  options?: { timeoutMs?: number; maxModels?: number; concurrency?: number },
): Promise<OllamaModelDetail[]> {
  const modelIds = await discoverOllamaModelIds(baseUrl, options?.timeoutMs ?? 3000);
  const capped = modelIds.slice(0, options?.maxModels ?? 200);
  const concurrency = options?.concurrency ?? 8;
  const results: OllamaModelDetail[] = [];

  for (let i = 0; i < capped.length; i += concurrency) {
    const batch = capped.slice(i, i + concurrency);
    const details = await Promise.all(
      batch.map(async (id) => {
        const contextWindow = await getOllamaModelContextWindow(id, baseUrl, options?.timeoutMs ?? 5000);
        return {
          id,
          contextWindow,
          isReasoning: isReasoningModelHeuristic(id),
        };
      }),
    );
    results.push(...details);
  }

  return results;
}
