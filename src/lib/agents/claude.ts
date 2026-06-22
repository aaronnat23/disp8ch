import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@/lib/utils/logger";
import { buildAnthropicClient } from "@/lib/agents/anthropic-oauth";

const log = logger.child("claude");

export async function callClaude(options: {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ response: string; tokensUsed: number }> {
  const client = await buildAnthropicClient({ apiKey: options.apiKey });

  const response = await client.messages.create({
    model: options.model || "claude-sonnet-4-5",
    max_tokens: options.maxTokens || 1024,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userMessage }],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");

  const tokensUsed =
    (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  log.info("Claude response", { model: options.model, tokensUsed });

  return { response: text, tokensUsed };
}
