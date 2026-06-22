import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type ContextCompactionMode = "off" | "summarize" | "drop";
export type ContextPruningMode = "off" | "tool-results";
export type ContextCompactionIdentifierPolicy = "strict" | "off" | "custom";

export interface CompactionPolicy {
  mode: ContextCompactionMode;
  threshold: number;
  contextWindow: number;
  memoryFlushEnabled: boolean;
  memoryFlushSoftThresholdTokens: number;
  keepRecentTokens: number;
  reserveTokensFloor: number;
  summaryModelRef: string | null;
  identifierPolicy: ContextCompactionIdentifierPolicy;
  identifierInstructions: string | null;
  qualityGuardEnabled: boolean;
  qualityGuardMaxRetries: number;
}

export interface PruningPolicy {
  mode: ContextPruningMode;
  keepRecentAssistants: number;
  minToolChars: number;
  maxToolChars: number;
  headChars: number;
  tailChars: number;
}

export interface ContextPolicy {
  compaction: CompactionPolicy;
  pruning: PruningPolicy;
}

export interface CompactOpts {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
  fastMode?: boolean;
  agentId?: string;
  sessionId?: string;
}

export interface CompactionFeedback {
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  compressionRatio: string;
}

export interface ContextPreparationResult<T> {
  messages: T[];
  pruned: boolean;
  compacted: boolean;
  compactionFeedback?: CompactionFeedback | null;
}

export interface ContextEngine {
  prepareAnthropic(
    messages: Anthropic.MessageParam[],
    opts: CompactOpts,
  ): Promise<ContextPreparationResult<Anthropic.MessageParam>>;
  prepareOpenAI(
    messages: OpenAI.ChatCompletionMessageParam[],
    opts: CompactOpts,
  ): Promise<ContextPreparationResult<OpenAI.ChatCompletionMessageParam>>;
}
