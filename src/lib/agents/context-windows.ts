/**
 * Per-model context window sizes (in tokens).
 * Used by the compaction logic in tool-caller.ts to pick accurate limits
 * rather than relying on the single global app_config.context_window value.
 *
 * Sizes as of early 2026 — check provider docs for updates.
 */

const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-1":       200_000,
  "claude-opus-4-6":       200_000,
  "claude-opus-4":         200_000,
  "claude-sonnet-4-5":     200_000,
  "claude-sonnet-4-0":     200_000,
  "claude-sonnet-4-6":     200_000,
  "claude-sonnet-4":       200_000,
  "claude-haiku-4-5":      200_000,
  "claude-haiku-4":        200_000,
  "claude-3-5-sonnet":     200_000,
  "claude-3-5-haiku":      200_000,
  "claude-3-opus":         200_000,
  "claude-3-sonnet":       200_000,
  "claude-3-haiku":        200_000,
  // OpenAI
  "gpt-5.5":               400_000,
  "gpt-5.5-pro":           400_000,
  "gpt-5.4":               400_000,
  "gpt-5.4-pro":           400_000,
  "gpt-5":                 400_000,
  "gpt-5-mini":            400_000,
  "gpt-4o":                128_000,
  "gpt-4o-mini":           128_000,
  "gpt-4-turbo":           128_000,
  "gpt-4":                   8_192,
  "gpt-3.5-turbo":          16_385,
  "o1":                    200_000,
  "o1-mini":               128_000,
  "o3-mini":               200_000,
  "o4-mini":               200_000,
  // Google Gemini
  "gemini-3-flash-preview": 1_048_576,
  "gemini-3-pro-preview":   1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-flash-latest":    1_048_576,
  "gemini-pro-latest":      1_048_576,
  "gemini-2.0-flash":    1_048_576,
  "gemini-2.5-flash":    1_048_576,
  "gemini-2.5-pro":      1_048_576,
  "gemini-1.5-pro":      2_097_152,
  "gemini-1.5-flash":    1_048_576,
  "gemini-1.0-pro":         30_720,
  // Groq / Meta Llama
  "openai/gpt-oss-120b":     131_072,
  "qwen/qwen3-32b":          131_072,
  "qwen/qwen3.6":            131_072,
  "qwen/qwen3.6-plus":       131_072,
  "moonshotai/kimi-k2-instruct-0905": 131_072,
  "moonshotai/kimi-k2.6":    256_000,
  "llama-3.3-70b-versatile": 128_000,
  "llama-3.1-70b-versatile": 131_072,
  "llama-3.1-8b-instant":    131_072,
  "mixtral-8x7b-32768":       32_768,
  // DeepSeek
  "deepseek-v4-pro":       1_000_000,
  "deepseek-v4-flash":     1_000_000,
  "deepseek-chat":          64_000,
  "deepseek-reasoner":      64_000,
  // Mistral
  "mistral-medium-latest": 131_072,
  "mistral-large-latest":  131_072,
  "mistral-small-latest":  131_072,
  "ministral-8b-latest":   131_072,
  "mistral-nemo":          131_072,
  // xAI / Grok
  "grok-4-fast-reasoning": 2_000_000,
  "grok-4-fast-non-reasoning": 2_000_000,
  "grok-4-1-fast":         2_000_000,
  "grok-4-fast":           2_000_000,
  "grok-3":                131_072,
  "grok-3-mini":           131_072,
  "grok-2":                131_072,
  // Moonshot / Kimi
  "kimi-k2.6":             256_000,
  "kimi-k2-turbo-preview": 131_072,
  "kimi-k2.5":             256_000,
  "kimi-k2-0711-preview":  131_072,
  // Qwen / DashScope
  "qwen3.6":               131_072,
  "qwen3.6-plus":          131_072,
  "qwen3.6-plus-preview":  131_072,
  // Zhipu / GLM
  "glm-5":                 128_000,
  "glm-4.7":               128_000,
  "glm-4.5":               128_000,
  "glm-4-flash":           128_000,
  "glm-4-plus":            128_000,
};

/** Strip date suffixes like -20250514 for lookup normalization. */
function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/-\d{8}(-\d+)?$/, "");
}

/**
 * Dynamic context window overrides (populated at runtime from Ollama /api/show
 * or other local provider discovery). These take precedence over the static map.
 */
const dynamicContextWindows: Record<string, number> = {};

/**
 * Register a dynamically discovered context window (e.g. from Ollama /api/show).
 * Overrides the static registry for this model ID.
 */
export function registerDynamicContextWindow(modelId: string, contextWindow: number): void {
  if (!modelId || contextWindow <= 0) return;
  dynamicContextWindows[normalizeModelId(modelId)] = contextWindow;
}

/**
 * Bulk-register context windows (e.g. after Ollama model discovery with details).
 */
export function registerDynamicContextWindows(entries: Array<{ modelId: string; contextWindow: number }>): void {
  for (const entry of entries) {
    registerDynamicContextWindow(entry.modelId, entry.contextWindow);
  }
}

/**
 * Return the context window size for a model ID.
 * Checks dynamic overrides first, then static registry.
 * Tries exact match first, then prefix matching (for versioned IDs).
 * Returns null if the model is not in any registry.
 */
export function getModelContextWindow(modelId: string): number | null {
  if (!modelId) return null;
  const normalized = normalizeModelId(modelId);

  // Dynamic overrides (from Ollama /api/show etc.) take precedence
  if (dynamicContextWindows[normalized] !== undefined) return dynamicContextWindows[normalized];

  // Static registry
  if (CONTEXT_WINDOWS[normalized] !== undefined) return CONTEXT_WINDOWS[normalized];
  for (const [key, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) return size;
  }

  // Dynamic prefix match
  for (const [key, size] of Object.entries(dynamicContextWindows)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) return size;
  }

  return null;
}
