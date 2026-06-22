/**
 * Cost estimation for LLM API calls.
 * Prices are per million tokens (USD) as of early 2026.
 * Prices are approximate — check provider pricing pages for the latest.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-opus-4-6":       { inputPerMillion: 15,    outputPerMillion: 75   },
  "claude-opus-4":         { inputPerMillion: 15,    outputPerMillion: 75   },
  "claude-sonnet-4-6":     { inputPerMillion: 3,     outputPerMillion: 15   },
  "claude-sonnet-4":       { inputPerMillion: 3,     outputPerMillion: 15   },
  "claude-haiku-4-5":      { inputPerMillion: 0.8,   outputPerMillion: 4    },
  "claude-haiku-4":        { inputPerMillion: 0.8,   outputPerMillion: 4    },
  "claude-3-5-sonnet":     { inputPerMillion: 3,     outputPerMillion: 15   },
  "claude-3-5-haiku":      { inputPerMillion: 0.8,   outputPerMillion: 4    },
  "claude-3-opus":         { inputPerMillion: 15,    outputPerMillion: 75   },
  "claude-3-sonnet":       { inputPerMillion: 3,     outputPerMillion: 15   },
  "claude-3-haiku":        { inputPerMillion: 0.25,  outputPerMillion: 1.25 },
  // OpenAI
  "gpt-4o":                { inputPerMillion: 2.5,   outputPerMillion: 10   },
  "gpt-4o-mini":           { inputPerMillion: 0.15,  outputPerMillion: 0.6  },
  "gpt-4-turbo":           { inputPerMillion: 10,    outputPerMillion: 30   },
  "gpt-4":                 { inputPerMillion: 30,    outputPerMillion: 60   },
  "gpt-3.5-turbo":         { inputPerMillion: 0.5,   outputPerMillion: 1.5  },
  "o1":                    { inputPerMillion: 15,    outputPerMillion: 60   },
  "o1-mini":               { inputPerMillion: 1.1,   outputPerMillion: 4.4  },
  "o3-mini":               { inputPerMillion: 1.1,   outputPerMillion: 4.4  },
  "o4-mini":               { inputPerMillion: 1.1,   outputPerMillion: 4.4  },
  // Google
  "gemini-3-flash-preview":{ inputPerMillion: 0.5,   outputPerMillion: 3    },
  "gemini-3-pro-preview":  { inputPerMillion: 2,     outputPerMillion: 12   },
  "gemini-2.5-pro":        { inputPerMillion: 1.25,  outputPerMillion: 10   },
  "gemini-2.0-flash":      { inputPerMillion: 0.1,   outputPerMillion: 0.4  },
  "gemini-2.5-flash":      { inputPerMillion: 0.3,   outputPerMillion: 2.5  },
  "gemini-1.5-pro":        { inputPerMillion: 1.25,  outputPerMillion: 5    },
  "gemini-1.5-flash":      { inputPerMillion: 0.075, outputPerMillion: 0.3  },
  "gemini-1.0-pro":        { inputPerMillion: 0.5,   outputPerMillion: 1.5  },
  // Groq (hosted inference)
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "llama-3.1-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "llama-3.1-8b-instant":    { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  "mixtral-8x7b-32768":      { inputPerMillion: 0.24, outputPerMillion: 0.24 },
  "gemma2-9b-it":            { inputPerMillion: 0.2,  outputPerMillion: 0.2  },
  // DeepSeek
  "deepseek-chat":         { inputPerMillion: 0.14,  outputPerMillion: 0.28 },
  "deepseek-reasoner":     { inputPerMillion: 0.55,  outputPerMillion: 2.19 },
  // Mistral
  "mistral-large-latest":  { inputPerMillion: 2,     outputPerMillion: 6    },
  "mistral-small-latest":  { inputPerMillion: 0.1,   outputPerMillion: 0.3  },
  "mistral-nemo":          { inputPerMillion: 0.15,  outputPerMillion: 0.15 },
  // xAI / Grok
  "grok-3":                { inputPerMillion: 3,     outputPerMillion: 15   },
  "grok-3-mini":           { inputPerMillion: 0.3,   outputPerMillion: 0.5  },
  "grok-2":                { inputPerMillion: 2,     outputPerMillion: 10   },
  // Moonshot / Kimi
  "kimi-k2-0711-preview":  { inputPerMillion: 0.6,   outputPerMillion: 2.5  },
  // Zhipu / GLM
  "glm-4-flash":           { inputPerMillion: 0,     outputPerMillion: 0    },
  "glm-4-plus":            { inputPerMillion: 0.07,  outputPerMillion: 0.07 },
  // Together AI (common models)
  "meta-llama/llama-3.3-70b-instruct-turbo": { inputPerMillion: 0.88, outputPerMillion: 0.88 },
  "meta-llama/llama-3.1-8b-instruct-turbo":  { inputPerMillion: 0.18, outputPerMillion: 0.18 },
};

/** Strip date suffix (e.g. -20250514) and normalize for pricing lookup */
function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/-\d{8}(-\d+)?$/, "");
}

/** Get pricing for a model, trying prefix matches if exact match fails */
export function getModelPricing(modelId: string): ModelPricing | null {
  const normalized = normalizeModelId(modelId);
  if (PRICING[normalized]) return PRICING[normalized];
  // Prefix match: try progressively shorter prefixes
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return pricing;
    }
  }
  return null;
}

/** Estimate cost in USD for a model call */
export function estimateCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  return (
    (tokensIn  / 1_000_000) * pricing.inputPerMillion +
    (tokensOut / 1_000_000) * pricing.outputPerMillion
  );
}

/** Format cost as a compact human-readable string */
export function formatCost(usd: number): string {
  if (usd === 0) return "";
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01)  return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}
