import { normalizeProviderId } from "./provider-normalization";
import { parseSecretReference, resolveSecretValue } from "@/lib/secrets/store";
import { getProviderPlaceholderApiKey } from "@/lib/agents/provider-plugins";

type AuthResolution = {
  apiKey: string;
  source: string;
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY", "LOCAL_OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  "google-gemini-cli": ["GEMINI_CLI_OAUTH_TOKEN", "GOOGLE_GEMINI_CLI_OAUTH_TOKEN"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  groq: ["GROQ_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  vllm: ["VLLM_API_KEY"],
  sglang: ["SGLANG_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  qwen: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  "qwen-oauth": ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_OAUTH_TOKEN"],
  xai: ["XAI_API_KEY"],
};

function getEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  return String(env[key] ?? "").trim();
}

function resolveEnvRefs(refSpec: string, env: NodeJS.ProcessEnv): AuthResolution | null {
  const refs = refSpec
    .split(/[|,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const ref of refs) {
    const value = getEnvValue(env, ref);
    if (value) return { apiKey: value, source: `env:${ref}` };
  }
  return null;
}

function resolveFromStoredValue(stored: string, env: NodeJS.ProcessEnv): AuthResolution | null {
  const parts = stored
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const secretName = parseSecretReference(part);
    if (secretName) {
      const value = resolveSecretValue(secretName);
      if (value) return { apiKey: value, source: `secret:${secretName}` };
      continue;
    }

    if (part.startsWith("env:")) {
      const resolved = resolveEnvRefs(part.slice(4), env);
      if (resolved) return resolved;
      continue;
    }

    if (part.startsWith("$")) {
      const envKey = part.slice(1).trim();
      if (!envKey) continue;
      const value = getEnvValue(env, envKey);
      if (value) return { apiKey: value, source: `env:${envKey}` };
      continue;
    }

    // Literal key/token
    return { apiKey: part, source: "db:literal" };
  }

  return null;
}

export function resolveProviderEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthResolution | null {
  const normalized = normalizeProviderId(provider);
  if (!normalized || normalized === "ollama") return null;

  const keys = PROVIDER_ENV_KEYS[normalized] ?? [];
  for (const key of keys) {
    const value = getEnvValue(env, key);
    if (value) return { apiKey: value, source: `env:${key}` };
  }

  return null;
}

export function resolveModelApiKey(params: {
  provider: string;
  storedApiKey?: string | null;
  env?: NodeJS.ProcessEnv;
}): AuthResolution {
  const env = params.env ?? process.env;
  const normalized = normalizeProviderId(params.provider) ?? params.provider.trim().toLowerCase();
  if (normalized === "ollama") {
    return { apiKey: "", source: "provider:ollama-no-key" };
  }

  const stored = String(params.storedApiKey ?? "").trim();
  if (stored) {
    const fromStored = resolveFromStoredValue(stored, env);
    if (fromStored) return fromStored;
  }

  const fromEnv = resolveProviderEnvApiKey(normalized, env);
  if (fromEnv) return fromEnv;

  const placeholderApiKey = getProviderPlaceholderApiKey(normalized);
  if (placeholderApiKey) {
    return { apiKey: placeholderApiKey, source: `provider:${normalized}-placeholder` };
  }

  return { apiKey: "", source: "missing" };
}
