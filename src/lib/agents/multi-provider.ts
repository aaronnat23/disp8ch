import type { ModelProvider } from "@/types/model";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { logger } from "@/lib/utils/logger";
import { resolveModelAlias } from "@/lib/agents/model-aliases";
import { resolveProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { resolveAnthropicFastServiceTier, resolveOpenAIFastServiceTier } from "@/lib/agents/fast-mode";
import { resolveOpenAIRequestTimeoutMs } from "@/lib/agents/provider-timeouts";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";

const DEVELOPER_ROLE_MODELS = /^(gpt-5|codex|o\d)/i;

function systemRoleForModel(modelId: string): "system" | "developer" {
  return DEVELOPER_ROLE_MODELS.test(modelId) ? "developer" : "system";
}
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import { normalizeProviderScopedModelId, resolveProviderApiMode } from "@/lib/agents/provider-routing";
import { prepareAnthropicPromptCaching } from "@/lib/agents/anthropic-prompt-caching";
import { resolveSmartRoute } from "@/lib/agents/smart-routing";
import { getProviderRequiredHeaders, providerUsesOAuth } from "@/lib/agents/provider-auth-registry";
import { resolveProviderOAuthCredential } from "@/lib/agents/provider-oauth";
import { buildAnthropicClient } from "@/lib/agents/anthropic-oauth";

const log = logger.child("multi-provider");
function readAuthBaseUrl(auth: unknown): string | undefined {
  if (!auth || typeof auth !== "object") return undefined;
  const value = (auth as { baseUrl?: unknown }).baseUrl;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface CallModelOptions {
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  fastMode?: boolean;
  enableSmartRouting?: boolean;
  imageAttachments?: Array<{ mimeType: string; base64: string; name?: string }>;
}

export interface CallModelResult {
  response: string;
  /** Combined token count (tokensIn + tokensOut) kept for backwards compat */
  tokensUsed: number;
  /** Input / prompt tokens */
  tokensIn: number;
  /** Output / completion tokens */
  tokensOut: number;
  provider?: string;
  modelId?: string;
  routeLabel?: string | null;
}

type GeminiUsageLike = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
};

type OpenAIResponseUsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

function readGeminiUsage(usage?: GeminiUsageLike): { tokensIn: number; tokensOut: number; tokensUsed: number } {
  const tokensIn = usage?.promptTokenCount ?? 0;
  const tokensOut = usage?.candidatesTokenCount ?? usage?.responseTokenCount ?? 0;
  const tokensUsed = usage?.totalTokenCount ?? (tokensIn + tokensOut);
  return { tokensIn, tokensOut, tokensUsed };
}

function readOpenAIResponseUsage(
  usage?: OpenAIResponseUsageLike,
): { tokensIn: number; tokensOut: number; tokensUsed: number } {
  const tokensIn = usage?.input_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? 0;
  const tokensUsed = usage?.total_tokens ?? (tokensIn + tokensOut);
  return { tokensIn, tokensOut, tokensUsed };
}

function buildOpenAIResponsesInput(modelId: string, systemPrompt: string, userMessage: string): OpenAI.Responses.ResponseInput {
  return [
    {
      role: systemRoleForModel(modelId),
      content: systemPrompt,
    },
    {
      role: "user",
      content: userMessage,
    },
  ];
}

// ── Rate-limit detection ──────────────────────────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("too many requests")
  );
}

// ── Alternate API key loader for same-provider rotation ───────────────────────

async function loadProviderAltKeys(provider: string, currentKey: string): Promise<string[]> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const rows = db
      .prepare(
        "SELECT api_key FROM models WHERE provider = ? AND is_active = 1 ORDER BY priority DESC"
      )
      .all(provider) as { api_key: string }[];
    const resolved = rows
      .map((r) => resolveModelApiKey({ provider, storedApiKey: r.api_key }).apiKey)
      .filter((k) => k && k !== currentKey);
    return Array.from(new Set(resolved));
  } catch {
    return [];
  }
}

