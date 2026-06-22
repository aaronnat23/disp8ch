/**
 * Short-form aliases for common model IDs.
 * Applied at callModel/streamModel entry points so users can type short names
 * in workflow config and CLI instead of the full versioned model ID.
 */

export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  "opus":            "claude-opus-4-1",
  "sonnet":          "claude-sonnet-4-5",
  "haiku":           "claude-3-5-haiku-20241022",
  "claude-opus":     "claude-opus-4-1",
  "claude-sonnet":   "claude-sonnet-4-5",
  "claude-haiku":    "claude-3-5-haiku-20241022",

  // OpenAI
  "gpt4":            "gpt-4o",
  "gpt4o":           "gpt-4o",
  "gpt5":            "gpt-5.5",
  "gpt-5-latest":    "gpt-5.5",
  "gpt-latest":      "gpt-5.5",
  "gpt5.5":          "gpt-5.5",
  "gpt-5.5":         "gpt-5.5",
  "gpt55":           "gpt-5.5",
  "gpt-5.5-pro":     "gpt-5.5-pro",
  "gpt5.4":          "gpt-5.4",
  "gpt-5.4":         "gpt-5.4",
  "gpt54":           "gpt-5.4",
  "gpt-5.4-pro":     "gpt-5.4-pro",
  "mini":            "gpt-5-mini",
  "gpt5-mini":       "gpt-5-mini",
  "gpt4-mini":       "gpt-4o-mini",
  "gpt-4-mini":      "gpt-4o-mini",
  "o1-preview":      "o1",

  // Google
  "gemini":          "gemini-3-flash-preview",
  "flash":           "gemini-3-flash-preview",
  "pro":             "gemini-3.1-pro-preview",
  "gemini-pro":      "gemini-3.1-pro-preview",
  "gemini-3.1-pro":  "gemini-3.1-pro-preview",
  "gemini-3-flash":  "gemini-3-flash-preview",
  "gemini3flash":    "gemini-3-flash-preview",
  "gemini-flash-lite":"gemini-3.1-flash-lite-preview",
  "flash-lite":      "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite":"gemini-3.1-flash-lite-preview",

  // Groq / Meta
  "llama":           "llama-3.3-70b-versatile",
  "llama3":          "llama-3.3-70b-versatile",
  "llama70b":        "llama-3.3-70b-versatile",
  "llama8b":         "llama-3.1-8b-instant",

  // DeepSeek
  "deepseek":        "deepseek-v4-pro",
  "ds":              "deepseek-v4-pro",
  "deepseek-v4":     "deepseek-v4-pro",
  "ds-v4":           "deepseek-v4-pro",
  "deepseek-r1":     "deepseek-reasoner",

  // Mistral
  "mistral":         "mistral-large-latest",
  "mistral-small":   "mistral-small-latest",

  // xAI
  "grok":            "grok-4-fast-reasoning",
  "grok-mini":       "grok-3-mini",

  // Moonshot / Kimi
  "kimi":            "kimi-k2.6",
  "kimi-2.6":        "kimi-k2.6",
  "kimi-k2.6":       "kimi-k2.6",
  "moonshotai/kimi-k2.6":"moonshotai/kimi-k2.6",
  "kimi-2.5":        "moonshotai/kimi-k2.5",
  "kimi-k2.5":       "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2.5":"moonshotai/kimi-k2.5",

  // Zhipu
  "glm":             "z-ai/glm-5.1",
  "glm-5.1":         "z-ai/glm-5.1",
  "z-ai/glm-5.1":    "z-ai/glm-5.1",

  // Qwen
  "qwen":            "qwen3.6-plus",
  "qwen-3.6":        "qwen3.6-plus",
  "qwen3.6":         "qwen3.6-plus",
  "qwen 3.6":        "qwen3.6-plus",
  "qwen3.6-plus":    "qwen3.6-plus",
  "qwen/qwen3.6":    "qwen/qwen3.6",
  "qwen/qwen3.6-plus":"qwen/qwen3.6-plus",
};

/**
 * Resolve a short alias to its full model ID.
 * Returns the input unchanged if it is not a known alias.
 */
export function resolveModelAlias(modelId: string): string {
  if (!modelId) return modelId;
  const trimmed = modelId.trim();
  const withoutModelsPrefix = trimmed.replace(/^models\//i, "");
  const key = withoutModelsPrefix.toLowerCase();
  return MODEL_ALIASES[key] ?? withoutModelsPrefix;
}
