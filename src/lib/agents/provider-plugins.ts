import type { ModelProvider, ProviderInfo } from "@/types/model";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";

export type ProviderWizardField = {
  label: string;
  placeholder?: string;
  help?: string;
  optional?: boolean;
  type?: "text" | "password";
};

export type ProviderWizardMeta = {
  onboarding?: {
    choiceLabel?: string;
    choiceHint?: string;
    credential?: ProviderWizardField;
    baseUrl?: ProviderWizardField;
    modelId?: ProviderWizardField;
  };
  modelPicker?: {
    label?: string;
    hint?: string;
    modelPlaceholder?: string;
  };
};

export type ProviderModelSelectionResult = {
  modelId: string;
  name: string;
  warnings: string[];
  discovered: boolean;
};

export type ProviderPlugin = ProviderInfo & {
  transport: "anthropic" | "google" | "openai-chat" | "openai-responses" | "hybrid";
  supportsModelDiscovery?: boolean;
  discoveryMode?: "ollama-native" | "openai-models";
  placeholderApiKey?: string;
  baseUrlEnvKey?: string;
  allowsOptionalApiKey?: boolean;
  wizard?: ProviderWizardMeta;
  discoverModelIds?: (params: {
    provider: string;
    baseUrl?: string | null;
    apiKey?: string | null;
  }) => Promise<string[]>;
  formatDiscoveredName?: (modelId: string) => string;
  afterModelSelected?: (params: {
    provider: string;
    modelId: string;
    baseUrl?: string | null;
    apiKey?: string | null;
    discovered: boolean;
  }) => Promise<string[]>;
};