function applySmartRouting(
  options: CallModelOptions,
): { options: CallModelOptions; routeLabel: string | null } {
  if (options.enableSmartRouting !== true) {
    return { options, routeLabel: null };
  }
  const route = resolveSmartRoute({
    userMessage: options.userMessage,
    current: {
      provider: options.provider,
      modelId: options.modelId,
      apiKey: options.apiKey,
    },
  });
  if (!route) {
    return { options, routeLabel: null };
  }
  return {
    options: {
      ...options,
      provider: route.provider as ModelProvider,
      modelId: route.modelId,
      apiKey: route.apiKey,
      baseUrl: route.baseUrl ?? options.baseUrl,
      maxTokens: route.maxTokens ?? options.maxTokens,
      fastMode: route.fastMode,
    },
    routeLabel: route.routeLabel,
  };
}

// ── Public entry points (with alias resolution + key rotation) ────────────────

export async function callModel(options: CallModelOptions): Promise<CallModelResult> {
  const provider = normalizeProviderId(options.provider) ?? options.provider;
  const auth = providerUsesOAuth(provider)
    ? resolveProviderOAuthCredential(provider)
    : resolveModelApiKey({ provider, storedApiKey: options.apiKey });
  const resolvedBase = {
    ...options,
    provider: provider as ModelProvider,
    apiKey: auth.apiKey,
    baseUrl: options.baseUrl || readAuthBaseUrl(auth),
    modelId: resolveModelAlias(options.modelId),
  };
  const routed = applySmartRouting(resolvedBase);
  const resolved = routed.options;
  if (!resolved.apiKey && resolved.provider !== "anthropic" && providerRequiresApiKey(resolved.provider)) {
    throw new Error(`No API key resolved for provider: ${resolved.provider}`);
  }
  log.info("Calling model", { provider: resolved.provider, modelId: resolved.modelId });
  try {
    return await callModelInternal(resolved, routed.routeLabel);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    // 429 — try alternate API keys for same provider before giving up
    const altKeys = await loadProviderAltKeys(resolved.provider, resolved.apiKey);
    for (const altKey of altKeys) {
      try {
        return await callModelInternal({ ...resolved, apiKey: altKey }, routed.routeLabel);
      } catch (retryErr) {
        if (!isRateLimitError(retryErr)) throw retryErr;
      }
    }
    throw err;
  }
}

export async function streamModel(
  options: CallModelOptions,
  onToken: (token: string) => void
): Promise<CallModelResult> {
  const provider = normalizeProviderId(options.provider) ?? options.provider;
  const auth = providerUsesOAuth(provider)
    ? resolveProviderOAuthCredential(provider)
    : resolveModelApiKey({ provider, storedApiKey: options.apiKey });
  const resolvedBase = {
    ...options,
    provider: provider as ModelProvider,
    apiKey: auth.apiKey,
    baseUrl: options.baseUrl || readAuthBaseUrl(auth),
    modelId: resolveModelAlias(options.modelId),
  };
  const routed = applySmartRouting(resolvedBase);
  const resolved = routed.options;
  if (!resolved.apiKey && resolved.provider !== "anthropic" && providerRequiresApiKey(resolved.provider)) {
    throw new Error(`No API key resolved for provider: ${resolved.provider}`);
  }
  log.info("Streaming model", { provider: resolved.provider, modelId: resolved.modelId });
  try {
    return await streamModelInternal(resolved, onToken, routed.routeLabel);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    const altKeys = await loadProviderAltKeys(resolved.provider, resolved.apiKey);
    for (const altKey of altKeys) {
      try {
        return await streamModelInternal({ ...resolved, apiKey: altKey }, onToken, routed.routeLabel);
      } catch (retryErr) {
        if (!isRateLimitError(retryErr)) throw retryErr;
      }
    }
    throw err;
  }
}

// ── Internal dispatcher (no alias resolution, no key rotation) ────────────────

