import { normalizeProviderId } from "@/lib/agents/provider-normalization";

export type ProviderAuthType =
  | "api_key"
  | "oauth_device_code"
  | "oauth_external"
  | "external_process"
  | "local";

export type ProviderAuthConfig = {
  provider: string;
  label: string;
  authType: ProviderAuthType;
  defaultBaseUrl?: string;
  tokenStoreKey?: string;
  supportsRefresh: boolean;
  envKeyFallbacks?: string[];
  requiredHeaders?: Record<string, string>;
  notes?: string;
};

const PROVIDER_AUTH_REGISTRY: ProviderAuthConfig[] = [
  {
    provider: "openai",
    label: "OpenAI API",
    authType: "api_key",
    supportsRefresh: false,
    envKeyFallbacks: ["OPENAI_API_KEY"],
    notes: "Normal OpenAI API usage remains API-key based.",
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    authType: "api_key",
    supportsRefresh: true,
    envKeyFallbacks: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    notes: "Regular API keys use x-api-key. Claude Code/setup-token OAuth tokens use bearer auth with Claude Code headers; local Claude Code credentials can be discovered and refreshed.",
  },
  {
    provider: "qwen-oauth",
    label: "Qwen OAuth",
    authType: "oauth_external",
    defaultBaseUrl: "https://portal.qwen.ai/v1",
    tokenStoreKey: "qwen-oauth",
    supportsRefresh: true,
    envKeyFallbacks: ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_OAUTH_TOKEN"],
    requiredHeaders: { "X-DashScope-AuthType": "qwen-oauth" },
  },
  {
    provider: "google-gemini-cli",
    label: "Google Gemini CLI OAuth",
    authType: "oauth_external",
    defaultBaseUrl: "cloudcode-pa://google",
    tokenStoreKey: "google-gemini-cli",
    supportsRefresh: true,
    envKeyFallbacks: ["GEMINI_CLI_OAUTH_TOKEN", "GOOGLE_GEMINI_CLI_OAUTH_TOKEN"],
    notes: "Separate from Google AI Studio API-key provider.",
  },
  {
    provider: "google",
    label: "Google Gemini API",
    authType: "api_key",
    supportsRefresh: false,
    envKeyFallbacks: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    authType: "api_key",
    supportsRefresh: false,
    envKeyFallbacks: ["OPENROUTER_API_KEY"],
  },
  {
    provider: "qwen",
    label: "Qwen DashScope",
    authType: "api_key",
    supportsRefresh: false,
    envKeyFallbacks: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  },
  {
    provider: "ollama",
    label: "Ollama",
    authType: "local",
    supportsRefresh: false,
    notes: "Local provider; no OAuth or API key required by default.",
  },
];

export function listProviderAuthConfigs(): ProviderAuthConfig[] {
  return PROVIDER_AUTH_REGISTRY;
}

export function getProviderAuthConfig(provider: string | null | undefined): ProviderAuthConfig | null {
  if (!provider) return null;
  const normalized = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  return PROVIDER_AUTH_REGISTRY.find((entry) => entry.provider === normalized) ?? null;
}

export function getProviderRequiredHeaders(provider: string | null | undefined): Record<string, string> {
  return { ...(getProviderAuthConfig(provider)?.requiredHeaders ?? {}) };
}

export function providerUsesOAuth(provider: string | null | undefined): boolean {
  const authType = getProviderAuthConfig(provider)?.authType;
  return authType === "oauth_device_code" || authType === "oauth_external" || authType === "external_process";
}