const PROVIDER_PLUGINS: ProviderPlugin[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models — strong reasoning and long-context agent tasks",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
    defaultName: "Claude Sonnet 4.5",
    requiresApiKey: true,
    transport: "anthropic",
    models: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", supportsTools: true, supportsVision: true, recommended: true, status: "stable" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsTools: true, supportsVision: true, recommended: true, status: "stable" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "claude-opus-4", name: "Claude Opus 4", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", supportsTools: true, supportsVision: true, status: "legacy" },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (Legacy ID)", supportsTools: true, supportsVision: true, status: "legacy" },
      { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1 (Legacy ID)", supportsTools: true, supportsVision: true, status: "legacy" },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4 (Legacy ID)", supportsTools: true, supportsVision: true, status: "legacy" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models — broad ecosystem and robust tool/function calling",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    defaultName: "GPT-5.5",
    requiresApiKey: true,
    transport: "openai-responses",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", supportsTools: true, supportsVision: true, recommended: true, status: "stable" },
      { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "gpt-5.4", name: "GPT-5.4", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "gpt-5-mini", name: "GPT-5 mini", supportsTools: true, supportsVision: true, recommended: true, status: "stable" },
      { id: "gpt-5", name: "GPT-5", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "gpt-4o", name: "GPT-4o", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "o3-mini", name: "o3-mini", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini models — strong multimodal support and large context windows",
    envKey: "GOOGLE_API_KEY",
    defaultModel: "gemini-3-flash-preview",
    defaultName: "Gemini 3 Flash (Preview)",
    requiresApiKey: true,
    transport: "google",
    models: [
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (Preview)", supportsTools: true, supportsVision: true, recommended: true, status: "preview" },
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", supportsTools: true, supportsVision: true, recommended: true, status: "preview" },
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash-Lite (Preview)", supportsTools: true, supportsVision: true, status: "preview" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", supportsTools: true, supportsVision: true, recommended: true, status: "stable" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", supportsTools: true, supportsVision: true, status: "stable" },
      { id: "gemini-flash-latest", name: "Gemini Flash Latest", supportsTools: true, supportsVision: true, status: "stable" },
    ],
  },
  {
    id: "google-gemini-cli",
    name: "Google Gemini CLI OAuth",
    description: "Gemini CLI / Cloud Code Assist OAuth path. Separate from Google AI Studio API keys.",
    envKey: "GEMINI_CLI_OAUTH_TOKEN",
    defaultModel: "gemini-cli",
    defaultName: "Gemini CLI OAuth",
    baseUrl: "cloudcode-pa://google",
    requiresApiKey: true,
    transport: "google",
    models: [
      { id: "gemini-cli", name: "Gemini CLI OAuth", supportsTools: true, recommended: true, status: "preview" },
      { id: "gemini-oauth", name: "Gemini OAuth", supportsTools: true, status: "preview" },
    ],
    wizard: {
      onboarding: {
        choiceLabel: "Google Gemini CLI OAuth",
        choiceHint: "Use external Gemini CLI / Cloud Code OAuth credentials.",
        credential: {
          label: "OAuth access token",
          placeholder: "secret:GEMINI_CLI_OAUTH_TOKEN",
          help: "Use Provider OAuth settings to import CLI credentials.",
          type: "password",
        },
      },
    },
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible (Custom/Local)",
    description: "Generic OpenAI-compatible endpoint for local or self-hosted model servers",
    envKey: "LOCAL_OPENAI_API_KEY",
    defaultModel: "default",
    defaultName: "Default Model (OpenAI-Compatible)",
    baseUrl: "http://127.0.0.1:8000/v1",
    requiresApiKey: false,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    placeholderApiKey: "local-openai",
    baseUrlEnvKey: "LOCAL_OPENAI_BASE_URL",
    allowsOptionalApiKey: true,
    wizard: {
      onboarding: {
        choiceLabel: "OpenAI-Compatible",
        choiceHint: "Any local or self-hosted OpenAI-compatible server",
        credential: {
          label: "API key",
          placeholder: "local-openai",
          help: "Optional for local no-auth servers.",
          optional: true,
          type: "password",
        },
        baseUrl: {
          label: "Server URL",
          placeholder: "http://127.0.0.1:8000/v1",
          help: "Point to any OpenAI-compatible /v1 endpoint. Leave model blank to auto-detect from /models.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "default",
          help: "Optional. Leave blank to auto-detect the first model from /models.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "OpenAI-Compatible (custom)",
        hint: "Use any local or self-hosted OpenAI-compatible endpoint",
        modelPlaceholder: "default",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (OpenAI-Compatible)`,
    models: [
      { id: "default", name: "Default Loaded Model", supportsTools: true, recommended: true, status: "stable" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Unified gateway to many providers (model-level capabilities vary)",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    defaultName: "Claude Sonnet 4.6 (OpenRouter)",
    requiresApiKey: true,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    models: [
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", supportsTools: true, recommended: true, status: "stable" },
      { id: "openai/gpt-5.5", name: "GPT-5.5", supportsTools: true, status: "stable" },
      { id: "openai/gpt-5.5-pro", name: "GPT-5.5 Pro", supportsTools: true, status: "stable" },
      { id: "openai/gpt-5.4", name: "GPT-5.4", supportsTools: true, status: "stable" },
      { id: "openai/gpt-5.4-pro", name: "GPT-5.4 Pro", supportsTools: true, status: "stable" },
      { id: "openai/gpt-5-mini", name: "GPT-5 mini", supportsTools: true, status: "stable" },
      { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash (Preview)", supportsTools: true, status: "preview" },
      { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", supportsTools: true, status: "preview" },
      { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash-Lite (Preview)", supportsTools: true, status: "preview" },
      { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", supportsTools: true, status: "stable" },
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", supportsTools: true, status: "stable" },
      { id: "z-ai/glm-5", name: "GLM-5", supportsTools: true, status: "stable" },
      { id: "z-ai/glm-5.1", name: "GLM 5.1", supportsTools: true, status: "stable" },
      { id: "qwen/qwen3.6", name: "Qwen 3.6", supportsTools: true, status: "stable" },
      { id: "qwen/qwen3.6-plus", name: "Qwen 3.6 Plus", supportsTools: true, status: "stable" },
      { id: "qwen/qwen3.6-plus:free", name: "Qwen 3.6 Plus (Free)", supportsTools: true, status: "preview" },
      { id: "qwen/qwen3.6-plus-preview:free", name: "Qwen 3.6 Plus Preview (Free)", supportsTools: true, status: "preview" },
      {
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        supportsTools: true,
        status: "preview",
        notes: "Temporary OpenRouter catalog entry from the March 11, 2026 release window.",
      },
      {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        supportsTools: true,
        status: "preview",
        notes: "Temporary OpenRouter catalog entry from the March 11, 2026 release window.",
      },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    description: "Shared OpenCode key with Zen catalog routing across Claude, GPT, and Gemini families",
    envKey: "OPENCODE_API_KEY",
    defaultModel: "opencode/claude-opus-4-6",
    defaultName: "Claude Opus 4.6 (OpenCode Zen)",
    baseUrl: "https://opencode.ai/zen/v1",
    requiresApiKey: true,
    transport: "hybrid",
    supportsModelDiscovery: true,
    models: [
      { id: "opencode/claude-opus-4-6", name: "Claude Opus 4.6", supportsTools: true, recommended: true, status: "stable" },
      { id: "opencode/gpt-5.2", name: "GPT-5.2", supportsTools: true, status: "stable" },
      { id: "opencode/gemini-3-pro", name: "Gemini 3 Pro", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "Shared OpenCode key with the Go catalog for Kimi, GLM, and MiniMax models",
    envKey: "OPENCODE_API_KEY",
    defaultModel: "opencode-go/kimi-k2.5",
    defaultName: "Kimi K2.5 (OpenCode Go)",
    baseUrl: "https://opencode.ai/zen/go/v1",
    requiresApiKey: true,
    transport: "hybrid",
    supportsModelDiscovery: true,
    models: [
      { id: "opencode-go/kimi-k2.5", name: "Kimi K2.5", supportsTools: true, recommended: true, status: "stable" },
      { id: "opencode-go/glm-5", name: "GLM-5", supportsTools: true, status: "stable" },
      { id: "opencode-go/minimax-m2.5", name: "MiniMax M2.5", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Low-latency inference with broad tool-call-capable model support",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    defaultName: "Llama 3.3 70B",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", supportsTools: true, recommended: true, status: "stable" },
      { id: "qwen/qwen3-32b", name: "Qwen3 32B", supportsTools: true, status: "stable" },
      { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", supportsTools: true, status: "stable" },
      { id: "moonshotai/kimi-k2-instruct-0905", name: "Kimi K2 Instruct 0905", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    description: "Serverless open models with function-calling support",
    envKey: "TOGETHER_API_KEY",
    defaultModel: "moonshotai/Kimi-K2.5",
    defaultName: "Kimi K2.5 (Together)",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", supportsTools: true, recommended: true, status: "stable" },
      { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5 397B A17B", supportsTools: true, status: "stable" },
      { id: "zai-org/GLM-5", name: "GLM-5", supportsTools: true, status: "stable" },
      { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1", supportsTools: true, status: "stable" },
      { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    description: "Run models locally with OpenAI-compatible APIs",
    envKey: "OLLAMA_BASE_URL",
    defaultModel: "qwen3",
    defaultName: "Qwen3 (Local)",
    baseUrl: "http://localhost:11434",
    requiresApiKey: false,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "ollama-native",
    baseUrlEnvKey: "OLLAMA_BASE_URL",
    wizard: {
      onboarding: {
        choiceLabel: "Ollama",
        choiceHint: "Cloud and local open models",
        baseUrl: {
          label: "Ollama URL",
          placeholder: "http://localhost:11434",
          help: "Point to a local or remote Ollama instance. Leave the model blank to auto-detect one.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "qwen3",
          help: "Optional. If left empty, disp8ch will try the first model reported by Ollama.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "Ollama (custom)",
        hint: "Detect models from a local or remote Ollama instance",
        modelPlaceholder: "qwen3",
      },
    },
    discoverModelIds: async ({ baseUrl }) => {
      const { discoverOllamaModelIds } = await import("@/lib/agents/ollama-discovery");
      return discoverOllamaModelIds(baseUrl);
    },
    formatDiscoveredName: (modelId) => `${modelId} (Local)`,
    afterModelSelected: async ({ modelId, baseUrl, discovered }) => {
      const warnings: string[] = [];
      if (!discovered) {
        const { discoverOllamaModelIds } = await import("@/lib/agents/ollama-discovery");
        const available = await discoverOllamaModelIds(baseUrl);
        if (available.length > 0 && !available.includes(modelId)) {
          warnings.push(
            `Selected Ollama model "${modelId}" is not currently advertised by this instance. Pull it first or verify the base URL.`,
          );
        }
      }
      // Fetch per-model context window from /api/show and register it dynamically
      try {
        const { getOllamaModelContextWindow } = await import("@/lib/agents/ollama-discovery");
        const ctxWindow = await getOllamaModelContextWindow(modelId, baseUrl);
        if (ctxWindow) {
          const { registerDynamicContextWindow } = await import("@/lib/agents/context-windows");
          registerDynamicContextWindow(modelId, ctxWindow);
        }
      } catch { /* non-fatal */ }
      return warnings;
    },
    models: [
      { id: "qwen3", name: "Qwen3", supportsTools: true, recommended: true, status: "stable" },
      { id: "qwen2.5", name: "Qwen2.5", supportsTools: true, status: "stable" },
      { id: "llama3.1", name: "Llama 3.1", supportsTools: true, status: "stable" },
      { id: "llama3.2", name: "Llama 3.2", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "vllm",
    name: "vLLM (Local)",
    description: "Self-hosted OpenAI-compatible vLLM server with model discovery",
    envKey: "VLLM_API_KEY",
    defaultModel: "Qwen/Qwen3-8B",
    defaultName: "Qwen3 8B (vLLM)",
    baseUrl: "http://127.0.0.1:8000/v1",
    requiresApiKey: false,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    placeholderApiKey: "vllm-local",
    baseUrlEnvKey: "VLLM_BASE_URL",
    allowsOptionalApiKey: true,
    wizard: {
      onboarding: {
        choiceLabel: "vLLM",
        choiceHint: "Local or self-hosted OpenAI-compatible server",
        credential: {
          label: "API key",
          placeholder: "vllm-local",
          help: "Optional for local no-auth servers.",
          optional: true,
          type: "password",
        },
        baseUrl: {
          label: "Server URL",
          placeholder: "http://127.0.0.1:8000/v1",
          help: "Point to the vLLM OpenAI-compatible /v1 endpoint.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "Qwen/Qwen3-8B",
          help: "Optional. Leave blank to auto-detect the first model from /models.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "vLLM (custom)",
        hint: "Enter a vLLM URL and optionally an API key, then auto-detect models",
        modelPlaceholder: "Qwen/Qwen3-8B",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (vLLM)`,
    models: [
      { id: "Qwen/Qwen3-8B", name: "Qwen3 8B", supportsTools: true, recommended: true, status: "stable" },
      { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", name: "Qwen3 Coder 30B", supportsTools: true, status: "stable" },
      { id: "meta-llama/Llama-3.3-70B-Instruct", name: "Llama 3.3 70B", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "sglang",
    name: "SGLang (Local)",
    description: "Self-hosted OpenAI-compatible SGLang server with model discovery",
    envKey: "SGLANG_API_KEY",
    defaultModel: "Qwen/Qwen3-8B",
    defaultName: "Qwen3 8B (SGLang)",
    baseUrl: "http://127.0.0.1:30000/v1",
    requiresApiKey: false,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    placeholderApiKey: "sglang-local",
    baseUrlEnvKey: "SGLANG_BASE_URL",
    allowsOptionalApiKey: true,
    wizard: {
      onboarding: {
        choiceLabel: "SGLang",
        choiceHint: "Fast self-hosted OpenAI-compatible server",
        credential: {
          label: "API key",
          placeholder: "sglang-local",
          help: "Optional for local no-auth servers.",
          optional: true,
          type: "password",
        },
        baseUrl: {
          label: "Server URL",
          placeholder: "http://127.0.0.1:30000/v1",
          help: "Point to the SGLang OpenAI-compatible /v1 endpoint.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "Qwen/Qwen3-8B",
          help: "Optional. Leave blank to auto-detect the first model from /models.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "SGLang (custom)",
        hint: "Enter an SGLang URL and optionally an API key, then auto-detect models",
        modelPlaceholder: "Qwen/Qwen3-8B",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (SGLang)`,
    models: [
      { id: "Qwen/Qwen3-8B", name: "Qwen3 8B", supportsTools: true, recommended: true, status: "stable" },
      { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", name: "Qwen3 Coder 30B", supportsTools: true, status: "stable" },
      { id: "meta-llama/Llama-3.3-70B-Instruct", name: "Llama 3.3 70B", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio (Local)",
    description: "Run models locally via LM Studio's OpenAI-compatible server",
    envKey: "LMSTUDIO_BASE_URL",
    defaultModel: "default",
    defaultName: "Default Model (LM Studio)",
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresApiKey: false,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    placeholderApiKey: "lm-studio",
    baseUrlEnvKey: "LMSTUDIO_BASE_URL",
    allowsOptionalApiKey: true,
    wizard: {
      onboarding: {
        choiceLabel: "LM Studio",
        choiceHint: "Local models via LM Studio desktop app",
        baseUrl: {
          label: "Server URL",
          placeholder: "http://127.0.0.1:1234/v1",
          help: "Point to LM Studio's local server. Start the server in LM Studio first.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "default",
          help: "Optional. Leave blank to auto-detect the loaded model.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "LM Studio (custom)",
        hint: "Detect models loaded in LM Studio",
        modelPlaceholder: "default",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (LM Studio)`,
    models: [
      { id: "default", name: "Default Loaded Model", supportsTools: true, recommended: true, status: "stable" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek models — strong coding and reasoning with low cost",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
    defaultName: "DeepSeek V4 Pro",
    baseUrl: "https://api.deepseek.com",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsTools: true, supportsVision: false, recommended: true, status: "stable" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportsTools: true, supportsVision: false, status: "stable" },
      { id: "deepseek-chat", name: "DeepSeek Chat", supportsTools: true, status: "legacy", notes: "Legacy alias scheduled for retirement by DeepSeek on 2026-07-24." },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        supportsTools: false,
        status: "legacy",
        notes: "Legacy alias scheduled for retirement by DeepSeek on 2026-07-24; use deepseek-v4-pro for tool workflows.",
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "Mistral models — multilingual models with function-calling support",
    envKey: "MISTRAL_API_KEY",
    defaultModel: "mistral-medium-latest",
    defaultName: "Mistral Medium",
    baseUrl: "https://api.mistral.ai/v1",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "mistral-medium-latest", name: "Mistral Medium", supportsTools: true, recommended: true, status: "stable" },
      { id: "mistral-large-latest", name: "Mistral Large", supportsTools: true, status: "stable" },
      { id: "ministral-8b-latest", name: "Ministral 8B", supportsTools: true, status: "stable" },
      { id: "codestral-latest", name: "Codestral", supportsTools: true, status: "stable" },
    ],
  },
  {
    id: "zhipu",
    name: "ZhipuAI (GLM)",
    description: "GLM models — strong Chinese/multilingual models with function calling",
    envKey: "ZHIPU_API_KEY",
    defaultModel: "glm-5",
    defaultName: "GLM-5",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "glm-5", name: "GLM-5", supportsTools: true, recommended: true, status: "stable" },
      { id: "glm-4.7", name: "GLM-4.7", supportsTools: true, status: "stable" },
      { id: "glm-4.5", name: "GLM-4.5", supportsTools: true, status: "stable" },
      { id: "glm-4-flash", name: "GLM-4 Flash", supportsTools: true, status: "legacy" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    description: "Moonshot Kimi models via OpenAI-compatible API",
    envKey: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.6",
    defaultName: "Kimi K2.6",
    baseUrl: "https://api.moonshot.ai/v1",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "kimi-k2.6", name: "Kimi K2.6", supportsTools: true, recommended: true, status: "stable" },
      { id: "kimi-k2.5", name: "Kimi K2.5", supportsTools: true, status: "stable" },
      { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo Preview", supportsTools: true, status: "preview" },
    ],
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    description: "Qwen models through Alibaba Cloud DashScope's OpenAI-compatible API",
    envKey: "QWEN_API_KEY",
    defaultModel: "qwen3.6-plus",
    defaultName: "Qwen 3.6 Plus",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    requiresApiKey: true,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    baseUrlEnvKey: "QWEN_BASE_URL",
    wizard: {
      onboarding: {
        choiceLabel: "Qwen (DashScope)",
        choiceHint: "Direct Qwen provider via DashScope OpenAI-compatible API",
        credential: {
          label: "Qwen/DashScope API key",
          placeholder: "secret:QWEN_API_KEY",
          help: "Also supports DASHSCOPE_API_KEY as an env fallback.",
          type: "password",
        },
        baseUrl: {
          label: "DashScope base URL",
          placeholder: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          help: "Use the intl endpoint by default, or switch to the China endpoint if your key is regional.",
          type: "text",
        },
        modelId: {
          label: "Model ID",
          placeholder: "qwen3.6-plus",
          help: "Optional. Leave blank to use Qwen 3.6 Plus.",
          optional: true,
          type: "text",
        },
      },
      modelPicker: {
        label: "Qwen (DashScope)",
        hint: "Direct Qwen API with OpenAI-compatible tool calling",
        modelPlaceholder: "qwen3.6-plus",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (Qwen)`,
    models: [
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", supportsTools: true, recommended: true, status: "stable" },
      { id: "qwen3.6", name: "Qwen 3.6", supportsTools: true, status: "stable" },
      { id: "qwen3.6-plus-preview", name: "Qwen 3.6 Plus Preview", supportsTools: true, status: "preview" },
    ],
  },
  {
    id: "qwen-oauth",
    name: "Qwen OAuth",
    description: "Qwen portal OAuth path with qwen-oauth headers. Separate from DashScope API keys.",
    envKey: "QWEN_OAUTH_TOKEN",
    defaultModel: "qwen-portal",
    defaultName: "Qwen Portal OAuth",
    baseUrl: "https://portal.qwen.ai/v1",
    requiresApiKey: true,
    transport: "openai-chat",
    supportsModelDiscovery: true,
    discoveryMode: "openai-models",
    wizard: {
      onboarding: {
        choiceLabel: "Qwen OAuth",
        choiceHint: "External Qwen portal OAuth credentials.",
        credential: {
          label: "OAuth access token",
          placeholder: "secret:QWEN_OAUTH_TOKEN",
          help: "Adds X-DashScope-AuthType: qwen-oauth at runtime.",
          type: "password",
        },
      },
      modelPicker: {
        label: "Qwen OAuth",
        hint: "Qwen portal OAuth provider",
        modelPlaceholder: "qwen-portal",
      },
    },
    discoverModelIds: async ({ provider, baseUrl, apiKey }) => {
      const { discoverOpenAICompatibleModelIds } = await import("@/lib/agents/provider-discovery");
      return discoverOpenAICompatibleModelIds({ provider, baseUrl, apiKey });
    },
    formatDiscoveredName: (modelId) => `${modelId} (Qwen OAuth)`,
    models: [
      { id: "qwen-portal", name: "Qwen Portal", supportsTools: true, recommended: true, status: "preview" },
      { id: "qwen-cli", name: "Qwen CLI OAuth", supportsTools: true, status: "preview" },
      { id: "qwen-oauth", name: "Qwen OAuth", supportsTools: true, status: "preview" },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    description: "Grok models — xAI models with documented function-calling support",
    envKey: "XAI_API_KEY",
    defaultModel: "grok-4-fast-reasoning",
    defaultName: "Grok 4 Fast (Reasoning)",
    baseUrl: "https://api.x.ai/v1",
    requiresApiKey: true,
    transport: "openai-chat",
    models: [
      { id: "grok-4-fast-reasoning", name: "Grok 4 Fast (Reasoning)", supportsTools: true, recommended: true, status: "stable" },
      { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast (Non-Reasoning)", supportsTools: true, status: "stable" },
      { id: "grok-4-1-fast", name: "Grok 4.1 Fast (Legacy ID)", supportsTools: true, status: "legacy" },
      { id: "grok-4-fast", name: "Grok 4 Fast", supportsTools: true, status: "legacy" },
      { id: "grok-3-mini", name: "Grok 3 Mini", supportsTools: true, status: "stable" },
      { id: "grok-3", name: "Grok 3", supportsTools: true, status: "stable" },
      { id: "grok-code-fast-1", name: "Grok Code Fast 1", supportsTools: true, status: "stable" },
    ],
  },
];

export const PROVIDERS: ProviderInfo[] = PROVIDER_PLUGINS;

export function listProviderPlugins(): ProviderPlugin[] {
  return PROVIDER_PLUGINS;
}

export function getProviderPlugin(provider: string | null | undefined): ProviderPlugin | undefined {
  if (!provider) return undefined;
  const normalized = normalizeProviderId(provider) ?? provider.trim().toLowerCase();
  return PROVIDER_PLUGINS.find((entry) => entry.id === normalized);
}

export function getProviderPlaceholderApiKey(provider: string | null | undefined): string | null {
  return getProviderPlugin(provider)?.placeholderApiKey ?? null;
}

function buildDefaultWizardMeta(plugin: ProviderPlugin): ProviderWizardMeta {
  const supportsCredentialInput = plugin.requiresApiKey || plugin.allowsOptionalApiKey === true;
  return {
    onboarding: {
      choiceLabel: plugin.name,
      choiceHint: plugin.description,
      ...(supportsCredentialInput
        ? {
            credential: {
              label: "API key",
              placeholder: plugin.placeholderApiKey || `secret:${plugin.envKey}`,
              help: plugin.requiresApiKey
                ? `Supports secret references such as secret:${plugin.envKey}.`
                : "Optional for this provider.",
              optional: !plugin.requiresApiKey,
              type: "password" as const,
            },
          }
        : {}),
      ...(plugin.baseUrlEnvKey
        ? {
            baseUrl: {
              label: "Base URL",
              placeholder: plugin.baseUrl,
              help: "Custom base URL for this provider.",
              type: "text" as const,
            },
          }
        : {}),
      modelId: {
        label: "Model ID",
        placeholder: plugin.defaultModel,
        help: "Optional. Leave blank to use the provider default.",
        optional: true,
        type: "text",
      },
    },
    modelPicker: plugin.supportsModelDiscovery
      ? {
          label: `${plugin.name} (custom)`,
          hint: "Use provider defaults and auto-detect models when possible.",
          modelPlaceholder: plugin.defaultModel,
        }
      : undefined,
  };
}

function resolveKnownModelName(
  plugin: ProviderPlugin,
  modelId: string,
): string | null {
  return (
    plugin.models.find((entry) => entry.id === modelId)?.name ??
    null
  );
}

function buildSelectedModelName(
  plugin: ProviderPlugin,
  modelId: string,
  discovered: boolean,
): string {
  if (discovered) {
    return plugin.formatDiscoveredName?.(modelId) ?? resolveKnownModelName(plugin, modelId) ?? `${modelId} (${plugin.name})`;
  }
  return resolveKnownModelName(plugin, modelId) ?? `${modelId} (${plugin.name})`;
}

export function providerSupportsDynamicCatalog(provider: string | null | undefined): boolean {
  return getProviderPlugin(provider)?.supportsModelDiscovery === true;
}

export function getProviderWizardMeta(
  provider: string | null | undefined,
): ProviderWizardMeta | null {
  const plugin = getProviderPlugin(provider);
  if (!plugin) return null;
  const defaults = buildDefaultWizardMeta(plugin);
  return {
    ...defaults,
    ...plugin.wizard,
    onboarding: {
      ...(defaults.onboarding ?? {}),
      ...(plugin.wizard?.onboarding ?? {}),
    },
    ...(defaults.modelPicker || plugin.wizard?.modelPicker
      ? {
          modelPicker: {
            ...(defaults.modelPicker ?? {}),
            ...(plugin.wizard?.modelPicker ?? {}),
          },
        }
      : {}),
  };
}

export function getProviderBaseUrlEnvKey(provider: string | null | undefined): string | null {
  return getProviderPlugin(provider)?.baseUrlEnvKey ?? null;
}

export function getProviderDiscoveryMode(
  provider: string | null | undefined,
): ProviderPlugin["discoveryMode"] | null {
  return getProviderPlugin(provider)?.discoveryMode ?? null;
}

export function providerRequiresApiKey(provider: string | null | undefined): boolean {
  return getProviderPlugin(provider)?.requiresApiKey !== false;
}

export function providerAllowsOptionalApiKey(
  provider: string | null | undefined,
): boolean {
  return getProviderPlugin(provider)?.allowsOptionalApiKey === true;
}

export function providerSupportsCredentialInput(
  provider: string | null | undefined,
): boolean {
  return (
    providerRequiresApiKey(provider) ||
    providerAllowsOptionalApiKey(provider)
  );
}

export function providerSupportsBaseUrlInput(provider: string | null | undefined): boolean {
  return Boolean(getProviderPlugin(provider)?.baseUrlEnvKey);
}

export function isProviderLocallyHosted(provider: string | null | undefined): boolean {
  const plugin = getProviderPlugin(provider);
  if (!plugin) return false;
  return plugin.requiresApiKey === false && Boolean(plugin.baseUrlEnvKey || plugin.baseUrl);
}

export function isOpenAICompatibleProvider(provider: ModelProvider): boolean {
  const transport = getProviderPlugin(provider)?.transport;
  return transport === "openai-chat" || transport === "openai-responses";
}

export async function discoverProviderModelIds(params: {
  provider: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}): Promise<string[]> {
  const plugin = getProviderPlugin(params.provider);
  if (!plugin?.discoverModelIds) {
    return [];
  }
  return plugin.discoverModelIds({
    provider: plugin.id,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  });
}

export async function resolveProviderModelSelection(params: {
  provider: string;
  requestedModelId?: string | null;
  requestedName?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}): Promise<ProviderModelSelectionResult> {
  const plugin = getProviderPlugin(params.provider);
  if (!plugin) {
    return {
      modelId: String(params.requestedModelId || "").trim(),
      name: String(params.requestedName || "").trim(),
      warnings: [],
      discovered: false,
    };
  }

  const requestedModelId = String(params.requestedModelId || "").trim();
  const requestedName = String(params.requestedName || "").trim();
  let discovered = false;
  let modelId = requestedModelId || plugin.defaultModel;
  let warnings: string[] = [];

  if (!requestedModelId && plugin.supportsModelDiscovery) {
    const discoveredIds = await discoverProviderModelIds({
      provider: plugin.id,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
    });
    if (discoveredIds.length > 0) {
      modelId = discoveredIds[0];
      discovered = true;
    }
  }

  if (plugin.afterModelSelected) {
    warnings = await plugin.afterModelSelected({
      provider: plugin.id,
      modelId,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      discovered,
    });
  }

  return {
    modelId,
    name: requestedName || buildSelectedModelName(plugin, modelId, discovered),
    warnings,
    discovered,
  };
}
