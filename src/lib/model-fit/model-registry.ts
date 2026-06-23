/**
 * Legacy local-model registry used by the compatibility recommendation helper.
 * The production catalog is bundled with the application release. It never
 * fetches a remote model list at runtime.
 */

export type ModelTask = "coding" | "chat" | "reasoning" | "vision" | "general";

export type RegistryModel = {
  id: string;
  name: string;
  paramsB: number;
  /** Recommended default quantization. */
  quant: string;
  /** Transformer block count, when known (improves partial-offload accuracy). */
  layers?: number;
  contextDefault: number;
  /** Curated 0-100 quality signal for ranking within a fit class. */
  quality: number;
  tasks: ModelTask[];
  /** Ollama tag, when available. */
  ollama?: string;
  /** Direct GGUF URL for llama.cpp, when available. */
  ggufUrl?: string;
  /** HF repo for MLX (Apple Silicon), when available. */
  mlx?: string;
  family?: string;
  license?: string;
};

export type ModelRegistry = {
  version: number;
  updatedAt: string;
  source: "bundled";
  models: RegistryModel[];
};

/** Compatibility list bundled with the application. */
export const BUNDLED_REGISTRY: ModelRegistry = {
  version: 1,
  updatedAt: "2026-06-22",
  source: "bundled",
  models: [
    { id: "qwen2.5-coder-32b", name: "Qwen2.5 Coder 32B", paramsB: 32, quant: "q4_k_m", contextDefault: 32768, quality: 92, tasks: ["coding", "reasoning"], ollama: "qwen2.5-coder:32b", family: "qwen", license: "apache-2.0" },
    { id: "qwen2.5-coder-14b", name: "Qwen2.5 Coder 14B", paramsB: 14, quant: "q4_k_m", contextDefault: 32768, quality: 86, tasks: ["coding", "reasoning"], ollama: "qwen2.5-coder:14b", family: "qwen", license: "apache-2.0" },
    { id: "qwen2.5-coder-7b", name: "Qwen2.5 Coder 7B", paramsB: 7, quant: "q4_k_m", contextDefault: 32768, quality: 78, tasks: ["coding", "chat"], ollama: "qwen2.5-coder:7b", family: "qwen", license: "apache-2.0" },
    { id: "qwen2.5-3b", name: "Qwen2.5 3B", paramsB: 3, quant: "q4_k_m", contextDefault: 32768, quality: 64, tasks: ["chat", "general"], ollama: "qwen2.5:3b", family: "qwen", license: "qwen" },
    { id: "llama3.1-8b", name: "Llama 3.1 8B", paramsB: 8, quant: "q4_k_m", contextDefault: 8192, quality: 76, tasks: ["chat", "general", "reasoning"], ollama: "llama3.1:8b", family: "llama", license: "llama3.1" },
    { id: "llama3.2-3b", name: "Llama 3.2 3B", paramsB: 3, quant: "q4_k_m", contextDefault: 8192, quality: 62, tasks: ["chat", "general"], ollama: "llama3.2:3b", family: "llama", license: "llama3.2" },
    { id: "mistral-7b", name: "Mistral 7B Instruct", paramsB: 7, quant: "q4_k_m", contextDefault: 8192, quality: 72, tasks: ["chat", "general"], ollama: "mistral:7b", family: "mistral", license: "apache-2.0" },
    { id: "gemma2-9b", name: "Gemma 2 9B", paramsB: 9, quant: "q4_k_m", contextDefault: 8192, quality: 77, tasks: ["chat", "reasoning"], ollama: "gemma2:9b", family: "gemma", license: "gemma" },
    { id: "phi3.5-mini", name: "Phi 3.5 Mini", paramsB: 3.8, quant: "q4_k_m", contextDefault: 16384, quality: 66, tasks: ["chat", "reasoning", "general"], ollama: "phi3.5:3.8b", family: "phi", license: "mit" },
    { id: "llava-7b", name: "LLaVA 7B (vision)", paramsB: 7, quant: "q4_k_m", contextDefault: 4096, quality: 68, tasks: ["vision", "chat"], ollama: "llava:7b", family: "llava", license: "apache-2.0" },
    { id: "qwen2.5-0.5b", name: "Qwen2.5 0.5B", paramsB: 0.5, quant: "q4_k_m", contextDefault: 32768, quality: 40, tasks: ["chat", "general"], ollama: "qwen2.5:0.5b", family: "qwen", license: "apache-2.0" },
  ],
};

/**
 * Compatibility loader. Options remain accepted so older callers do not break,
 * but they are deliberately ignored: the registry is static for this release.
 */
export async function loadModelRegistry(options?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  force?: boolean;
}): Promise<ModelRegistry> {
  void options;
  return BUNDLED_REGISTRY;
}