async function callModelInternal(
  options: CallModelOptions,
  routeLabel: string | null,
): Promise<CallModelResult> {
  const { provider, modelId, apiKey, baseUrl, systemPrompt, userMessage, maxTokens, temperature, fastMode, imageAttachments } = options;
  const images = imageAttachments?.length ? imageAttachments : undefined;
  const resolvedBaseUrl = resolveProviderBaseUrl(provider, baseUrl);
  const withMeta = async (
    promise: Promise<CallModelResult>,
    usedProvider = provider,
    usedModelId = modelId,
  ): Promise<CallModelResult> => ({
    ...(await promise),
    provider: usedProvider,
    modelId: usedModelId,
    routeLabel,
  });

  switch (provider) {
    case "anthropic":
      return withMeta(callAnthropic(modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images));

    case "openai":
    case "openai-compatible":
      if (resolveProviderApiMode(provider, modelId) === "openai-responses") {
        return withMeta(callOpenAIResponses(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature));
      }
      return withMeta(callOpenAI(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images));

    case "google":
    case "google-gemini-cli":
      return withMeta(callGemini(modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, temperature, images));

    case "opencode":
    case "opencode-go": {
      const apiMode = resolveProviderApiMode(provider, modelId);
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      if (apiMode === "anthropic") {
        return withMeta(callAnthropic(normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images), provider, normalizedModelId);
      }
      if (apiMode === "google") {
        return withMeta(callGemini(normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, temperature, images), provider, normalizedModelId);
      }
      if (apiMode === "openai-responses") {
        return withMeta(callOpenAIResponses(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature), provider, normalizedModelId);
      }
      return withMeta(callOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images), provider, normalizedModelId);
    }

    case "groq":
    case "together":
    case "openrouter":
    case "vllm":
    case "sglang":
    case "lmstudio":
    case "deepseek":
    case "mistral":
    case "zhipu":
    case "moonshot":
    case "xai":
      return withMeta(callOpenAI(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images));

    case "qwen": {
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      return withMeta(callOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images), provider, normalizedModelId);
    }
    case "qwen-oauth": {
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      return withMeta(callOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images), provider, normalizedModelId);
    }

    case "ollama":
      return withMeta(callOpenAI(provider, modelId, "", resolvedBaseUrl, systemPrompt, userMessage, maxTokens, fastMode, temperature, images));

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function streamModelInternal(
  options: CallModelOptions,
  onToken: (token: string) => void,
  routeLabel: string | null,
): Promise<CallModelResult> {
  const { provider, modelId, apiKey, baseUrl, systemPrompt, userMessage, maxTokens, temperature, fastMode, imageAttachments } = options;
  const images = imageAttachments?.length ? imageAttachments : undefined;
  const resolvedBaseUrl = resolveProviderBaseUrl(provider, baseUrl);
  const withMeta = async (
    promise: Promise<CallModelResult>,
    usedProvider = provider,
    usedModelId = modelId,
  ): Promise<CallModelResult> => ({
    ...(await promise),
    provider: usedProvider,
    modelId: usedModelId,
    routeLabel,
  });

  switch (provider) {
    case "anthropic":
      return withMeta(streamAnthropic(modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images));

    case "openai":
    case "openai-compatible":
      if (resolveProviderApiMode(provider, modelId) === "openai-responses") {
        return withMeta(streamOpenAIResponses(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature));
      }
      return withMeta(streamOpenAI(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images));

    case "google":
    case "google-gemini-cli":
      return withMeta(streamGemini(modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, temperature, images));

    case "opencode":
    case "opencode-go": {
      const apiMode = resolveProviderApiMode(provider, modelId);
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      if (apiMode === "anthropic") {
        return withMeta(streamAnthropic(normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images), provider, normalizedModelId);
      }
      if (apiMode === "google") {
        return withMeta(streamGemini(normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, temperature, images), provider, normalizedModelId);
      }
      if (apiMode === "openai-responses") {
        return withMeta(streamOpenAIResponses(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature), provider, normalizedModelId);
      }
      return withMeta(streamOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images), provider, normalizedModelId);
    }

    case "groq":
    case "together":
    case "openrouter":
    case "vllm":
    case "sglang":
    case "lmstudio":
    case "deepseek":
    case "mistral":
    case "zhipu":
    case "moonshot":
    case "xai":
      return withMeta(streamOpenAI(provider, modelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images));

    case "qwen": {
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      return withMeta(streamOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images), provider, normalizedModelId);
    }
    case "qwen-oauth": {
      const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
      return withMeta(streamOpenAI(provider, normalizedModelId, apiKey, resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images), provider, normalizedModelId);
    }

    case "ollama":
      return withMeta(streamOpenAI(provider, modelId, "", resolvedBaseUrl, systemPrompt, userMessage, maxTokens, onToken, fastMode, temperature, images));

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// ── Vision content builders ───────────────────────────────────────────────────

