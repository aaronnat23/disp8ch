export const CANONICAL_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openai-compatible",
  "google",
  "google-gemini-cli",
  "openrouter",
  "opencode",
  "opencode-go",
  "groq",
  "together",
  "ollama",
  "vllm",
  "sglang",
  "lmstudio",
  "deepseek",
  "mistral",
  "voyage",
  "zhipu",
  "moonshot",
  "qwen",
  "qwen-oauth",
  "xai",
] as const;

export type CanonicalProviderId = (typeof CANONICAL_PROVIDER_IDS)[number];

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

const PROVIDER_ALIASES: Record<string, CanonicalProviderId> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gpt: "openai",
  chatgpt: "openai",
  "openai-compatible": "openai-compatible",
  "openai compatible": "openai-compatible",
  "openaicompat": "openai-compatible",
  "custom-local": "openai-compatible",
  "custom local": "openai-compatible",
  localopenai: "openai-compatible",
  "local-openai": "openai-compatible",
  "openai-local": "openai-compatible",
  "openai-like": "openai-compatible",
  "openai style": "openai-compatible",
  "openai style local": "openai-compatible",
  "openai-compatible-local": "openai-compatible",
  google: "google",
  gemini: "google",
  "google-gemini": "google",
  "google-gemini-cli": "google-gemini-cli",
  "gemini-cli": "google-gemini-cli",
  "gemini-oauth": "google-gemini-cli",
  groq: "groq",
  together: "together",
  "together-ai": "together",
  openrouter: "openrouter",
  "open-router": "openrouter",
  opencode: "opencode",
  "opencode-zen": "opencode",
  "opencode zen": "opencode",
  "open-code": "opencode",
  "open-code-zen": "opencode",
  "opencode-go": "opencode-go",
  "opencode go": "opencode-go",
  "open-code-go": "opencode-go",
  ollama: "ollama",
  local: "ollama",
  vllm: "vllm",
  "self-hosted-vllm": "vllm",
  sglang: "sglang",
  "sg-lang": "sglang",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  "lm studio": "lmstudio",
  deepseek: "deepseek",
  "deep-seek": "deepseek",
  mistral: "mistral",
  voyage: "voyage",
  zhipu: "zhipu",
  zhipuai: "zhipu",
  glm: "zhipu",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  kimi: "moonshot",
  qwen: "qwen",
  dashscope: "qwen",
  alibaba: "qwen",
  "alibaba-cloud": "qwen",
  "qwen-oauth": "qwen-oauth",
  "qwen-portal": "qwen-oauth",
  "qwen-cli": "qwen-oauth",
  xai: "xai",
  "x-ai": "xai",
  grok: "xai",
};

export function normalizeProviderId(provider: string | null | undefined): CanonicalProviderId | null {
  if (!provider) return null;
  const normalized = normalizeToken(provider);
  return PROVIDER_ALIASES[normalized] ?? null;
}
