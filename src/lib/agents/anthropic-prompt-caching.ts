import type Anthropic from "@anthropic-ai/sdk";
import { loadModelRuntimeConfig } from "@/lib/agents/model-runtime-config";

type CacheMarker = { type: "ephemeral" };

function cloneMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return JSON.parse(JSON.stringify(messages)) as Anthropic.MessageParam[];
}

function applyMarkerToMessage(
  message: Anthropic.MessageParam,
  marker: CacheMarker,
): Anthropic.MessageParam {
  const next = message as Anthropic.MessageParam & { content: unknown; cache_control?: CacheMarker };
  if (typeof next.content === "string") {
    next.content = [{ type: "text", text: next.content, cache_control: marker }];
    return next;
  }
  if (Array.isArray(next.content) && next.content.length > 0) {
    const last = next.content[next.content.length - 1] as unknown as Record<string, unknown>;
    if (last && typeof last === "object") {
      last.cache_control = marker;
    }
    return next;
  }
  next.cache_control = marker;
  return next;
}

export function prepareAnthropicPromptCaching(params: {
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
}): {
  system: string | Array<{ type: "text"; text: string; cache_control?: CacheMarker }>;
  messages: Anthropic.MessageParam[];
} {
  const config = loadModelRuntimeConfig();
  if (!config.anthropicPromptCachingEnabled) {
    return {
      system: params.systemPrompt,
      messages: params.messages,
    };
  }

  const marker: CacheMarker = { type: "ephemeral" };
  const clonedMessages = cloneMessages(params.messages);
  const nonEmptyIndexes = clonedMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.content !== undefined && message.content !== null)
    .map(({ index }) => index);

  for (const index of nonEmptyIndexes.slice(-3)) {
    clonedMessages[index] = applyMarkerToMessage(clonedMessages[index], marker);
  }

  return {
    system: [{ type: "text", text: params.systemPrompt, cache_control: marker }],
    messages: clonedMessages,
  };
}