function buildAnthropicContent(message: string, images?: Array<{ mimeType: string; base64: string }>) {
  if (!images?.length) return message;
  return [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: img.base64 },
    })),
    { type: "text" as const, text: message },
  ];
}

function buildOpenAIContent(message: string, images?: Array<{ mimeType: string; base64: string }>) {
  if (!images?.length) return message;
  return [
    { type: "text" as const, text: message },
    ...images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

function getOpenAIChatExtraParams(provider: string, modelId: string): Record<string, unknown> {
  if (provider === "deepseek" && /^deepseek-v4-/i.test(modelId)) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

// ── Provider implementations ──────────────────────────────────────────────────

async function callAnthropic(
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  fastMode?: boolean,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const client = await buildAnthropicClient({ apiKey, baseURL });
  const serviceTier = resolveAnthropicFastServiceTier({ provider: "anthropic", baseUrl: baseURL, fastMode });
  const prepared = prepareAnthropicPromptCaching({
    systemPrompt,
    messages: [{ role: "user", content: buildAnthropicContent(userMessage, images) }],
  });
  const response = await client.messages.create({
    model: modelId || "claude-sonnet-4-5",
    max_tokens: maxTokens,
    system: prepared.system,
    messages: prepared.messages,
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");

  const tokensIn  = response.usage?.input_tokens  || 0;
  const tokensOut = response.usage?.output_tokens || 0;
  return { response: text, tokensIn, tokensOut, tokensUsed: tokensIn + tokensOut };
}

async function streamAnthropic(
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  onToken: (token: string) => void,
  fastMode?: boolean,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const client = await buildAnthropicClient({ apiKey, baseURL });
  let fullText = "";
  let tokensIn  = 0;
  let tokensOut = 0;

  const serviceTier = resolveAnthropicFastServiceTier({ provider: "anthropic", baseUrl: baseURL, fastMode });
  const prepared = prepareAnthropicPromptCaching({
    systemPrompt,
    messages: [{ role: "user", content: buildAnthropicContent(userMessage, images) }],
  });
  const stream = await client.messages.stream({
    model: modelId || "claude-sonnet-4-5",
    max_tokens: maxTokens,
    system: prepared.system,
    messages: prepared.messages,
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      const token = event.delta.text;
      fullText += token;
      onToken(token);
    }
    if (event.type === "message_start" && event.message?.usage) {
      tokensIn = event.message.usage.input_tokens || 0;
    }
    if (event.type === "message_delta" && event.usage) {
      tokensOut = event.usage.output_tokens || 0;
    }
  }

  return { response: fullText, tokensIn, tokensOut, tokensUsed: tokensIn + tokensOut };
}

async function callOpenAI(
  provider: string,
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  fastMode?: boolean,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
  const client = new OpenAI({
    apiKey: apiKey || "ollama",
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: getProviderRequiredHeaders(provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider, baseUrl: baseURL }),
    maxRetries: 1,
  });
  const serviceTier = resolveOpenAIFastServiceTier({ provider, baseUrl: baseURL, fastMode });

  const role = systemRoleForModel(normalizedModelId);

  const response = await client.chat.completions.create({
    model: normalizedModelId,
    max_tokens: maxTokens,
    messages: [
      { role, content: systemPrompt },
      { role: "user", content: buildOpenAIContent(userMessage, images) as string },
    ],
    ...getOpenAIChatExtraParams(provider, normalizedModelId),
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  });

  const text = response.choices[0]?.message?.content || "";
  const tokensIn  = response.usage?.prompt_tokens     || 0;
  const tokensOut = response.usage?.completion_tokens || 0;
  return { response: text, tokensIn, tokensOut, tokensUsed: tokensIn + tokensOut };
}

async function streamOpenAI(
  provider: string,
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  onToken: (token: string) => void,
  fastMode?: boolean,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const normalizedModelId = normalizeProviderScopedModelId(provider, modelId);
  const client = new OpenAI({
    apiKey: apiKey || "ollama",
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: getProviderRequiredHeaders(provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider, baseUrl: baseURL }),
    maxRetries: 1,
  });
  const serviceTier = resolveOpenAIFastServiceTier({ provider, baseUrl: baseURL, fastMode });

  let fullText = "";
  let tokensIn  = 0;
  let tokensOut = 0;

  const role = systemRoleForModel(normalizedModelId);

  const stream = await client.chat.completions.create({
    model: normalizedModelId,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role, content: systemPrompt },
      { role: "user", content: buildOpenAIContent(userMessage, images) as string },
    ],
    ...getOpenAIChatExtraParams(provider, normalizedModelId),
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || "";
    if (token) {
      fullText += token;
      onToken(token);
    }
    if (chunk.usage) {
      tokensIn  = chunk.usage.prompt_tokens     || 0;
      tokensOut = chunk.usage.completion_tokens || 0;
    }
  }

  return { response: fullText, tokensIn, tokensOut, tokensUsed: tokensIn + tokensOut };
}

async function callGemini(
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const ai = new GoogleGenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  const contents = images?.length
    ? { parts: [...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })), { text: userMessage }] }
    : userMessage;
  const response = await ai.models.generateContent({
    model: modelId || "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
    },
  });

  const text = response.text ?? "";
  const { tokensIn, tokensOut, tokensUsed } = readGeminiUsage(response.usageMetadata);
  return { response: text, tokensIn, tokensOut, tokensUsed };
}

