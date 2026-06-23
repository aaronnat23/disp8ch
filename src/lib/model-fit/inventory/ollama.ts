import type { OllamaInstalledModel } from "./types";

/**
 * Query a local Ollama service for INSTALLED models only. /api/tags is
 * authoritative for what is installed (never for what is downloadable). Tags are
 * returned exactly as Ollama reports them — never manufactured.
 */
export async function fetchOllamaInventory(options?: {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ serviceUp: boolean; models: OllamaInstalledModel[] }> {
  const endpoint = (options?.endpoint || "http://127.0.0.1:11434").replace(/\/$/, "");
  const doFetch = options?.fetchImpl || fetch;
  const timeoutMs = options?.timeoutMs ?? 2500;

  const get = async (pathname: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${endpoint}${pathname}`, { ...init, signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const tags = await get("/api/tags");
  if (!tags || !Array.isArray(tags.models)) return { serviceUp: false, models: [] };

  const models: OllamaInstalledModel[] = [];
  for (const raw of tags.models as Array<Record<string, unknown>>) {
    const tag = String(raw.name ?? "");
    if (!tag) continue;
    const details = (raw.details as Record<string, unknown>) || {};
    let contextLength: number | null = null;
    let capabilities: string[] = [];
    const show = await get("/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: tag }) });
    if (show) {
      const info = (show.model_info as Record<string, unknown>) || {};
      for (const [k, v] of Object.entries(info)) {
        if (/\.context_length$/.test(k) && typeof v === "number") contextLength = v;
      }
      if (Array.isArray(show.capabilities)) capabilities = (show.capabilities as unknown[]).map(String);
    }
    models.push({
      tag,
      sizeBytes: Number(raw.size) || 0,
      family: (details.family as string) || null,
      parameterSize: (details.parameter_size as string) || null,
      quantization: (details.quantization_level as string) || null,
      contextLength,
      capabilities,
    });
  }
  return { serviceUp: true, models };
}
