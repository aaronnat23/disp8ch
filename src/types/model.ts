export type ModelProvider =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "google"
  | "google-gemini-cli"
  | "openrouter"
  | "opencode"
  | "opencode-go"
  | "groq"
  | "together"
  | "ollama"
  | "vllm"
  | "sglang"
  | "lmstudio"
  | "deepseek"
  | "mistral"
  | "zhipu"
  | "moonshot"
  | "qwen"
  | "qwen-oauth"
  | "xai";

export interface ModelEntry {
  id: string;
  provider: ModelProvider;
  modelId: string;
  name: string;
  apiKey: string;
  priority: number;
  isActive: boolean;
  maxTokens: number | null;
  baseUrl: string | null;
  fastMode: boolean;
  createdAt: string;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  supportsTools: boolean;
  supportsVision?: boolean;
  recommended?: boolean;
  status?: "stable" | "preview" | "legacy";
  notes?: string;
}

export interface ProviderInfo {
  id: ModelProvider;
  name: string;
  description: string;
  envKey: string;
  defaultModel: string;
  defaultName: string;
  baseUrl?: string;
  requiresApiKey: boolean;
  models: ProviderModelInfo[];
}

export { PROVIDERS } from "@/lib/agents/provider-plugins";