async function streamGemini(
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  onToken: (token: string) => void,
  temperature?: number,
  images?: Array<{ mimeType: string; base64: string }>,
): Promise<CallModelResult> {
  const ai = new GoogleGenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  let fullText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensUsed = 0;
  const contents = images?.length
    ? { parts: [...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })), { text: userMessage }] }
    : userMessage;
  const stream = await ai.models.generateContentStream({
    model: modelId || "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
    },
  });

  for await (const chunk of stream) {
    const token = chunk.text ?? "";
    if (token) {
      fullText += token;
      onToken(token);
    }
    if (chunk.usageMetadata) {
      const usage = readGeminiUsage(chunk.usageMetadata);
      tokensIn = usage.tokensIn || tokensIn;
      tokensOut = usage.tokensOut || tokensOut;
      tokensUsed = usage.tokensUsed || tokensUsed;
    }
  }

  return { response: fullText, tokensIn, tokensOut, tokensUsed: tokensUsed || (tokensIn + tokensOut) };
}

async function callOpenAIResponses(
  provider: string,
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  fastMode?: boolean,
  temperature?: number,
): Promise<CallModelResult> {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: getProviderRequiredHeaders(provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider, baseUrl: baseURL }),
    maxRetries: 1,
  });
  const serviceTier = resolveOpenAIFastServiceTier({ provider, baseUrl: baseURL, fastMode });
  const request: Record<string, unknown> = {
    model: modelId,
    input: buildOpenAIResponsesInput(modelId, systemPrompt, userMessage),
    max_output_tokens: maxTokens,
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  };

  const response = await client.responses.create(request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming);

  const text = response.output_text ?? "";
  const { tokensIn, tokensOut, tokensUsed } = readOpenAIResponseUsage(response.usage);
  return { response: text, tokensIn, tokensOut, tokensUsed };
}

async function streamOpenAIResponses(
  provider: string,
  modelId: string,
  apiKey: string,
  baseURL: string | undefined,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  onToken: (token: string) => void,
  fastMode?: boolean,
  temperature?: number,
): Promise<CallModelResult> {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: getProviderRequiredHeaders(provider),
    timeout: resolveOpenAIRequestTimeoutMs({ provider, baseUrl: baseURL }),
    maxRetries: 1,
  });
  const serviceTier = resolveOpenAIFastServiceTier({ provider, baseUrl: baseURL, fastMode });

  let fullText = "";
  let usage: OpenAIResponseUsageLike | undefined;
  const request: Record<string, unknown> = {
    model: modelId,
    input: buildOpenAIResponsesInput(modelId, systemPrompt, userMessage),
    max_output_tokens: maxTokens,
    stream: true,
    ...(temperature != null ? { temperature } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  };

  const stream = await client.responses.create(request as unknown as OpenAI.Responses.ResponseCreateParamsStreaming);

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      fullText += event.delta;
      onToken(event.delta);
      continue;
    }
    if (event.type === "response.completed") {
      usage = event.response.usage;
    }
  }

  const { tokensIn, tokensOut, tokensUsed } = readOpenAIResponseUsage(usage);
  return { response: fullText, tokensIn, tokensOut, tokensUsed };
}
