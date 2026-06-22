export type NormalizedToolCall = {
  id: string;
  name: string;
  argumentsText: string;
  providerData?: Record<string, unknown>;
};

export type NormalizedProviderResponse = {
  content: string;
  toolCalls: NormalizedToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  reasoning?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  providerData?: Record<string, unknown>;
};

export type ProviderTransport = {
  name: string;
  isAvailable(): boolean;
  convertMessages(messages: Array<{ role: string; content: string }>): unknown;
  convertTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): unknown;
  buildRequestParams(prompt: string, maxTokens: number, temperature?: number): Record<string, unknown>;
  normalizeResponse(rawResponse: unknown): NormalizedProviderResponse;
  normalizeStreamChunk?(chunk: unknown): { text?: string; toolCall?: NormalizedToolCall } | null;
  mapFinishReason(reason: string): NormalizedProviderResponse["finishReason"];
  extractCacheStats?(response: unknown): { cachedInputTokens?: number } | null;
};

export type ProviderTimeoutPolicy = {
  requestTimeoutMs: number;
  streamingTimeoutMs: number;
  toolExecutionTimeoutMs: number;
  maxRetries: number;
};

export const DEFAULT_PROVIDER_TIMEOUT: ProviderTimeoutPolicy = {
  requestTimeoutMs: 120_000,
  streamingTimeoutMs: 300_000,
  toolExecutionTimeoutMs: 60_000,
  maxRetries: 1,
};

export const LOCAL_PROVIDER_TIMEOUT: ProviderTimeoutPolicy = {
  requestTimeoutMs: 600_000,
  streamingTimeoutMs: 900_000,
  toolExecutionTimeoutMs: 120_000,
  maxRetries: 1,
};
