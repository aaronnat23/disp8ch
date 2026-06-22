import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { compactAnthropicMessages, compactOpenAIMessages } from "./compaction";
import { loadContextPolicy } from "./policy";
import { pruneAnthropicMessages, pruneOpenAIMessages } from "./pruning";
import type { CompactOpts, ContextEngine, ContextPreparationResult } from "./types";

class DefaultContextEngine implements ContextEngine {
  async prepareAnthropic(
    messages: Anthropic.MessageParam[],
    opts: CompactOpts,
  ): Promise<ContextPreparationResult<Anthropic.MessageParam>> {
    const policy = await loadContextPolicy(opts.modelId);
    const pruned = pruneAnthropicMessages(messages, policy.pruning);
    const compacted = await compactAnthropicMessages(pruned.messages, policy.compaction, opts);
    return {
      messages: compacted.messages,
      pruned: pruned.pruned,
      compacted: compacted.compacted,
      compactionFeedback: compacted.compactionFeedback ?? null,
    };
  }

  async prepareOpenAI(
    messages: OpenAI.ChatCompletionMessageParam[],
    opts: CompactOpts,
  ): Promise<ContextPreparationResult<OpenAI.ChatCompletionMessageParam>> {
    const policy = await loadContextPolicy(opts.modelId);
    const pruned = pruneOpenAIMessages(messages, policy.pruning);
    const compacted = await compactOpenAIMessages(pruned.messages, policy.compaction, opts);
    return {
      messages: compacted.messages,
      pruned: pruned.pruned,
      compacted: compacted.compacted,
      compactionFeedback: compacted.compactionFeedback ?? null,
    };
  }
}

const ENGINE = new DefaultContextEngine();

export function getContextEngine(): ContextEngine {
  return ENGINE;
}
